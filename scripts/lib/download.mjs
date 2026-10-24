// 带进度条的流式下载器（setup 与 setup-napcat 共用）。
//
// ── 为什么要流式，而不是 arrayBuffer() ────────────────────────────────
// 原来两个脚本都是 `Buffer.from(await res.arrayBuffer())` —— 一次把整个文件读进内存：
//   · 几百 MB 的 QQ 安装包直接占几百 MB 内存
//   · 中途完全看不到进度，只能干等（用户以为卡死了）
//   · 断开时内存里那半截直接丢，重来一遍
// 改成边下边写盘 + 增量算哈希，内存占用变成常数（一个 chunk），
// 而且天然能报告进度、能计算速度与剩余时间。
//
// ── 为什么写 .part 再改名 ─────────────────────────────────────────────
// 直接写目标文件时，中断/磁盘满会留下**半个文件**，而调用方只看"文件存在"
// 就以为下载成功了 —— 下次可能拿一个损坏的安装包去安装。
// 写 .part 再 rename 是原子的：要么完整，要么不存在。
//
// ── 进度输出到 stderr ────────────────────────────────────────────────
// `npm run setup > log.txt` 时，日志文件里只该有可读的日志，
// 而不该混进几十行 `\r` 刷新的进度条。所以进度走 stderr、日志走 stdout。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 人类可读的字节数。 */
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
}

