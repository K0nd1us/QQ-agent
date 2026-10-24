// 视频读取：探测视频元信息（时长/分辨率/大小/格式），并按配置决定怎么让模型"看"到画面。
//
// ── 两条路线（互斥，由 config.api.videoMode 决定）──────────────────────
//   native 全模态模型直接读视频：把视频地址作为 video 部分发给模型。
//          由设置页的「视频输入专用模型」声明"我有这种模型"，核心不猜。
//   frames 抽帧：把视频变成若干张图片，任何视觉模型都能用。
//          实现放在 `skills/video-frames`（capability `video.frames`），
//          本模块通过能力名取用 —— 关掉 Skill 就自动退回"只给元信息"。
//
// 为什么不两条一起喂：同一段内容重复计费，而且视频部分和图片部分混在一起
// 多数网关会因格式冲突直接 400。二选一是刻意的设计，不是偷懒。
//
// 探测元信息本身是**尽力而为**的：NapCat/SnowLuma 的视频缓存不一定在，
// ffprobe/ffmpeg 也不一定装了。每一步失败都降级，绝不抛出让模型看到一串技术错误。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DATA_DIR, getConfig } from './config.js';
import { safeFetchBinaryToFile } from './safe-fetch.js';
import { skillManager } from './skills/manager.js';

/** 允许的抽帧模式取值（配置写错时回退 auto）。 */
export const VIDEO_MODES = ['auto', 'native', 'frames', 'off'];

function videoCacheDir() {
  return path.join(DATA_DIR, 'video-cache');
}

/**
 * 决定这次视频走哪条路。**纯函数**，方便测试与在 UI 里预览判定结果。
 *
 * @param {object} o
 *   mode       config.api.videoMode
 *   videoModel config.api.videoModel（非空 = 用户声明有全模态模型）
 *   framesOk   抽帧能力是否可用
 *   hasUrl     视频是否有可用的 http(s) 地址（native 需要）
 * @returns {{ route: 'native'|'frames'|'meta', reason: string }}
 */
export function resolveVideoRoute({ mode = 'auto', videoModel = '', framesOk = false, hasUrl = false } = {}) {
  const m = VIDEO_MODES.includes(String(mode)) ? String(mode) : 'auto';
  const omni = Boolean(String(videoModel || '').trim());

  if (m === 'off') return { route: 'meta', reason: 'videoMode=off：只读元信息，不喂画面' };

  if (m === 'native') {
    return hasUrl
      ? { route: 'native', reason: 'videoMode=native：按原生视频输入发送' }
      : { route: 'meta', reason: 'videoMode=native，但这条视频没有可用的 http(s) 地址' };
  }

  if (m === 'frames') {
    return framesOk
      ? { route: 'frames', reason: 'videoMode=frames：抽帧成图片' }
      : { route: 'meta', reason: 'videoMode=frames，但抽帧不可用（未见 ffmpeg 或 Skill 已关闭）' };
  }

  // auto：配了全模态模型就原生，否则抽帧，都不行只给元信息
  if (omni && hasUrl) return { route: 'native', reason: 'auto：已配置视频专用模型，按原生视频输入发送' };
  if (framesOk) return { route: 'frames', reason: 'auto：未配置视频专用模型，改用抽帧' };
  return { route: 'meta', reason: 'auto：既没有视频专用模型，抽帧也不可用，只读元信息' };
}

