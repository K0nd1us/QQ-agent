// QQ 官方表情目录：优先使用 QQ 机器人官方文档《表情对象》的系统表情表，
// 同时兼容 SnowLuma 自带 sys-face-catalog.json 的 qSid/emCode 别名。
//
// 官方模型：
//   EmojiType = 1  -> 系统表情，id 为数字；
//   EmojiType = 2  -> emoji 表情，id 为 emoji 本身 / Unicode 码点。
// 本模块主要处理群聊/私聊 OneBot face 段，即系统表情（EmojiType=1）。
//
// 展示格式统一为 [QQ表情:名称(#官方id)]，发送时也尽量收敛到官方 id。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'snowluma', 'data', 'sys-face-catalog.json');

// 来自官方文档 Emoji 列表（EmojiType=1 系统表情）
const OFFICIAL_SYSTEM_FACES = {
  '4': '得意',
  '5': '流泪',
  '8': '睡',
  '9': '大哭',
  '10': '尴尬',
  '12': '调皮',
  '14': '微笑',
  '16': '酷',
  '21': '可爱',
  '23': '傲慢',
  '24': '饥饿',
  '25': '困',
  '26': '惊恐',
  '27': '流汗',
  '28': '憨笑',
  '29': '悠闲',
  '30': '奋斗',
  '32': '疑问',
  '33': '嘘',
  '34': '晕',
  '38': '敲打',
  '39': '再见',
  '41': '发抖',
  '42': '爱情',
  '43': '跳跳',
  '49': '拥抱',
  '53': '蛋糕',
  '60': '咖啡',
  '63': '玫瑰',
  '66': '爱心',
  '74': '太阳',
  '75': '月亮',
  '76': '赞',
  '78': '握手',
  '79': '胜利',
  '85': '飞吻',
  '89': '西瓜',
  '96': '冷汗',
  '97': '擦汗',
  '98': '抠鼻',
  '99': '鼓掌',
  '100': '糗大了',
  '101': '坏笑',
  '102': '左哼哼',
  '103': '右哼哼',
  '104': '哈欠',
  '106': '委屈',
  '109': '左亲亲',
  '111': '可怜',
  '116': '示爱',
  '118': '抱拳',
  '120': '拳头',
  '122': '爱你',
  '123': 'NO',
  '124': 'OK',
  '125': '转圈',
  '129': '挥手',
  '144': '喝彩',
  '147': '棒棒糖',
  '171': '茶',
  '173': '泪奔',
  '174': '无奈',
  '175': '卖萌',
  '176': '小纠结',
  '179': 'doge',
  '180': '惊喜',
  '181': '骚扰',
  '182': '笑哭',
  '183': '我最美',
  '201': '点赞',
  '203': '托脸',
  '212': '托腮',
  '214': '啵啵',
  '219': '蹭一蹭',
  '222': '抱抱',
  '227': '拍手',
  '232': '佛系',
  '240': '喷脸',
  '243': '甩头',
  '246': '加油抱抱',
  '262': '脑阔疼',
  '264': '捂脸',
  '265': '辣眼睛',
  '266': '哦哟',
  '267': '头秃',
  '268': '问号脸',
  '269': '暗中观察',
  '270': 'emm',
  '271': '吃瓜',
  '272': '呵呵哒',
  '273': '我酸了',
  '277': '汪汪',
  '278': '汗',
  '281': '无眼笑',
  '282': '敬礼',
  '284': '面无表情',
  '285': '摸鱼',
  '287': '哦',
  '289': '睁眼',
  '290': '敲开心',
  '293': '摸锦鲤',
  '294': '期待',
  '297': '拜谢',
  '298': '元宝',
  '299': '牛啊',
  '305': '右亲亲',
  '306': '牛气冲天',
  '307': '喵喵',
  '314': '仔细分析',
  '315': '加油',
  '318': '崇拜',
  '319': '比心',
  '320': '庆祝',
  '322': '拒绝',
  '324': '吃糖',
  '326': '生气'
};

let catalogCache = null;
let aliasCache = null;

function loadCatalog() {
  if (catalogCache) return catalogCache;
  const names = new Map();
  const aliases = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    const packs = Array.isArray(raw) ? raw : (Array.isArray(raw?.packs) ? raw.packs : []);
    for (const pack of packs) {
      for (const emoji of pack?.emojis ?? []) {
        const qSid = String(emoji?.qSid ?? '').trim();
        const emCode = String(emoji?.emCode ?? '').trim();
        const name = String(emoji?.qDes ?? '').replace(/^\//, '').trim();
        if (!qSid && !emCode) continue;
        // qSid 优先作为官方/展示 id；emCode 作为别名收敛到 qSid
        const canonical = qSid || emCode;
        if (name) {
          if (!names.has(canonical)) names.set(canonical, name);
          if (qSid && !names.has(qSid)) names.set(qSid, name);
          if (emCode && emCode !== canonical && !names.has(emCode)) names.set(emCode, name);
        }
        if (qSid) aliases.set(qSid, qSid);
        if (emCode) aliases.set(emCode, qSid || emCode);
      }
    }
  } catch {
    // 目录缺失/读取失败不致命，仍有官方表兜底
  }
  catalogCache = names;
  aliasCache = aliases;
  return names;
}

function canonicalId(id) {
  const key = String(id ?? '').trim();
  if (!key) return '';
  if (OFFICIAL_SYSTEM_FACES[key]) return key; // 官方表中已存在的 ID 不再用旧 emCode 别名改写
  loadCatalog();
  if (aliasCache?.has(key)) return aliasCache.get(key);
  return key;
}

/** 根据 face id 获取名称；优先官方表，其次 SnowLuma 目录。例如 5/105 -> 流泪。 */
export function describeQqFace(id) {
  const key = String(id ?? '').trim();
  if (!key) return '';
  const canonical = canonicalId(key);
  const official = OFFICIAL_SYSTEM_FACES[canonical] || OFFICIAL_SYSTEM_FACES[key];
  if (official) return official;
  return loadCatalog().get(canonical) || loadCatalog().get(key) || '';
}

/** 把 id 转成 AI 易读的标记，展示统一收敛到官方 id。例如 105 -> [QQ表情:流泪(#5)]。 */
export function formatQqFace(id) {
  const key = String(id ?? '').trim();
  if (!key) return '[QQ表情]';
  const canonical = canonicalId(key);
  const name = describeQqFace(canonical);
  return name ? `[QQ表情:${name}(#${canonical})]` : `[QQ表情#${canonical}]`;
}

/**
 * 从 AI 写的引用文本里解析出 face id，并收敛为官方系统表情 id。
 * 支持：
 *   "5" / "#5" / "流泪" / "流泪(#5)" / "QQ表情:流泪(#5)"
 *   以及旧别名 "105" / "#105"（会映射为 5）
 */
export function resolveQqFaceId(ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return '';
  const noSharp = raw.replace(/^#/, '');
  if (/^\d+$/.test(noSharp)) return canonicalId(noSharp);
  const withId = raw.match(/\(#(\d+)\)$/);
  if (withId) return canonicalId(withId[1]);
  const name = raw
    .replace(/^QQ表情\s*[:：]\s*/i, '')
    .replace(/\(#\d+\)$/, '')
    .trim();
  for (const [id, label] of loadCatalog()) {
    if (label === name) return canonicalId(id);
  }
  for (const [id, label] of Object.entries(OFFICIAL_SYSTEM_FACES)) {
    if (label === name) return id;
  }
  return '';
}