/** 秒数 → "1m20s" / "45s" / "?"。 */
export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '?';
  if (sec < 60) return `${Math.ceil(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/**
 * 渲染一行进度条文本（纯函数，方便测试）。
 *
 * @param {object} o
 *   got       已接收字节
 *   total     总字节（0 = 未知，走不确定模式）
 *   width     进度条格子数
 *   elapsedMs 已用毫秒
 *   unit      单位换算用（默认 1024*1024 → MB）
 * @returns {string}
 */
export function formatProgress({ got = 0, total = 0, width = 24, elapsedMs = 0 } = {}) {
  const w = Math.max(6, Math.min(60, Number(width) || 24));
  const elapsed = Math.max(0, Number(elapsedMs) || 0) / 1000;
  const speed = elapsed > 0 ? got / elapsed : 0;

  if (!total || total <= 0) {
    // 拿不到 content-length（分块传输/某些中转）时不能假装知道进度，
    // 只报"已下载多少 + 速度"，不画假的百分比。
    return `  下载中 ${fmtBytes(got)}  ${fmtBytes(speed)}/s`;
  }

  const pct = Math.max(0, Math.min(1, got / total));
  const filled = Math.round(pct * w);
  const bar = '█'.repeat(filled) + '░'.repeat(w - filled);
  const eta = speed > 0 ? (total - got) / speed : NaN;
  return `  [${bar}] ${(pct * 100).toFixed(1).padStart(5)}%  `
    + `${fmtBytes(got)}/${fmtBytes(total)}  ${fmtBytes(speed)}/s  剩 ${fmtDuration(eta)}`;
}

/**
 * 进度渲染器：TTY 上原地刷新，非 TTY（日志重定向/CI）按百分比节点打印。
 */
export function createProgressRenderer({ stream = process.stderr, label = '', enabled = true } = {}) {
  const isTty = Boolean(stream.isTTY);
  const cols = Number(stream.columns) || 80;
  const width = Math.max(10, Math.min(40, cols - 52));   // 留出右侧文字的地方
  let lastDraw = 0;
  let lastPctShown = -1;
  let drew = false;

  const clear = () => {
    if (drew && isTty) { stream.write('\r' + ' '.repeat(Math.min(cols, 120)) + '\r'); drew = false; }
  };

  return {
    update({ got, total, elapsedMs }) {
      if (!enabled) return;
      if (!isTty) {
        // 非 TTY：每跨过 10% 打一行（或未知大小时每 32MB），避免日志里几百行
        const pct = total > 0 ? Math.floor((got / total) * 10) : -1;
        const bucket = total > 0 ? pct : Math.floor(got / (32 * 1048576));
        if (bucket !== lastPctShown) {
          lastPctShown = bucket;
          stream.write(`  ${label}${formatProgress({ got, total, width, elapsedMs })}\n`);
        }
        return;
      }
      const now = Date.now();
      if (now - lastDraw < 100) return;   // 限流到 ~10fps，避免刷屏与 CPU 抖动
      lastDraw = now;
      stream.write('\r' + label + formatProgress({ got, total, width, elapsedMs }));
      drew = true;
    },
    done({ got, total, elapsedMs }) {
      if (!enabled) return;
      clear();
      const sec = Math.max(0, Number(elapsedMs) || 0) / 1000;
      const avg = sec > 0 ? got / sec : 0;
      stream.write(`  ${label}完成：${fmtBytes(got)}，用时 ${fmtDuration(sec)}（平均 ${fmtBytes(avg)}/s）\n`);
    },
    fail() { clear(); },
    /** 让出一条干净的整行，供 stdout 的日志接着打 */
    release: clear
  };
}

/**
 * 流式下载到 dest。
 *
 * @param {string} url
 * @param {string} dest 最终路径（先写 dest.part 再原子改名）
 * @param {object} opts
 *   expectedSha256 期望哈希（大写十六进制）；为空则跳过校验
 *   label          进度条前缀，如 "QQ 安装包 "
 *   quiet          true = 不显示进度
 *   hint404        404 时附加的提示（各调用方的缓存目录不同）
 *   onProgress     可选回调 ({ got, total, elapsedMs })
 * @returns {Promise<{ bytes:number, sha256:string, fromCache?:boolean }>}
 */
export async function download(url, dest, {
  expectedSha256 = null,
  label = '',
  quiet = false,
  hint404 = '',
  onProgress = null
} = {}) {
  const partPath = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // 初始请求也可能抛 "fetch failed"（DNS 解析不了 / TLS 失败 / 连接被拒），
  // 这个报错对用户毫无帮助 —— 真正的原因埋在 error.cause 里，必须翻出来。
  // 注意这一步在下面的 try 之外（那时还没有 .part 文件要清理），所以单独包一层。
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (error) {
    const cause = error?.cause?.message || error?.cause?.code || '';
    const e = new Error(`无法连接到下载源：${cause || error?.message || error}`
      + `\n  地址：${url}`
      + '\n  请检查网络/代理，或改用手动下载后放入缓存目录。');
    e.cause = error;
    throw e;
  }
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`下载失败：HTTP 404 —— 文件已从源站移除或链接失效。${hint404 ? `\n  ${hint404}` : ''}`);
    }
    throw new Error(`下载失败：HTTP ${res.status}`);
  }
  if (!res.body) throw new Error('下载失败：响应没有 body（服务器可能不支持流式）');

  const total = Number(res.headers.get('content-length') ?? 0);
  const expectSha = String(expectedSha256 || '').trim().toUpperCase();
  const hash = createHash('sha256');
  const renderer = createProgressRenderer({ label, enabled: !quiet });
  const startedAt = Date.now();
  let got = 0;
  let stream;

  try {
    stream = fs.createWriteStream(partPath);
    // 逐个 chunk 落盘：内存占用与文件大小无关
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      got += buf.length;
      hash.update(buf);
      if (!stream.write(buf)) {
        // 等这波写完再继续读，避免磁盘慢时内存里堆积
        await new Promise((resolve, reject) => {
          stream.once('drain', resolve);
          stream.once('error', reject);
        });
      }
      const elapsedMs = Date.now() - startedAt;
      renderer.update({ got, total, elapsedMs });
      onProgress?.({ got, total, elapsedMs });
    }
    await new Promise((resolve, reject) => {
      stream.end(() => resolve());
      stream.once('error', reject);
    });
    stream = null;
  } catch (error) {
    try { stream?.destroy(); } catch { /* ignore */ }
    renderer.fail();
    try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch { /* ignore */ }

    // 连接中途断开时，Node 的 fetch 只抛一个光秃秃的 "TypeError: fetch failed"，
    // 真正的原因埋在 error.cause 里。对用户来说，"fetch failed" 无法区分
    // "断网了" / "下载到一半断了" / "DNS 解析不了"，也没告诉他重试有没有用。
    // 这里补足上下文：只要拿到了长度、且已收到部分字节，就明确说是下载中断并给出进度。
    const cause = error?.cause?.message || error?.cause?.code || '';
    if (total > 0 && got > 0 && got < total) {
      const e = new Error(
        `下载中断：只收到 ${fmtBytes(got)}/${fmtBytes(total)}（${((got / total) * 100).toFixed(1)}%）。`
        + '\n  连接被中断或服务端提前关闭，重试通常可以继续；若反复失败请改用手动下载。'
        + (cause ? `\n  底层原因：${cause}` : '')
      );
      e.cause = error;
      throw e;
    }
    if (error instanceof Error && cause && error.message === 'fetch failed') {
      error.message = `下载失败：${cause}`;
    }
    throw error;
  }

  renderer.done({ got, total, elapsedMs: Date.now() - startedAt });

  // 先校验再改名：不合格的半个文件绝不允许出现在目标路径上
  if (total && got !== total) {
    try { fs.unlinkSync(partPath); } catch { /* ignore */ }
    throw new Error(`下载不完整：收到 ${got}/${total} 字节（连接可能被中断，请重试）`);
  }
  const sha256 = hash.digest('hex').toUpperCase();
  if (expectSha && sha256 !== expectSha) {
    try { fs.unlinkSync(partPath); } catch { /* ignore */ }
    throw new Error(`SHA256 校验失败：期望 ${expectSha}，实际 ${sha256}`);
  }

  fs.renameSync(partPath, dest);
  return { bytes: got, sha256 };
}

/** 计算现有文件的 SHA256（用于缓存校验）。 */
export function fileSha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}
