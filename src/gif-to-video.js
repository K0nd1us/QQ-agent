// GIF → 视频转换：有人发动态表情（GIF）时，把它转成模型可读的 mp4。
//
// ── 为什么需要这个模块 ────────────────────────────────────────────────
// "支持图片输入"和"能读 GIF"是两回事，"支持视频输入"和"能读 GIF"也是两回事：
//   · 多数视觉 API 对 GIF 要么按第一帧处理、要么直接拒收；
//   · 全模态模型多数能读 mp4，却读不了 GIF。
// 所以当用户在设置里勾了「视频输入」(api.video) 时，看图工具拿到 GIF 不再按
// 图片原样发，而是先用 ffmpeg 转成 mp4，再按 video 部件发给模型
// （llm.js 的 specializedModelFor 会自动切到 videoModel）。
//
// ── 防"压缩炸弹"（decompression bomb）────────────────────────────────
// GIF 是无损索引色格式，一个几 MB 的 GIF 解开可能是上万帧超大画布，
// 转出来的 mp4 会大到把模型 token 预算炸穿（甚至拖垮网关）。
// 强约束（写死，不做成配置 —— 这是安全上限，不是口味）：
//   · 转换后长宽的最大边 ≤ 480 像素
//   · 转换后的总帧数 ≤ 24 帧
// ffmpeg 一次调用同时做到：先按需缩放，再均匀重采样帧（fps=帧数/时长），
// 最后 -frames:v 兜底截断 —— 即使 GIF 元数据撒谎也能被第三道闸拦住。
//
// ── 与项目其它 ffmpeg 用法的关系 ─────────────────────────────────────
// 项目里已有三处各自探测 ffmpeg（video-reader / image-compress / video-frames 插件），
// 各有各的缓存与超时口径。这里是第四处，但刻意**不共享**探测结果：
// 各处传参方式不同（有的要 stdout、有的只看退出码），耦合它们会让"改一处超时、
// 另一处悄悄跟着变"这种事发生。重复的是 20 行探测样板，换来的是互相独立。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { detectImageType } from './image-type.js';

/** 转换后最大边（像素）。 */
export const GIF_VIDEO_MAX_DIM = 480;
/** 转换后最大帧数。 */
export const GIF_VIDEO_MAX_FRAMES = 24;

/** 调外部命令，只看退出码；失败/超时返回 false（不抛）。 */
function runOk(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    } catch {
      return finish(false);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(false); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); finish(false); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0); });
  });
}

/** ffmpeg 探测（成功长期缓存；没找到 60 秒后允许重探——用户装好后不用重启）。 */
let _ffmpeg = null;
let _checked = false;
let _checkedAt = 0;
const FFMPEG_RETRY_MS = 60000;
async function findFfmpeg() {
  if (_checked && _ffmpeg) return _ffmpeg;
  if (_checked && Date.now() - _checkedAt < FFMPEG_RETRY_MS) return _ffmpeg;
  _checked = true;
  _checkedAt = Date.now();
  _ffmpeg = null;
  for (const name of ['ffmpeg', 'ffmpeg.exe']) {
    if (await runOk(name, ['-version'], 5000)) { _ffmpeg = name; break; }
  }
  return _ffmpeg;
}

/** 测试用：清空探测缓存。 */
export function __resetFfmpegCache() {
  _ffmpeg = null;
  _checked = false;
  _checkedAt = 0;
}

/** 这段字节是 GIF 吗（魔数 GIF87a / GIF89a）。 */
export function isGifBuffer(buf) {
  const head = buf?.length >= 6 ? buf.toString('ascii', 0, 6) : '';
  return head === 'GIF87a' || head === 'GIF89a';
}

/**
 * 把 GIF 字节转成 mp4 data URL。
 *
 * @param {Buffer} buffer GIF 原始字节（已由调用方下载并校验过魔数）
 * @returns {Promise<{dataUrl: string, frames: number, width: number, height: number} | null>}
 *   失败（没 ffmpeg / 转换出错 / 产出异常）返回 null，调用方回退到按图片发送。
 */
