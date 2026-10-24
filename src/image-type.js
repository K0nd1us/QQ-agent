// 图片类型嗅探：**唯一的实现**。
//
// 为什么单独抽一个模块：此前 tools.js / image-compress.js / sticker-manager.js
// 各写了一份几乎相同的魔数判断，其中 sticker-manager 那份还漏了 JPEG 分支
// （靠"默认返回 .jpg"歪打正着）。三份实现各自演化，加一种格式就要改三处，
// 很容易出现"同一条图片在看图工具和收藏转存里被识别成不同类型"。
//
// 纯函数、零依赖，可被任何模块安全引入。

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];
const JPEG_SIG = [0xff, 0xd8, 0xff];

/**
 * 按魔数识别图片类型。
 * @param {Buffer|Uint8Array} buf
 * @returns {{ mime: string, ext: string } | null} 识别不出返回 null
 */
export function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  const b = buf;
  if (b[0] === PNG_SIG[0] && b[1] === PNG_SIG[1] && b[2] === PNG_SIG[2] && b[3] === PNG_SIG[3]) {
    return { mime: 'image/png', ext: '.png' };
  }
  if (b[0] === JPEG_SIG[0] && b[1] === JPEG_SIG[1] && b[2] === JPEG_SIG[2]) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }
  // 只取需要的字节再转 ascii，避免为了读 6 个字节而复制整张图
  const sliceAscii = (from, to) => {
    const view = typeof b.subarray === 'function' ? b.subarray(from, to) : b.slice(from, to);
    return Buffer.from(view).toString('ascii');
  };
  const head6 = sliceAscii(0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return { mime: 'image/gif', ext: '.gif' };
  if (sliceAscii(0, 4) === 'RIFF' && sliceAscii(8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  return null;
}

/** 只取 MIME（识别不出返回 null）。 */
export function detectMime(buf) {
  return detectImageType(buf)?.mime ?? null;
}

/** MIME → 扩展名；未知一律回落 .jpg（与历史行为一致）。 */
export function mimeToExt(mime) {
  switch (String(mime || '').toLowerCase()) {
    case 'image/png': return '.png';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    case 'image/jpeg':
    case 'image/jpg': return '.jpg';
    default: return '.jpg';
  }
}

/** 只取扩展名；识别不出按 .jpg 处理（表情转存的历史默认值）。 */
export function detectImageExt(buf) {
  return detectImageType(buf)?.ext ?? mimeToExt('');
}
