// 自定义工具（插件）加载器：把 data/tools/<插件目录>/ 下的用户工具接进 agent 工具循环。
//
// 目录结构（每个插件一个子目录）：
//   data/tools/<folder>/
//     tool.json    —— 清单：name / description / parameters / enabled / timeoutMs ...
//     handler.js   —— 处理函数：export default async (ctx, args, helpers) => ...
//
// ⚠️ 安全声明：handler.js 在主进程里以 ESM 直接执行，拥有本机完整 Node 能力
//    （读写文件、发网络请求、起子进程……）。只放你自己信任的插件 ——
//    与任何插件系统一样，代码即权限。工具名与内置工具重名会被拒绝加载。
//
// 设计要点：
//   - 缓存按「清单 mtime + 处理函数 mtime」失效：改完文件下次运行即生效，无需重启；
//   - 任何单个插件的加载/执行失败都只影响它自己，绝不拖垮 agent 运行；
//   - 只做"加载 + 校验 + 超时包裹"，执行语义完全交给插件作者。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_DIR, getConfig } from "./config.js";
import { buildToolDefs } from "./tools.js";

/** 插件目录：跟着数据目录走（便携/测试重定向时自动跟随）。 */
export function customToolsDir() {
  return path.join(DATA_DIR, "tools");
}

// 工具名限制：小写字母开头，只含小写字母/数字/下划线。
// 与内置工具的命名风格一致（send_message 这类），也避免大小写造成的模型混淆。
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
const DESC_MAX = 4000;
const MANIFEST_FILE = "tool.json";
const HANDLER_FILE = "handler.js";

/** 内置工具名集合（懒加载一次）：用于拒绝重名插件。 */
let builtinNames = null;
function getBuiltinNames() {
  if (!builtinNames) builtinNames = new Set(buildToolDefs().map((d) => d.name));
  return builtinNames;
}

// 缓存：绝对路径 -> { manifestMtimeMs, handlerMtimeMs, def, manifest, error }
// 命中条件是两个 mtime 都没变；改文件即自动重载。
const cache = new Map();

// 模块 URL 版本号：每次显式重载递增。
// 只靠 mtime 有个坑——同一毫秒内改文件（写文件后立刻重载）mtime 不变，
// import 的 URL 会命中 ESM 模块缓存，拿到的还是旧代码。带上递增号就一定换新 URL。
let generation = 0;

function statMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function readJson(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

/**
 * 校验清单中「与本次扫描无关」的部分。返回错误字符串数组（空数组 = 通过）。
 * 只拦截"会让工具循环出问题"的硬伤，其余（版本/作者等）不做要求。
 * 注意：与「其他自定义工具重名」依赖本次扫描顺序，不在这里判定（见 loadPlugin）。
 */
function validateManifest(manifest, folderName) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["清单必须是 JSON 对象"];
  }
  const name = String(manifest.name ?? "").trim();
  if (!name) errors.push("缺少 name");
  else if (!TOOL_NAME_RE.test(name))
    errors.push(
      `name「${name}」不合法：需以小写字母开头，只含小写字母/数字/下划线，长度 2~64`,
    );
  else if (getBuiltinNames().has(name))
    errors.push(`name「${name}」与内置工具重名，请换一个`);

  const description = String(manifest.description ?? "").trim();
  if (!description) errors.push("缺少 description（模型靠它判断何时调用）");
  else if (description.length > DESC_MAX)
    errors.push(`description 过长（${description.length} > ${DESC_MAX} 字符）`);

  const params = manifest.parameters;
  if (params !== undefined && params !== null) {
    if (typeof params !== "object" || Array.isArray(params))
      errors.push("parameters 必须是 JSON Schema 对象");
    else if (params.type && params.type !== "object")
      errors.push('parameters.type 只能是 "object"（工具参数必须是对象）');
  }
  if (manifest.timeoutMs !== undefined && !(Number(manifest.timeoutMs) > 0)) {
    errors.push("timeoutMs 必须是正数（毫秒）");
  }
  if (!folderName) errors.push("缺少插件目录名");
  return errors;
}

function normalizeParameters(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { type: "object", properties: {} };
  }
  const out = { ...raw, type: "object" };
  if (!out.properties || typeof out.properties !== "object")
    out.properties = {};
  return out;
}

function helpersFor(def) {
  return {
    /** 返回成功结果（字符串直接作为文本；对象会被 JSON 化）。 */
    ok: (payload) => ({
      content:
        typeof payload === "string"
          ? payload
          : JSON.stringify(payload, null, 1),
    }),
    /** 返回错误结果（模型会看到"错误：…"，并可能自行纠正重试）。 */
    err: (message) => ({
      content: `错误：${String(message ?? "")}`,
      isError: true,
    }),
    name: def.name,
  };
}