/** 调外部命令并收集 stdout（带超时）。 */
function run(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
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

/** 调外部命令，只看退出码（带超时）。转码这类"不关心 stdout"的命令用它。 */
function runExitOk(cmd, args, timeoutMs = 60000) {
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

/** 探测 ffprobe / ffmpeg 是否可用（缓存结果；都没找到时 60 秒后允许重探）。 */
let _ffprobePath = null;
let _ffmpegPath = null;
let _ffChecked = false;
let _ffCheckedAt = 0;
const FF_RETRY_MS = 60000;
async function ensureFf() {
  // 任一找到就长期缓存；都没找到（用户可能随后安装）60 秒后重探，免重启
  if (_ffChecked && (_ffprobePath || _ffmpegPath)) return { ffprobe: _ffprobePath, ffmpeg: _ffmpegPath };
  if (_ffChecked && Date.now() - _ffCheckedAt < FF_RETRY_MS) return { ffprobe: _ffprobePath, ffmpeg: _ffmpegPath };
  _ffChecked = true;
  _ffCheckedAt = Date.now();
  // 常见位置：PATH 里的 ffprobe/ffmpeg
  for (const name of ['ffprobe', 'ffprobe.exe']) {
    const r = await run(name, ['-version'], 5000);
    if (r) { _ffprobePath = name; break; }
  }
  for (const name of ['ffmpeg', 'ffmpeg.exe']) {
    const r = await run(name, ['-version'], 5000);
    if (r) { _ffmpegPath = name; break; }
  }
  return { ffprobe: _ffprobePath, ffmpeg: _ffmpegPath };
}

export class VideoReader {
  constructor(onebot) {
    this.onebot = onebot;
  }

  /** 抽帧能力是否可用（Skill 生效 + ffmpeg 存在）。 */
  async framesAvailable() {
    // 统一问 video-frames 能力"这条路现在走得通吗"。
    // 不要在这里再探测一遍 ffmpeg —— 技能里已有一份判断，两份实现迟早不一致
    // （例如技能支持自定义 ffmpeg 路径，这里却不知道，于是界面说不可用、实际能用）。
    const providers = skillManager.getCapabilityProviders('video.frames.available', {});
    if (!providers.length) return false;   // 技能被关或没装 → 这条路不通
    for (const p of providers) {
      try {
        const r = await p.fn({});
        if (r?.ok === false) return false;
        if (r?.ok === true) return true;
      } catch { /* 探测异常按不可用处理 */ }
    }
    return false;
  }

  /** 当前配置下这条视频会走哪条路（UI 展示 / 排障用）。 */
  async describeRoute(media = {}) {
    const cfg = getConfig();
    const framesOk = await this.framesAvailable();
    const hasUrl = /^https?:\/\//i.test(String(media?.url || ''));
    return resolveVideoRoute({
      mode: cfg.api?.videoMode,
      videoModel: cfg.api?.videoModel,
      framesOk,
      hasUrl
    });
  }

  /**
   * 探测一个视频媒体（{ file, url, path }）的元信息，并按配置取回画面。
   *
   * @returns {Promise<{durationSec?, width?, height?, sizeBytes?, format?,
   *                    route: 'native'|'frames'|'meta', routeReason: string,
   *                    frames?: string[], frameTimes?: number[],
   *                    nativeUrl?: string, note: string}>}
   */
  async probe(media, { count = 0 } = {}) {
    const cfg = getConfig();
    const out = { note: '', route: 'meta', routeReason: '' };

    // 1. 拿到视频文件（本地缓存优先，其次下载 url）
    const filePath = await this.#localize(media).catch(() => null);
    const hasFile = Boolean(filePath && fs.existsSync(filePath));

    if (hasFile) {
      try {
        out.sizeBytes = fs.statSync(filePath).size;
      } catch { /* ignore */ }
      // 2. ffprobe 读元信息
      const { ffprobe } = await ensureFf();
      if (ffprobe) {
        const meta = await this.#ffprobe(ffprobe, filePath);
        Object.assign(out, meta);
      }
    }

    // 3. 决定路线（元信息拿到之后再决定，因为 native 需要 url、frames 需要文件）
    const framesOk = hasFile && await this.framesAvailable();
    const hasUrl = /^https?:\/\//i.test(String(media?.url || ''));
    const routeInfo = resolveVideoRoute({
      mode: cfg.api?.videoMode,
      videoModel: cfg.api?.videoModel,
      framesOk,
      hasUrl
    });
    out.route = routeInfo.route;
    out.routeReason = routeInfo.reason;

    // 4. 按路线取画面
    if (routeInfo.route === 'native') {
      // 用户定稿规则 5（2026-09-19）：视频输入开启时，所有视频转码成
      // 最高 480p/24fps 的 mp4 再发给模型 —— 原始视频可能是 1080p/60fps 的
      // 几十 MB 文件，直接喂会把 token 预算炸穿（甚至被网关拒收）。
      // 转码失败（没 ffmpeg / 超时 / 产出异常）回退原 URL，不阻塞看视频。
      if (cfg.api?.video === true) {
        const transcoded = hasFile ? await this.#transcodeToMax480(filePath).catch(() => null) : null;
        if (transcoded) {
          out.nativeUrl = transcoded;
          out.routeReason += '；已转码 ≤480p/24fps';
        } else {
          out.nativeUrl = String(media.url);
        }
      } else {
        out.nativeUrl = String(media.url);
      }
    } else if (routeInfo.route === 'frames') {
      const r = await this.#extractViaSkill(filePath, { count, durationSec: out.durationSec });
      if (r.frames.length) {
        out.frames = r.frames;
        out.frameTimes = r.times;
      } else {
        // 抽帧失败不当错误抛：退回元信息，并在 note 里说清
        out.route = 'meta';
        out.routeReason = `${routeInfo.reason}；但抽帧未成功：${r.error || '未知原因'}`;
      }
    }

    out.note = this.#buildNote(out, { hasFile });
    return out;
  }

  /** 说明文案：让模型知道它拿到的是什么形式的内容。 */
  #buildNote(out, { hasFile }) {
    if (!hasFile) {
      return '无法获取视频文件（OneBot 无缓存且 url 下载失败）。只能告诉你这条消息带了一个视频。';
    }
    const bits = [];
    if (out.durationSec) bits.push(`时长 ${out.durationSec.toFixed(1)} 秒`);
    if (out.width && out.height) bits.push(`${out.width}×${out.height}`);
    if (out.sizeBytes) bits.push(`${(out.sizeBytes / 1024 / 1024).toFixed(1)}MB`);
    const head = bits.length ? `视频信息：${bits.join('，')}。` : '已获取视频文件，但读不到详细元信息（未安装 ffprobe）。';

    if (out.route === 'native') {
      return `${head}画面已作为**视频**发给多模态模型（原生视频输入）。`;
    }
    if (out.route === 'frames' && out.frames?.length) {
      return `${head}已从中抽取 ${out.frames.length} 张画面截图供你查看。注意这是截图不是连续视频，帧与帧之间的过程你看不到。`;
    }
    if (out.route === 'meta') {
      const why = out.routeReason || '当前配置不喂画面';
      return `${head}本次不提供画面（${why}）。`;
    }
    return head;
  }

  /** 通过 video.frames 能力抽帧；能力不在（Skill 被关）时返回空。 */
  async #extractViaSkill(filePath, { count = 0, durationSec = 0 } = {}) {
    const providers = skillManager.getCapabilityProviders('video.frames', {});
    if (!providers.length) return { frames: [], times: [], error: '抽帧 Skill 未启用' };
    for (const p of providers) {
      try {
        const r = await p.fn({ filePath, count: count || undefined, durationSec });
        if (r && Array.isArray(r.frames) && r.frames.length) {
          return { frames: r.frames, times: r.times || [] };
        }
        if (r?.error) return { frames: [], times: [], error: r.error };
      } catch (error) {
        return { frames: [], times: [], error: error?.message ?? String(error) };
      }
    }
    return { frames: [], times: [], error: '抽帧没有产出画面' };
  }

  /**
   * 转码到模型友好规格：最长边 ≤480px、24fps、H.264+yuv420p、faststart。
   * 返回 data:video/mp4;base64 URL；失败返回 null（调用方回退原 URL）。
   * 与 gif-to-video 的转换互不复用：那边处理的是 GIF 的帧采样防炸弹，
   * 这边处理的是常规视频的降规格，参数与护栏各不相同。
   */
  async #transcodeToMax480(filePath) {
    const { ffmpeg } = await ensureFf();
    if (!ffmpeg) return null;
    const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const tmpOut = path.join(os.tmpdir(), `qqa_vt_${stamp}.mp4`);
    try {
      // 产物大小护栏：≤480p/24fps 的短视频通常 <10MB；20MB 上限给长视频留余地，
      // 超过说明源异常长，喂模型不划算（元信息里有时长，模型自己判断要不要看）。
      const okRun = await runExitOk(ffmpeg, [
        '-y',
        '-i', filePath,
        // force_divisible_by=2：yuv420p/libx264 只吃偶数宽高，奇数尺寸源（部分
        // 手机竖拍视频）会直接 "Error while opening encoder" 转码失败（见 gif-to-video 同款注释）
        '-vf', "scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=24",
        '-an',                       // 聊天视频的画面理解不需要音轨
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-fs', '20M',
        tmpOut
      ], 120000);
      if (!okRun || !fs.existsSync(tmpOut)) return null;
      const out = fs.readFileSync(tmpOut);
      if (!out.length || out.length > 20 * 1024 * 1024) return null;
      return `data:video/mp4;base64,${out.toString('base64')}`;
    } catch {
      return null;
    } finally {
      try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* ignore */ }
    }
  }

  /** 把视频落地为本地文件路径（OneBot 缓存 → 下载 url）。 */
  async #localize(media) {
    // 路径 0：消息里直接给了本地 path
    if (media.path && fs.existsSync(String(media.path))) return String(media.path);
    // 路径 1：OneBot get_video / get_file 拿缓存
    if (media.file) {
      for (const action of ['get_video', 'get_file', 'get_image']) {
        try {
          const ret = await this.onebot.call(action, { file: String(media.file) });
          const p = ret?.file && fs.existsSync(String(ret.file)) ? String(ret.file) : '';
          if (p) return p;
          if (ret?.url) {
            const dl = await this.#download(String(ret.url));
            if (dl) return dl;
          }
        } catch { /* 尝试下一个 action */ }
      }
    }
    // 路径 2：直接下载 url
    if (media.url) {
      const dl = await this.#download(String(media.url));
      if (dl) return dl;
    }
    throw new Error('无法获取视频文件');
  }

  async #download(url, timeoutMs = 30000) {
    try {
      // 走 safe-fetch：url 来自 OneBot 媒体段（发送方可影响），裸 fetch 会变成 SSRF 通道。
      // 流式落盘（safeFetchBinaryToFile）：整读 200MB 进内存再写盘，多视频并发
      // 时进程直接被顶爆；边收边写盘后内存占用与视频大小无关（2026-09-19 M8）。
      const maxBytes = 200 * 1024 * 1024;   // 视频上限 200MB
      fs.mkdirSync(videoCacheDir(), { recursive: true });
      // 文件名带随机后缀：同毫秒并发下载不能互相覆盖
      const dest = path.join(videoCacheDir(), `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.mp4`);
      // 超限/截断语义与旧实现一致：safeFetchBinaryToFile 在累计字节到达 maxBytes
      // 时删掉半截文件并抛错（残缺的 mp4 没法抽帧，不能让 ffprobe 报误导性元信息），
      // 这里接住异常返回 null，让上层按"拿不到文件"降级。
      await safeFetchBinaryToFile(String(url), dest, maxBytes, { timeoutMs });
      return dest;
    } catch {
      return null;
    }
  }

  async #ffprobe(ffprobe, filePath) {
    const out = {};
    const txt = await run(ffprobe, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath
    ], 15000);
    if (!txt) return out;
    try {
      const j = JSON.parse(txt);
      const vstream = (j.streams || []).find((s) => s.codec_type === 'video');
      if (vstream) {
        if (vstream.width) out.width = Number(vstream.width);
        if (vstream.height) out.height = Number(vstream.height);
      }
      if (j.format) {
        if (j.format.duration) out.durationSec = Number(j.format.duration);
        if (j.format.format_name) out.format = String(j.format.format_name);
        if (j.format.size) out.sizeBytes = Number(j.format.size);
      }
    } catch { /* 解析失败就返回空 */ }
    return out;
  }
}
