// zip 解压安装：把市场下载的安装包安全地落到 skills/ 或 plugins/ 目录。
//
// 独立成模块的原因：这段是"往磁盘写可执行 JS"的入口，安全边界必须集中、可单测。
// 与 server/community_app.py 的 validate_zip 规则对齐（那里上传时校验一次，
// 这里安装前再校验一次 —— 不信任任何传输环节）。
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const BANNED_EXT = /\.(exe|dll|bat|cmd|ps1|vbs|sh)$/i;
const MAX_FILES = 100;
const MAX_TOTAL = 32 * 1024 * 1024;

/**
 * 结构校验（抛错 = 拒绝安装）：
 *   · zip 中央目录里的每个条目：禁绝对路径/..、禁可执行后缀
 *   · 文件数与解压总量上限（zip 炸弹防护）
 * 返回 [{ name, data }]（仅文件条目，目录跳过）。
 */
export function validateZipStructure(buffer) {
  const entries = parseZip(buffer);
  if (entries.length > MAX_FILES) throw new Error(`文件数量过多（${entries.length} > ${MAX_FILES}）`);
  let total = 0;
  for (const e of entries) total += e.data.length;
  if (total > MAX_TOTAL) throw new Error('解压后总大小超过 32MB');
  return entries;
}

/**
 * 解压安装到 <root>/skills/ 或 <root>/plugins/ 下的一个目录。
 *
 * 目录名规则：
 *   · zip 里通常有一层与包同名的根目录（服务端打包格式 `<id>/...`），剥掉它
 *   · 没有统一根目录时用 preferId（服务器告知的 id）
 *   · 与本地已有目录冲突 → 自动 _1/_2（重装场景：同 id 覆盖会丢用户改动，
 *     而且插件热重载正在 watch 旧目录，覆盖写一半会加载出半截代码）
 *
 * @returns {Promise<string>} 实际落地的目录名
 */
export async function unzipToModuleDir(buffer, { root, type, preferId = '' }) {
  const entries = validateZipStructure(buffer);
  if (!entries.length) throw new Error('安装包是空的');
  const baseDir = path.join(root, type === 'plugin' ? 'plugins' : 'skills');

  // 剥统一根目录：所有条目都共享同一个第一段时去掉它
  let names = entries.map((e) => e.name);
  let strip = 0;
  const firstSeg = names[0].split('/')[0];
  if (firstSeg && names.every((n) => n.startsWith(firstSeg + '/'))) strip = firstSeg.length + 1;
  const relNames = names.map((n) => n.slice(strip));
  if (relNames.some((n) => !n)) throw new Error('安装包结构异常（剥掉根目录后有条目为空）');

  // 落地目录名：优先 zip 根目录名，其次 preferId
  let dirName = strip ? firstSeg : (preferId || 'module');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(dirName)) dirName = preferId || 'module';
  // 冲突递增
  let finalName = dirName;
  for (let n = 1; n <= 100; n++) {
    if (!fs.existsSync(path.join(baseDir, finalName))) break;
    finalName = `${dirName}_${n}`;
  }
  const target = path.join(baseDir, finalName);
  fs.mkdirSync(target, { recursive: true });

  for (let i = 0; i < entries.length; i++) {
    const rel = relNames[i];
    // 二次防线：拼接结果必须仍在 target 内（解析后 path.relative 检查）
    const dest = path.join(target, ...rel.split('/'));
    const relCheck = path.relative(target, dest);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      throw new Error(`安装包包含非法路径：${entries[i].name}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entries[i].data);
  }
  return finalName;
}

/** 极简 zip 读取器：中央目录定位 + 解压全部文件条目。不支持的特性直接抛错。 */
function parseZip(buffer) {
  const sig = (off) => buffer.readUInt32LE(off);
  // 定位 EOCD（22 字节，从尾部向前扫，允许有注释）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65536); i--) {
    if (sig(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = buffer.readUInt16LE(eocd + 10);
  let ptr = buffer.readUInt32LE(eocd + 16);

  const out = [];
  for (let i = 0; i < count; i++) {
    if (sig(ptr) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buffer.readUInt16LE(ptr + 10);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOff = buffer.readUInt32LE(ptr + 42);
    const name = buffer.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    // 目录条目（以 / 结尾）跳过
    if (!name.endsWith('/')) {
      // 本地头：定位到实际数据
      if (sig(localOff) !== 0x04034b50) throw new Error('zip 本地头损坏');
      const lNameLen = buffer.readUInt16LE(localOff + 26);
      const lExtraLen = buffer.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buffer.subarray(dataStart, dataStart + compSize);
      let data;
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = inflateRawSync(raw);
      else throw new Error(`不支持的压缩方式（method=${method}）：${name}`);
      out.push({ name: name.replace(/\\/g, '/'), data });
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  // 安全规则（与后端一致）
  for (const e of out) {
    const parts = e.name.split('/');
    if (e.name.startsWith('/') || parts.includes('..')) throw new Error(`安装包包含非法路径：${e.name}`);
    if (BANNED_EXT.test(e.name)) throw new Error(`安装包包含禁止的文件类型：${e.name}`);
  }
  return out;
}