/** 把插件返回值规整成工具循环认识的 { content, isError }。 */
function normalizeResult(result) {
  if (result === undefined || result === null)
    return { content: JSON.stringify({ ok: true }) };
  if (typeof result === "string") return { content: result };
  if (Array.isArray(result)) return { content: result }; // 允许返回 parts 数组
  if (typeof result === "object") {
    if (typeof result.content === "string" || Array.isArray(result.content)) {
      return { content: result.content, isError: !!result.isError };
    }
    return { content: JSON.stringify(result, null, 1) };
  }
  return { content: String(result) };
}

/** 加载单个插件目录；任何异常都收敛成 error 字段，不向外抛。 */
function loadPlugin(folderName, seenNames) {
  const dir = path.join(customToolsDir(), folderName);
  const manifestPath = path.join(dir, MANIFEST_FILE);
  const handlerPath = path.join(dir, HANDLER_FILE);

  const manifestMtimeMs = statMs(manifestPath);
  if (manifestMtimeMs === null) {
    return { folder: folderName, dir, error: `缺少 ${MANIFEST_FILE}` };
  }
  const handlerMtimeMs = statMs(handlerPath);
  if (handlerMtimeMs === null) {
    return { folder: folderName, dir, error: `缺少 ${HANDLER_FILE}` };
  }

  const cached = cache.get(handlerPath);
  if (
    cached &&
    cached.manifestMtimeMs === manifestMtimeMs &&
    cached.handlerMtimeMs === handlerMtimeMs
  ) {
    // 命中缓存：本地错误（清单/语法）是稳定结论，直接返回；
    // 重名判定依赖本次扫描的其他插件，必须重新算（删掉冲突方后应能自动恢复）。
    if (cached.error) return cached;
    const cachedName = cached.def?.name;
    if (cachedName && seenNames.has(cachedName)) {
      return {
        folder: folderName,
        dir,
        manifest: cached.manifest,
        name: cachedName,
        error: `name「${cachedName}」与另一个自定义工具重名`,
      };
    }
    if (cachedName) seenNames.add(cachedName);
    return cached;
  }

  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    const entry = {
      folder: folderName,
      dir,
      error: `${MANIFEST_FILE} 解析失败：${error?.message ?? error}`,
    };
    cache.set(handlerPath, { ...entry, manifestMtimeMs, handlerMtimeMs });
    return entry;
  }

  const errors = validateManifest(manifest, folderName);
  if (errors.length) {
    const entry = {
      folder: folderName,
      dir,
      manifest,
      error: errors.join("；"),
    };
    cache.set(handlerPath, { ...entry, manifestMtimeMs, handlerMtimeMs });
    return entry;
  }

  const name = String(manifest.name).trim();
  const description = String(manifest.description).trim();
  const parameters = normalizeParameters(manifest.parameters);

  // 重名不入缓存：删掉冲突方后应能自动恢复，不该被旧的失败结论卡住。
  if (seenNames.has(name)) {
    return {
      folder: folderName,
      dir,
      manifest,
      name,
      error: `name「${name}」与另一个自定义工具重名`,
    };
  }
  seenNames.add(name);

  async function execute(ctx, args) {
    const mod = await importHandler();
    const fn = mod.execute || mod.default;
    const helpers = helpersFor({ name });
    const cfgTimeout = Number(getConfig().customTools?.timeoutMs) || 20000;
    const timeoutMs =
      Number(manifest.timeoutMs) > 0 ? Number(manifest.timeoutMs) : cfgTimeout;
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve(fn(ctx, args ?? {}, helpers)),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`自定义工具 ${name} 执行超时（${timeoutMs}ms）`),
              ),
            timeoutMs,
          );
          // 超时不应阻止进程退出
          if (typeof timer?.unref === "function") timer.unref();
        }),
      ]);
      return normalizeResult(result);
    } finally {
      clearTimeout(timer);
    }
  }

  let handlerMod = null;
  let handlerError = null;
  async function importHandler() {
    if (handlerMod) return handlerMod;
    if (handlerError) throw handlerError;
    try {
      // 带 mtime + 重载代次查询串：绕开 ESM 模块缓存，实现"改完即生效"
      handlerMod = await import(
        `${pathToFileURL(handlerPath).href}?v=${handlerMtimeMs}.${generation}`
      );
      if (typeof (handlerMod.execute || handlerMod.default) !== "function") {
        throw new Error(
          `${HANDLER_FILE} 必须导出函数（export default 或 export function execute）`,
        );
      }
      return handlerMod;
    } catch (error) {
      handlerError = error;
      throw error;
    }
  }

  // 语法/导出检查：加载期就 import 一次，把错误提前暴露到管理页，而不是等模型调用时才炸。
  return importHandler()
    .then(() => {
      const def = {
        name,
        description,
        parameters,
        execute,
        custom: true,
        folder: folderName,
        // 与内置工具一致的可选门控：缺视觉/关搜索时由编排器过滤掉
        requiresVision: manifest.requiresVision === true,
        requiresSearch: manifest.requiresSearch === true,
      };
      const entry = {
        folder: folderName,
        dir,
        manifest,
        def,
        name,
        description,
      };
      cache.set(handlerPath, { ...entry, manifestMtimeMs, handlerMtimeMs });
      return entry;
    })
    .catch((error) => {
      const entry = {
        folder: folderName,
        dir,
        manifest,
        error: `加载 ${HANDLER_FILE} 失败：${error?.message ?? error}`,
      };
      cache.set(handlerPath, { ...entry, manifestMtimeMs, handlerMtimeMs });
      return entry;
    });
}