export async function gifToVideoDataUrl(buffer) {
  const type = detectImageType(buffer);
  if (!type || type.mime !== 'image/gif') return null;
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return null;

  const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpIn = path.join(os.tmpdir(), `qqa_gif_in_${stamp}.gif`);
  const tmpOut = path.join(os.tmpdir(), `qqa_gif_out_${stamp}.mp4`);
  try {
    fs.writeFileSync(tmpIn, buffer);
    // ffmpeg 参数：
    //   -ignore_loop 0        GIF 是循环格式；不忽略 loop 的话某些版本会无限读帧
    //   fps=24/duration ...   见下：需要先知道时长才能均匀采到 ≤24 帧
    //   scale                  最长边 ≤480，等比缩小（小图不放大）
    //   -frames:v 24           帧数兜底闸：即使 fps 估算被恶意元数据骗过，
    //                          输出也绝不可能超过 24 帧
    //   -an                    GIF 没有音轨，显式丢弃避免某些封装器报错
    //   -movflags +faststart   mp4 索引前置：模型网关多数是流式读，不用等全文件
    //   -pix_fmt yuv420p       多数解码器只认 420p；GIF 的调色板格式直转会被拒
    //
      // fps 的取法（防炸弹的核心）：
      //   GIF 的帧延时可以任意小（1ms），直接 -r 抽采样会先解码全部帧再丢，
      //   上万帧的炸弹 GIF 会让 ffmpeg 跑几分钟。所以分两步：
      //   第一步 ffprobe 拿真实时长；第二步 fps = 24 / duration（每帧间隔都保留）。
      //   拿不到时长就退回 fps=12 的保守值 —— 24 帧上限由 -frames:v 保证。
      //
      // force_divisible_by=2（2026-09-19 修"勾了视频输入 GIF 依旧按图片发"）：
      //   yuv420p + libx264 只吃偶数宽高。QQ 表情 GIF 常见 640x361 这种奇数高，
      //   转换会以 "Error while opening encoder" 失败，gifToVideoDataUrl 返回
      //   null，调用方静默回退到按图片发 —— 表现为「视频输入勾了却永远不生效」。
      //   整除 2 最多让画面偏 1px，比转换失败强得多。
      const duration = await probeDuration(tmpIn);
      const fps = duration > 0 ? Math.min(24, Math.max(1, 24 / duration)) : 12;
      const okRun = await runOk(ffmpeg, [
        '-y',
        '-ignore_loop', '0',
        '-i', tmpIn,
        '-vf', `fps=${fps.toFixed(3)},scale='min(${GIF_VIDEO_MAX_DIM},iw)':'min(${GIF_VIDEO_MAX_DIM},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      '-frames:v', String(GIF_VIDEO_MAX_FRAMES),
      '-an',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      tmpOut
    ], 45000);
    if (!okRun || !fs.existsSync(tmpOut)) return null;
    const out = fs.readFileSync(tmpOut);
    // 产出为空或大得离谱（>8MB）都视为异常：正常 480px/24帧 的 mp4 不会超过几百 KB
    if (!out.length || out.length > 8 * 1024 * 1024) return null;
    const dims = await probeVideoSize(tmpOut);
    return {
      dataUrl: `data:video/mp4;base64,${out.toString('base64')}`,
      frames: Math.min(GIF_VIDEO_MAX_FRAMES, Math.max(1, Math.round(duration > 0 ? Math.min(duration * fps, GIF_VIDEO_MAX_FRAMES) : GIF_VIDEO_MAX_FRAMES))),
      width: dims?.width || 0,
      height: dims?.height || 0
    };
  } catch {
    return null;
  } finally {
    try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

/** ffprobe 读时长（秒）；没有 ffprobe / 读不出返回 0。 */
async function probeDuration(file) {
  const txt = await runStdout('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_format', file
  ], 10000);
  if (!txt) return 0;
  try {
    return Number(JSON.parse(txt)?.format?.duration) || 0;
  } catch {
    return 0;
  }
}

/** ffprobe 读输出视频的宽高；读不出返回 null。 */
async function probeVideoSize(file) {
  const txt = await runStdout('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', file
  ], 10000);
  if (!txt) return null;
  try {
    const s = (JSON.parse(txt).streams || []).find((x) => x.codec_type === 'video');
    return s?.width ? { width: Number(s.width), height: Number(s.height) } : null;
  } catch {
    return null;
  }
}

/** 调外部命令并收集 stdout；失败/超时返回 null。 */
function runStdout(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => { clearTimeout(timer); finish(out || null); });
  });
}

/**
 * 当前配置下 GIF 应该走哪条路。**纯函数**，便于测试。
 *
 * 规则矩阵（2026-09-19 按用户定稿重写；vision = api.vision，video = api.video）：
 *   vision=F, video=F → 'image'      所有图片（含动图）按 [图片] 占位符（看图工具整体不存在）
 *   vision=T, video=F → 'gif-image'  GIF 直接按图片发（读不了 GIF 的模型报错时，由调用方取首帧重试）
 *   vision=F, video=T → 'image'      图片输入没开：视频输入只管视频，图片一律占位符
 *   vision=T, video=T → 'video'      GIF 转 mp4 按 video 部件发（llm.js 自动切 videoModel）
 *
 * @returns {'video'|'gif-image'|'image'}
 */
export function resolveGifRoute({ vision = true, video = false } = {}) {
  if (!vision) return 'image';        // 看图工具不存在，谈不上 GIF 选路
  if (video) return 'video';          // 图片+视频都开：动图转视频
  return 'gif-image';                 // 只开图片：动图按图发，报错降级到首帧
}

/**
 * GIF 首帧提取：把动图的第一帧转成静态 PNG/JPEG 的 dataUrl。
 * 用途：resolveGifRoute 走 'gif-image' 时，模型/网关读不了 GIF 报错的**降级重试**——
 * "报错则取首帧输入模型，此流程写进代码而不靠模型调用"（用户定稿）。
 * 提取失败（没 ffmpeg / 文件异常）返回 null，调用方退回原样发送。
 */
export async function gifFirstFrameDataUrl(buffer) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return null;
  const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpIn = path.join(os.tmpdir(), `qqa_gif1_in_${stamp}.gif`);
  const tmpOut = path.join(os.tmpdir(), `qqa_gif1_out_${stamp}.png`);
  try {
    fs.writeFileSync(tmpIn, buffer);
    // -frames:v 1 只解码第一帧；scale 压到 ≤768px（静态帧没必要更大，省 token）
    const okRun = await runOk(ffmpeg, [
      '-y',
      '-ignore_loop', '0',
      '-i', tmpIn,
      '-vf', "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease",
      '-frames:v', '1',
      '-an',
      tmpOut
    ], 20000);
    if (!okRun || !fs.existsSync(tmpOut)) return null;
    const out = fs.readFileSync(tmpOut);
    if (!out.length || out.length > 4 * 1024 * 1024) return null;
    return `data:image/png;base64,${out.toString('base64')}`;
  } catch {
    return null;
  } finally {
    try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}
