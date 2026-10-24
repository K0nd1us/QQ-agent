// 全量工具与 Skill 审查。
//
// 与 skill-test.mjs 的分工：
//   skill-test.mjs      —— 验证**架构机制**（钩子、能力、开关、降级、热重载）
//   tools-skill-audit   —— 验证**每一项注册内容本身是否自洽**
//
// 后者的价值在于：架构对了不代表每个工具/技能都写对了。
// 这个文件逐个检查"声明与实现是否一致"，例如：
//   · 技能声明了能力 X，但代码里根本没实现 X → 调用方拿到空列表，静默失效
//   · 工具声明 requires:['web_fetch']，但没有任何技能提供这个能力 → 工具永远不可用
//   · 工具的 parameters 不是合法 JSON Schema → 模型收到无法理解的工具定义
//   · 两个技能抢同一个能力名 → 谁生效取决于加载顺序，不确定
// 这些都是"不报错但功能失灵"的问题，正是最该被自动化抓住的一类。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

// ⚠️ 一切路径都以**脚本自身位置**为锚点，不能用 process.cwd()。
// 原来有几处写的是裸相对路径（'src/config.js'、'skills/xxx'），从项目根目录
// 跑 npm script 时碰巧能过，换个工作目录直接 ENOENT 崩掉 —— 表现为
// "审查脚本自己出错"，让人以为是代码有问题。
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relOf = (p) => path.relative(APP_ROOT, p).replace(/\\/g, '/');

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-audit-'));

