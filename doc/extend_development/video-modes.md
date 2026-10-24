# 视频理解：两条路怎么选

## 结论

**两条路互斥，二选一**，由设置页的「视频理解方式」决定：

| 值 | 行为 |
|---|---|
| `auto`（默认） | 配了「视频输入专用模型」→ 原生读视频；否则抽帧；抽帧不可用 → 只给元信息 |
| `native` | 强制把视频直接交给全模态模型 |
| `frames` | 强制抽帧成图片 |
| `off` | 只读时长/分辨率等元信息，不喂画面 |

## 为什么不能两条一起喂

1. **重复计费**：同一段内容既当视频又当图片发一遍，token 翻倍。
2. **格式冲突**：多数 OpenAI 兼容网关不接受一条消息里同时出现 `video_url` 和 `image_url`，
   会直接 400。
3. **语义重复**：模型看到同一段内容两种呈现，容易过度描述。

所以是刻意互斥，不是偷懒。

## 职责分层

| 层 | 负责 | 位置 |
|---|---|---|
| 选哪条路 | `auto/native/frames/off` 的判定 | `src/video-reader.js` 的 `resolveVideoRoute()`（纯函数） |
| 用哪个模型 | 检测到视频部分就切 `api.videoModel` | `src/llm.js` 的 `specializedModelFor()` |
| 怎么抽帧 | ffmpeg 调用、帧数/尺寸/质量 | `skills/video-frames`（能力 `video.frames`） |
| 组装消息 | 把画面拼成正确的 parts | `src/tools.js` 的 `read_video` + `src/orchestrator.js` |

抽帧做成 Skill 的理由：ffmpeg 是外部程序（装没装、装在哪都看环境），
抽几帧/多大/什么质量是口味问题，而这些都不该写死在核心里。
**关掉这个 Skill 就自动退回"只读元信息"**，不会报错。

## 原生视频输入的现状（重要）

OpenAI 兼容的**视频输入没有统一标准**，各家格式不同：

| 厂商 | 格式 |
|---|---|
| Gemini 兼容端点 | `file_data` / `video_url` |
| Qwen-VL | `video_url` |
| OpenRouter | 部分模型透传 `video_url` |
| GPT-4o 系列 | 实际上仍是**逐帧当图片**，没有真正的 video 部分 |
| 多数中转网关 | 不认识 `video_url`，会 400 |

本项目采用 `{ type: 'video_url', video_url: { url } }`，**由配置显式开启**（`videoMode: native`
或填了 `videoModel`）。为什么不由代码猜：

- 维护一张"哪些模型支持视频"的表必然滞后且不准；
- 猜错的代价是请求直接 400，比"没启用"更糟。

所以规则是：**你填了 `videoModel` = 你声明"我有能读视频的模型"**，核心不猜。

如果 native 被网关拒绝：把「视频理解方式」改成 `frames` 即可。这是已知的、需要人工切换的场景。

## 为什么不让 ffmpeg 直接读 URL

社区版的做法是 `ffmpeg -ss 30 -i https://...`，只拉真正需要的那几段字节
（10 分钟视频取 4 帧只传几百 KB，而不是几十 MB），确实省流量。

**但那有 SSRF 缺口**：URL 来自 OneBot 消息段（发送方可影响），ffmpeg 会自己解析 DNS 并连接，
我们没有任何机会做内网校验 —— 让群友发一条"视频链接"就能让宿主去探内网端口。

所以本项目坚持：先经 `safe-fetch` 校验并落地成文件，再对本地文件抽帧。
代价是下载整个视频（上限 200MB），换来的是不能被当跳板。

## 相关配置

```jsonc
{
  "api": {
    "model": "cheap-text-model",        // 日常聊天用便宜的纯文本模型
    "visionModel": "qwen-vl-max",       // 有图片的请求自动切到这个
    "videoModel": "gemini-2.5-pro",     // 有视频的请求自动切到这个（并启用原生视频输入）
    "videoMode": "auto"
  }
}
```

> 历史遗留说明：`visionModel` / `videoModel` 曾经**只是存下来给 UI 看**，
> 没有任何代码读取 —— 填了不起作用。现在检测到对应模态时会真的切模型
> （仅主调用路径；记忆整理与备选模型降级不受影响）。