/**
 * 扫描并加载全部插件。
 * @returns {Promise<{dir:string, enabled:boolean, tools:Array, errors:Array}>}
 */
export async function listCustomTools() {
  const cfg = getConfig();
  const enabled = cfg.customTools?.enabled !== false;
  const disabled = new Set((cfg.customTools?.disabled ?? []).map(String));
  const dir = customToolsDir();

  let folders = [];
  try {
    folders = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return { dir, enabled, tools: [], errors: [] }; // 目录不存在 = 没有插件
  }

  const seenNames = new Set();
  const tools = [];
  const errors = [];
  for (const folder of folders) {
    const entry = await loadPlugin(folder, seenNames);
    if (entry.error) {
      errors.push({
        folder: entry.folder,
        name: entry.name || entry.manifest?.name || "",
        dir: entry.dir,
        error: entry.error,
      });
      continue;
    }
    tools.push({
      folder: entry.folder,
      dir: entry.dir,
      name: entry.def.name,
      description: entry.description,
      parameters: entry.def.parameters,
      enabled:
        enabled &&
        entry.manifest.enabled !== false &&
        !disabled.has(entry.def.name),
      manifestEnabled: entry.manifest.enabled !== false,
      customDisabled: disabled.has(entry.def.name),
      timeoutMs:
        Number(entry.manifest.timeoutMs) > 0
          ? Number(entry.manifest.timeoutMs)
          : Number(cfg.customTools?.timeoutMs) || 20000,
      requiresVision: entry.manifest.requiresVision === true,
      requiresSearch: entry.manifest.requiresSearch === true,
      version: entry.manifest.version ? String(entry.manifest.version) : "",
      author: entry.manifest.author ? String(entry.manifest.author) : "",
    });
  }
  return { dir, enabled, tools, errors };
}

/**
 * 给工具循环用的：只返回"启用且加载成功"的工具定义。
 * 全局关闭 / 单个禁用 / 加载失败 都会被挡在这里。
 */
export async function loadCustomToolDefs() {
  const { enabled, tools } = await listCustomTools();
  if (!enabled) return [];
  const wanted = new Set(tools.filter((t) => t.enabled).map((t) => t.name));
  if (!wanted.size) return [];
  // listCustomTools 已把结果写进 cache；这里按缓存取回真正的 def（含 execute）。
  const out = [];
  for (const entry of cache.values()) {
    if (entry.def && wanted.has(entry.def.name)) out.push(entry.def);
  }
  return out;
}

/** 清空缓存并重新扫描（管理页「重新加载」按钮）。 */
export async function reloadCustomTools() {
  generation += 1;
  cache.clear();
  return listCustomTools();
}

/** 生成一个示例插件（仅当目录不存在时创建，不覆盖用户文件）。 */
export function scaffoldExampleTool() {
  const dir = path.join(customToolsDir(), "example_echo");
  if (fs.existsSync(path.join(dir, MANIFEST_FILE))) {
    return {
      ok: false,
      dir,
      error: "示例插件已存在（如需重来请先删除该目录）",
    };
  }
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    name: "example_echo",
    description:
      "示例插件：把传入的 text 原样返回。用它验证自定义工具链路是否打通，验证完可以删掉这个目录。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要让工具原样返回的内容" },
      },
      required: ["text"],
    },
    enabled: true,
    version: "1.0.0",
    author: "你",
  };
  fs.writeFileSync(
    path.join(dir, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(dir, HANDLER_FILE), EXAMPLE_HANDLER, "utf8");
  generation += 1;
  cache.clear();
  return { ok: true, dir };
}

// 示例 handler：演示参数读取、helpers.ok/err、以及"能拿到当前会话 ctx"。
const EXAMPLE_HANDLER = `// 自定义工具示例。ctx 与内置工具完全一致：
//   ctx.chatKey / ctx.kind / ctx.chatId / ctx.selfId / ctx.store / ctx.memory
//   ctx.stickers / ctx.sender / ctx.session / ctx.emit / ctx.botName ...
// helpers 提供 ok(payload) / err(message) 两个快捷构造器。
// 返回字符串、{ content, isError }、或任意对象（会被 JSON 化）都可以。
export default async function execute(ctx, args, helpers) {
  const text = String(args.text ?? '');
  if (!text) return helpers.err('text 不能为空');
  return helpers.ok({
    echo: text,
    chat: ctx.chatKey,
    at: new Date().toISOString()
  });
}
`;