let pass = 0;
let fail = 0;
const failures = [];
function ok(msg) { pass += 1; console.log(`  ✓ ${msg}`); }
function bad(msg, detail) {
  fail += 1;
  failures.push(msg);
  console.log(`  ✗ ${msg}`);
  if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`);
}
function check(cond, msg, detail) { if (cond) ok(msg); else bad(msg, detail); }

// 合法技能分类（技能有自己的一套：按"它管什么"分，而不是按工具语义分）
const VALID_SKILL_CATEGORIES = ['model', 'message', 'media', 'knowledge', 'utility', 'web'];
// 工具分类**不硬编码** —— 以 tool-registry 的 CATEGORY_META 为唯一事实来源。
// 硬编码一份清单的问题是：注册表加了分类，测试还按老清单判，或者反过来。
let VALID_TOOL_CATEGORIES = [];

async function main() {
  const { loadPlugins } = await import('../src/plugin-loader.js');
  const { skillManager } = await import('../src/skills/manager.js');
  const { buildToolDefs } = await import('../src/tools.js');
  const { getToolAvailability, listCategories, CATEGORY_META, listTools } = await import('../src/tool-registry.js');
  const { getConfig } = await import('../src/config.js');

  const loaded = await loadPlugins({ log: () => {} });
  const toolDefs = buildToolDefs();
  VALID_TOOL_CATEGORIES = Object.keys(CATEGORY_META);
  const cfg = getConfig();

  console.log('\n=== 一、加载健康 ===');
  check(loaded.failed.length === 0, `所有 Skill 加载成功（${loaded.loaded.length} 个）`,
    loaded.failed.map((f) => `${f.id}: ${f.error}`).join('\n'));
  if (loaded.failed.length) {
    console.log('\n加载失败会直接导致下面的检查失去意义，先修它们。');
    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    process.exit(1);
  }

  const skills = skillManager.list();
  const { MULTI_PROVIDER_CAPABILITIES } = await import('../src/skills/manager.js');
  check(skills.length === loaded.loaded.length, `技能列表与加载数一致（${skills.length}）`);

  // ══ 二、每个 Skill 清单自洽 ══════════════════════════════════════════
  console.log('\n=== 二、Skill 清单自洽 ===');
  const capOwners = new Map();     // 能力名 -> [skillId]
  const allCapNames = new Set();

  for (const s of skills) {
    const problems = [];
    if (!s.id || !/^[a-z0-9][a-z0-9-]*$/i.test(s.id)) problems.push(`id 不合规：${s.id}`);
    if (!['skill', 'plugin'].includes(s.source)) problems.push(`source 非法：${s.source}`);
    if (!s.name) problems.push('缺 name');
    if (!s.version) problems.push('缺 version');
    if (s.apiVersion !== 1) problems.push(`apiVersion 应为 1，实际 ${s.apiVersion}`);
    if (!VALID_SKILL_CATEGORIES.includes(s.category)) problems.push(`category 非法：${s.category}`);
    if (!s.description) problems.push('缺 description');

    if (problems.length) bad(`Skill ${s.id} 清单有问题`, problems.join('\n'));
    else ok(`Skill ${s.id} 清单完整`);

    for (const c of s.capabilities || []) {
      allCapNames.add(c);
      if (!capOwners.has(c)) capOwners.set(c, []);
      capOwners.get(c).push(s.id);
    }
  }

  // 能力名冲突：两个技能提供同一能力 → 谁生效取决于加载顺序
  const realConflicts = [...capOwners.entries()]
    .filter(([cap, owners]) => owners.length > 1 && !MULTI_PROVIDER_CAPABILITIES.has(cap));
  for (const [cap, owners] of realConflicts) {
    bad(`单提供者能力被多个技能提供：${cap}`, owners.join('、') + '\n（谁生效取决于加载顺序，行为不确定）');
  }
  if (!realConflicts.length) {
    const multi = [...capOwners.entries()].filter(([cap, o]) => o.length > 1).map(([c]) => c);
    ok(`能力名无冲突（共 ${capOwners.size} 个能力${multi.length ? `；多提供者：${multi.join('、')}` : ''}）`);
  }

  // ══ 三、声明的能力是否真的实现了 ═══════════════════════════════════
  console.log('\n=== 三、声明 vs 实现 ===');
  let declaredButMissing = [];
  let implementedButUndeclared = [];
  for (const s of skills) {
    const declared = new Set(s.capabilities || []);
    const implemented = new Set(s.implementedCapabilities || []);
    for (const c of declared) if (!implemented.has(c)) declaredButMissing.push(`${s.id}: 声明了 ${c} 但没实现`);
    for (const c of implemented) if (!declared.has(c)) implementedButUndeclared.push(`${s.id}: 实现了 ${c} 但清单没声明`);
  }
  check(declaredButMissing.length === 0,
    '每个声明的能力都有对应实现（否则调用方拿到空列表、静默失效）',
    declaredButMissing.join('\n'));
  check(implementedButUndeclared.length === 0,
    '每个实现的能力都在清单里声明了（否则用户看不出它提供什么）',
    implementedButUndeclared.join('\n'));

  // 能力名格式：小写点分，便于阅读与检索
  const badCapNames = [...allCapNames].filter((c) => !/^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/.test(c));
  check(badCapNames.length === 0, '能力名都是「小写点分」格式', badCapNames.join('\n'));

  // ══ 四、available() 必须同步 ════════════════════════════════════════
  console.log('\n=== 四、可用性自检同步性 ===');
  const asyncAvail = [];
  for (const s of skills) {
    try {
      // 用状态视图里的**真实目录**（s.dir），不靠清单文件名反推 ——
      // 文件名与目录语义是两件事，反推会在改名/挪目录后静默指错地方。
      if (!s.dir) continue;
      const mod = await import(new URL(`../${s.dir}/index.js`, import.meta.url).href);
      if (typeof mod.available === 'function') {
        const r = mod.available({});
        if (r instanceof Promise) asyncAvail.push(`${s.id}.available() 返回了 Promise`);
      }
    } catch {
      // 加载器支持插件目录下不同的入口名，这里 import 失败不代表技能有问题，跳过
    }
  }
  check(asyncAvail.length === 0,
    '所有 available() 同步返回（返回 Promise 会被当成"可用"，导致界面与实际不符）',
    asyncAvail.join('\n'));

  // ══ 五、工具定义自洽 ════════════════════════════════════════════════
  console.log('\n=== 五、工具定义自洽 ===');
  const ids = new Set();
  const dupes = [];
  const brokenTools = [];
  for (const t of toolDefs) {
    const p = [];
    if (!t.id) p.push('缺 id');
    if (!t.name) p.push('缺 name');
    if (!t.description) p.push('缺 description');
    if (typeof t.execute !== 'function') p.push('execute 不是函数');
    if (!VALID_TOOL_CATEGORIES.includes(t.category)) p.push(`category 非法：${t.category}`);
    if (t.parameters) {
      if (t.parameters.type !== 'object') p.push('parameters.type 必须是 object');
      if (typeof t.parameters.properties !== 'object' || t.parameters.properties === null) {
        p.push('parameters.properties 必须是对象');
      } else {
        // 每个属性的 type 必须是合法 JSON Schema 类型（字符串或字符串数组）
        for (const [k, v] of Object.entries(t.parameters.properties)) {
          if (!v || typeof v !== 'object') { p.push(`参数 ${k} 不是对象`); continue; }
          // 类型可以用 type 表达，也可以用 oneOf/anyOf/allOf/enum/$ref ——
          // 这些都是合法 JSON Schema。只认 type 会误报
          // （例如 send_message.messages 用 oneOf 表达"字符串或字符串数组"，完全正确）。
          const ty = v.type;
          const legal = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
          const hasAlt = v.oneOf || v.anyOf || v.allOf || v.enum || v.$ref;
          if (ty === undefined && !hasAlt) {
            p.push(`参数 ${k} 既没有 type 也没有 oneOf/enum（模型无法判断该填什么）`);
          } else if (ty !== undefined) {
            const types = Array.isArray(ty) ? ty : [ty];
            for (const x of types) if (!legal.includes(x)) p.push(`参数 ${k} 的 type 非法：${x}`);
          }
          if (!v.description) p.push(`参数 ${k} 缺 description（模型靠它决定怎么填）`);
        }
      }
      // required 里的名字必须在 properties 里存在
      for (const r of t.parameters.required || []) {
        if (!t.parameters.properties?.[r]) p.push(`required 里的 ${r} 不在 properties 中`);
      }
      // required 必须非空数组或不存在 —— 空数组在某些网关上会被判为非法 schema
      if (Array.isArray(t.parameters.required) && t.parameters.required.length === 0) {
        p.push('required 是空数组（应直接省略该字段）');
      }
    } else {
      p.push('缺 parameters');
    }
    if (ids.has(t.id)) dupes.push(t.id);
    ids.add(t.id);
    if (p.length) brokenTools.push(`[${t.id}] ${p.join('；')}`);
  }
  check(dupes.length === 0, `工具 id 无重复（共 ${toolDefs.length} 个工具）`, dupes.join('\n'));
  check(brokenTools.length === 0, '所有工具定义合法（id/名称/描述/分类/JSON Schema 参数）', brokenTools.join('\n'));

  // 工具归属：skillId 要么为 null（核心工具），要么指向一个已加载的技能
  const skillIds = new Set(skills.map((s) => s.id));
  const orphan = toolDefs.filter((t) => t.skillId && !skillIds.has(t.skillId)).map((t) => `${t.id} → skillId=${t.skillId}（技能不存在）`);
  check(orphan.length === 0, '每个工具的 skillId 都指向已加载的技能', orphan.join('\n'));

  // ══ 六、工具的 requires 能力必须有人提供 ════════════════════════════
  console.log('\n=== 六、工具依赖的能力是否存在 ===');
  const unmet = [];
  for (const t of toolDefs) {
    for (const need of t.requires || []) {
      // 只检查"有没有人提供"，不检查"当前是否开启" —— 后者是运行期判定
      if (!allCapNames.has(need)) unmet.push(`${t.id} 需要 ${need}，但没有任何技能声明提供它`);
    }
  }
  check(unmet.length === 0, '工具声明的能力都有技能提供（否则该工具永远不可用）', unmet.join('\n'));

  // ══ 七、工具可用性判定矩阵 ══════════════════════════════════════════
  console.log('\n=== 七、可用性判定 ===');
  const baseCtx = { chatKey: 'group:1', kind: 'group', chatId: '1', config: cfg };
  const matrix = [];
  const badAvailability = [];
  for (const t of toolDefs) {
    const r = getToolAvailability(t.id, baseCtx);
    if (!r || typeof r.enabled !== 'boolean') {
      badAvailability.push(`${t.id} 的可用性结果结构不对：${JSON.stringify(r)}`);
      continue;
    }
    // 不可用时必须给出可读原因，否则用户只会看到"工具不可用"而不知道怎么办
    if (!r.enabled && !r.reason) badAvailability.push(`${t.id} 不可用但没给原因`);
    matrix.push({ id: t.id, cat: t.category, skill: t.skillId || '-', avail: r.enabled, code: r.code || '', reason: r.reason || '' });
  }
  check(badAvailability.length === 0, '每个工具都返回结构正确的可用性（不可用时带原因）', badAvailability.join('\n'));

  // 关闭技能后，它注册的工具应当立刻变为不可用（开关真的联动）
  console.log('\n=== 八、开关联动（关掉技能 → 它的工具立刻不可用）===');
  const skillWithTools = skills.find((s) => (s.toolIds || []).length > 0);
  if (!skillWithTools) {
    ok('当前没有"注册了工具的技能"，跳过联动检查（核心工具不受技能开关影响）');
  } else {
    // ⚠️ 必须走**配置**这一条路，不能只调 manager.deactivate()。
    // 本项目的铁律是"开关只有一个来源：config.skills[id].enabled"。
    // 只调 deactivate 会在下一次 isActive() 时被配置重新判为启用 ——
    // 这正是设计意图（避免出现"运行时状态和配置不一致"的第二套开关），
    // 所以测试也必须按配置来，否则测的是不存在的语义。
    const { setSkillEnabled } = await import('../src/skills/config.js');
    const id = skillWithTools.id;
    const before = (skillWithTools.toolIds || []).map((t) => getToolAvailability(t, baseCtx).enabled);
    check(before.every(Boolean), `技能 ${id} 启用时它的工具可用`, JSON.stringify(before));

    setSkillEnabled(id, false);
    await skillManager.deactivate(id, {});
    const after = (skillWithTools.toolIds || []).map((t) => getToolAvailability(t, baseCtx));
    check(after.every((r) => r.enabled === false && r.code === 'skill-disabled'),
      `关闭 ${id} 后它的 ${after.length} 个工具立刻不可用，且原因码是 skill-disabled`,
      JSON.stringify(after));

    // 复原，避免影响后面的检查
    setSkillEnabled(id, true);
    await skillManager.activate(id, {});
  }

  // ══ 九、分类完整性 ══════════════════════════════════════════════════
  console.log('\n=== 九、分类元信息 ===');
  const cats = listCategories();
  const missingMeta = cats.filter((c) => !c || typeof c !== 'string');
  check(missingMeta.length === 0, `分类列表合法（共 ${cats.length} 类）`, JSON.stringify(cats));
  // 每个分类都要有显示名 —— 否则设置页只能显示一个英文 id
  const noLabel = cats.filter((c) => !CATEGORY_META[c]?.name);
  check(noLabel.length === 0, '每个分类都有中文显示名（UI 要显示）', noLabel.join('\n'));
  // 反向：CATEGORY_META 里定义了但没有任何工具用的分类（留作扩展不算错，只提示）
  const unused = cats.filter((c) => listTools().every((t) => t.category !== c));
  if (unused.length) console.log(`  （提示）以下分类暂无工具使用：${unused.join('、')}`);

  // ══ 十、提示词片段优先级上限 ════════════════════════════════════════
  console.log('\n=== 十、提示词片段优先级 ===');
  const overCap = [];
  for (const s of skills) {
    if (!s.dir) continue;
    let manifest = null;
    for (const mf of ['skill.json', 'plugin.json']) {
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(APP_ROOT, s.dir, mf), 'utf8'));
        break;
      } catch { /* 换下一个文件名 */ }
    }
    if (!manifest) continue;
    for (const sec of manifest?.prompt?.sections || []) {
      // 99 是硬上限：技能永远不能覆盖核心安全规则
      if (Number(sec.priority) > 99) overCap.push(`${s.id}/${sec.id}: priority=${sec.priority}`);
      if (!sec.content) overCap.push(`${s.id}/${sec.id}: 没有 content`);
    }
  }
  check(overCap.length === 0, '技能提示词片段 priority ≤ 99 且都有内容（技能永远不能盖过核心规则）', overCap.join('\n'));

  // ══ 十一、核心内置能力（砍插件后的架构不变量）═══════════════════════
  // 思考模式已收编进核心（src/thinking.js，不再走 skillManager 能力缝）。
  // 其余原插件能力（账号池/抽帧/主人识别/禁言状态/图片兼容）随内置插件
  // 一并移除 —— 核心消费点都是软依赖，缺提供者时静默降级，不构成失败。
  console.log('\n=== 十一、核心内置能力 ===');
  {
    const thinkingMod = await import('../src/thinking.js');
    check(typeof thinkingMod.buildThinkingParams === 'function'
      && typeof thinkingMod.detectDialect === 'function'
      && typeof thinkingMod.extractReasoning === 'function'
      && typeof thinkingMod.looksLikeThinkingRejection === 'function',
    '内置思考模块导出齐全（build/detect/extract/rejection）');
    check(Array.isArray(thinkingMod.THINKING_EFFORTS)
      && ['off', 'low', 'medium', 'high', 'xhigh', 'max'].every((e) => thinkingMod.THINKING_EFFORTS.includes(e)),
    '思考档位表 = off/low/medium/high/xhigh/max 六档');
  }

  for (const t of ['send_image', 'search_images', 'read_video', 'send_sticker']) {
    if (!ids.has(t)) bad(`缺少工具 ${t}`);
    else ok(`工具 ${t} 已注册`);
  }

  // ══ 十二、旧配置迁移的目标技能必须真实存在或显式登记 ════════════════
  // 这条检查来自一个真实 bug：迁移表里的技能名写错不会报任何错误，
  // 只是旧配置被迁进没人读的命名空间。名字写错只会静默失效，所以必须有测试兜住。
  console.log('\n=== 十二、旧配置迁移目标 ===');
  {
    const cfgSrc = fs.readFileSync(path.join(APP_ROOT, 'src/config.js'), 'utf8');
    const skillIdsAll = new Set(skills.map((x) => x.id));
    // 从源码里抓 { from: [...], skill: 'xxx' } 的 skill 值
    const targets = [...cfgSrc.matchAll(/\{\s*from:\s*\[[^\]]+\],\s*skill:\s*'([^']+)'/g)].map((m) => m[1]);
    check(targets.length > 0, `迁移表里解析到 ${targets.length} 条规则`);
    // 预留/已收编目标显式登记：knowledge-base 未移植；video-frames、
    // sticker-annotate 随内置插件移除（旧配置迁移跳过即可，不算错误）。
    const PLANNED = new Set(['knowledge-base', 'video-frames', 'sticker-annotate']);
    const missing = targets.filter((t) => !skillIdsAll.has(t) && !PLANNED.has(t));
    check(missing.length === 0,
      '每条迁移规则的目标技能都真实存在或已显式登记（写错名字只会静默失效）',
      missing.map((m) => `${m} 不存在于 skills/ 或 plugins/`).join('\n'));
  }

  // ══ 十三、skill.json 不带 BOM，且 configSchema 可渲染 ════════════════
  // BOM 会让任何直接 JSON.parse 的工具/编辑器抛 "Unexpected token"，
  // 而报错信息完全不提 BOM —— 极难排查（已经中过一次）。
  console.log('\n=== 十三、清单文件与配置 schema ===');
  {
    const bomFiles = [];
    const schemaProblems = [];
    for (const dir of ['skills', 'plugins']) {
      const base = path.join(APP_ROOT, dir);
      if (!fs.existsSync(base)) continue;
      for (const name of fs.readdirSync(base)) {
        // 两种清单文件名都要看：skills/ 用 skill.json、plugins/ 用 plugin.json。
        // 只认 skill.json 会让 plugins/ 整个跳过检查（历史上正是这样漏掉的）。
        const candidates = ['skill.json', 'plugin.json'].map((f) => path.join(base, name, f));
        const p = candidates.find((c) => fs.existsSync(c));
        if (!p) continue;
        const raw = fs.readFileSync(p, 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) bomFiles.push(relOf(p));
        let m = null;
        try { m = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); } catch { continue; }
        const schema = m.configSchema || {};
        const defaults = m.settings || {};
        // 声明了默认值却没有 schema → 前端渲染不出输入框（用户根本看不到这个设置）
        for (const k of Object.keys(defaults)) {
          if (!schema[k]) schemaProblems.push(`${m.id}.${k} 有默认值但 configSchema 里没有 → 表单渲染不出来`);
        }
        // type:'internal' 是**显式的例外**：这类值是列表/对象，由专用界面管理，
        // 通用表单渲染不了。必须显式标出来并写清去哪改，而不是让它悄悄缺 schema。
        for (const [k, d] of Object.entries(schema)) {
          if (d?.type === 'internal' && !d.description) {
            schemaProblems.push(`${m.id}.${k} 标了 internal 但没说明该去哪改`);
          }
        }
        // schema 里每一项都必须有 type 与 label
        for (const [k, d] of Object.entries(schema)) {
          if (!d?.type) schemaProblems.push(`${m.id}.${k} 缺 type`);
          if (!d?.label) schemaProblems.push(`${m.id}.${k} 缺 label（表单没有可读标签）`);
          if (d?.type === 'enum' && !Array.isArray(d.values)) schemaProblems.push(`${m.id}.${k} 是 enum 但没有 values`);
        }
      }
    }
    check(bomFiles.length === 0, '所有清单文件都不带 UTF-8 BOM', bomFiles.join('\n'));
    check(schemaProblems.length === 0, '每个设置的声明都完整（有默认值必须有 schema；schema 必须有 type/label）', schemaProblems.join('\n'));
  }

  // ══ 十四、孤儿能力：有提供方，却没有消费方 ══════════════════════════
  // 这是最隐蔽的一类失效：技能**加载成功**、能力**注册成功**、UI 显示"生效中"，
  // 但全项目没有任何代码去取用它 —— 于是它的功能永远不会被触发，
  // 而它的 prompt.sections 却还在给模型描述一个用不了的功能（诱导模型瞎编）。
  //
  // 已有的一致性检查只覆盖"声明 ↔ 实现"两个方向，唯独漏了"实现 ↔ 使用"。
  // 这项检查就是补上最后一段：能力被谁消费了？
  console.log('\n=== 十四、孤儿能力（提供方有、消费方无）===');
  {
    // 消费方 = skills/ 与 plugins/ 之外的全部 JS（核心、脚本、electron）
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist.old', 'snowluma', 'data', 'data-2', 'runtime']);
    const consumerFiles = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue;
        const p = path.join(dir, e.name);
        const rel = relOf(p);
        // skills/ 与 plugins/ 是**提供方**，不能当消费方；
        // test/ 也不算 —— 只有测试引用的能力等于没接进主流程。
        if (rel.startsWith('skills/') || rel.startsWith('plugins/') || rel.startsWith('test/')) continue;
        if (e.isDirectory()) walk(p);
        else if (/\.(js|mjs|cjs)$/.test(p)) consumerFiles.push(p);
      }
    })(APP_ROOT);

    const consumerText = consumerFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

    const allCaps = [...new Set(skills.flatMap((s) => s.capabilities || []))].sort();

    // 收集所有技能/插件的源码（用于判断"有没有模块消费这个能力"）
    const moduleSrc = [];
    for (const dir of ['skills', 'plugins']) {
      const base = path.join(APP_ROOT, dir);
      if (!fs.existsSync(base)) continue;
      for (const name of fs.readdirSync(base)) {
        const f = path.join(base, name, 'index.js');
        if (fs.existsSync(f)) moduleSrc.push(fs.readFileSync(f, 'utf8'));
      }
    }
    const allSourceText = consumerText + '\n' + moduleSrc.join('\n');

    // ⚠️ 判定必须精确到**调用形态**，不能只搜字符串：
    // 提供方自己的 index.js 里当然写着这个能力名（providers 的键），
    // 只按 includes 搜会让每个能力都"自证被消费"，检查形同虚设。
    //
    // 两条证据（满足其一即算有消费方）：
    //   a) 核心/脚本（不含 skills 与 plugins，也**不含 test**）里提到它 ——
    //      这些文件不可能是提供方，所以出现即代表真有人引用。
    //      排除 test 是有意的：只有测试引用的能力等于没接进主流程。
    //   b) 任何模块以 api.capability('X') 的形式取用（含自己消费自己）。
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const moduleText = moduleSrc.join('\n');
    const consumersOf = (cap) => {
      if (consumerText.includes(`'${cap}'`) || consumerText.includes(`"${cap}"`)) return true;
      // 注意大小写：核心写的是 skillManager.getCapabilityProviders(...) —— 大写的 C
      return new RegExp(`[Cc]apability\\(\\s*['"]${esc(cap)}['"]`).test(moduleText);
    };

    // 核心启动时会主动问的能力（工具可用性判定链用的那批），属于"框架级消费"
    const FRAMEWORK_CAPS = new Set(['tool.guard']);

    // ⚠️ "没有外部消费方"有两种，性质完全不同，不能一律判失败：
    //
    //   a) 提供方**没有任何工具** → 这是真孤儿。能力没人取用、模型也调不到，
    //      整个功能永远不触发，而它的 prompt.sections 还在诱导模型瞎编。
    //      （当初抓到的 14 个孤儿全是这一类：reply.*、media.download.*、media.transcribe…）
    //
    //   b) 提供方**自己注册了工具**，能力只是它对外的公开 API（给别的技能或核心按需取用），
    //      暂时没有外部调用者 → 功能本身能用，只是 API 面还没人接。
    //      这类降级为提示，不算失败 —— 否则"顺手暴露一个能力"就会被测试拦住。
    const orphans = [];
    const exposed = [];
    for (const cap of allCaps) {
      if (FRAMEWORK_CAPS.has(cap)) continue;
      if (consumersOf(cap)) continue;
      const owners = skills.filter((s) => (s.capabilities || []).includes(cap));
      const ownerIds = owners.map((s) => s.id);
      const ownerHasTool = owners.some((s) => (s.toolIds || []).length > 0);
      const line = `${cap}（由 ${ownerIds.join(', ')} 提供，全项目无任何取用调用）`;
      if (ownerHasTool) exposed.push(line);
      else orphans.push(line);
    }
    for (const e of exposed) {
      console.log(`  · 公开能力（本模块自带工具，暂无外部消费方，不计失败）：${e}`);
    }
    check(orphans.length === 0,
      `每个能力都有消费方（共 ${allCaps.length} 个能力，无孤儿${exposed.length ? `；${exposed.length} 个公开能力` : ''}）`,
      orphans.length
        ? '以下能力的提供方已注册，但全项目没有代码取用它 —— 功能永远不会被触发：\n' + orphans.join('\n')
        : '');
  }

  // ══ 十五、两型归位：条目是否放在语义正确的目录里 ══════════════════════
  // 约定（见 src/skills/manifest.js 的 DIR_KIND）：
  //   plugins/ 确定性型 —— 必须有 providers 或 hooks（核心会必然调用它）
  //   skills/  LLM 型  —— 必须注册工具（否则模型看不见，功能永远不触发）
  // 放错不会报错、不会崩，只是功能静默失效 —— 正是必须由测试兜住的一类。
  console.log('\n=== 十五、两型归位（确定性型 / LLM 型）===');
  {
    const misplaced = [];
    for (const s of skills) {
      if (!s.kind) continue;                       // 自定义根目录（测试）不判定
      const tools = (s.toolIds || []).length;
      const caps = (s.implementedCapabilities || []).length;
      const hooks = (s.hooks || []).length;

      if (s.kind === 'skill' && tools === 0) {
        misplaced.push(`${s.id} 在 skills/（LLM 型）但没注册工具 → 模型看不到它，应移到 plugins/ 或补 registerTool`);
      }
      if (s.kind === 'plugin' && caps === 0 && hooks === 0) {
        misplaced.push(`${s.id} 在 plugins/（确定性型）但没提供能力/钩子 → 没有代码会调用它，应移到 skills/（并注册工具）`);
      }
    }
    check(misplaced.length === 0,
      `每个条目都在语义正确的目录里（${skills.filter((s) => s.kind).length} 个受检）`,
      misplaced.join('\n'));
  }

  // ══ 十六、插件不得绕过发送队列 ══════════════════════════════════════
  // 所有出站消息必须走 SendQueue（限频 / 去重 / 真人化间隔 / 留档）。
  // 插件直连 onebot.sendSegments 会跳过这一整套：媒体把配额吃光后文字突然发不出，
  // 而且下一次运行不知道自己发过（可能重复发）。这是"不报错但行为坏掉"的一类，
  // 静态就能抓住，所以放进审计。
  //
  // 判定方式（故意宽松，避免误报）：凡是出现直发调用的文件，必须同时出现
  // `sender.sendMedia`——说明那里做了"优先走队列、直发仅作兜底"的收口。
  console.log('\n=== 十六、发送纪律（插件不得绕过发送队列）===');
  {
    const offenders = [];
    const scanDirs = ['plugins', 'skills'];
    for (const d of scanDirs) {
      const base = path.join(APP_ROOT, d);
      if (!fs.existsSync(base)) continue;
      for (const name of fs.readdirSync(base)) {
        const dir = path.join(base, name);
        if (!fs.statSync(dir).isDirectory()) continue;
        const walk = (p) => {
          for (const e of fs.readdirSync(p, { withFileTypes: true })) {
            const full = path.join(p, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; }
            if (!e.name.endsWith('.js')) continue;
            const text = fs.readFileSync(full, 'utf8');
            const directSend = /\bonebot\s*[?]?\.\s*send(Segments|Text|Image|Sticker|Poke)\s*\(/.test(text);
            if (!directSend) continue;
            const hasQueuePath = /sender\s*[?]?\.\s*sendMedia\s*\(/.test(text);
            if (!hasQueuePath) offenders.push(relOf(full));
          }
        };
        walk(dir);
      }
    }
    check(offenders.length === 0,
      '直连 OneBot 发消息的文件都做了"优先走发送队列"的收口',
      offenders.map((f) => `${f}：调了 onebot.send*，但没有 sender.sendMedia 兜底 → 会跳过限频与留档`).join('\n'));
  }

  // ══ 输出矩阵 ════════════════════════════════════════════════════════
  console.log('\n=== 工具可用性矩阵 ===');
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0)));
  console.log(pad('#id', 26) + pad('分类', 12) + pad('归属', 22) + '状态');
  for (const m of matrix.sort((a, b) => a.cat.localeCompare(b.cat) || a.id.localeCompare(b.id))) {
    console.log(pad(m.id, 26) + pad(m.cat, 12) + pad(m.skill, 22) + (m.avail ? '可用' : `不可用：${m.reason}`));
  }

  console.log('\n=== Skill 清单 ===');
  console.log(pad('#id', 20) + pad('分类', 12) + pad('默认', 8) + pad('能力', 6) + '工具数');
  for (const s of skills.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(pad(s.id, 20) + pad(s.category, 12) + pad(s.enabled ? '开' : '关', 8)
      + pad((s.capabilities || []).length, 6) + (s.toolIds || []).length);
  }

  console.log(`\n${fail === 0 ? '全部通过' : '存在失败'} —— 通过 ${pass} / 失败 ${fail}`);
  if (fail) { console.log('\n失败项：'); for (const f of failures) console.log('  -', f); }
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error('\n❌ 审查脚本自身出错：', error?.message ?? error);
  if (error?.stack) console.error(error.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
