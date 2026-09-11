# 内置模型价格表（完整导出）

> 由 `src/model-prices.js` 导出（`node scripts/export-prices-md.mjs`，非手写），数据核对时间 2026-09-11  
> 单位：**元 / 每百万 token**。美元价按 1 USD ≈ 7.2 CNY 换算。

共 **140** 条：**42** 条官方直取（official），**98** 条二手折算（derived）。

| 标记 | 含义 |
|---|---|
| `official` | 厂商官方定价文档/价格页直接取到，人民币原价照录 |
| `derived` | 官方页未能直连，按官方公告与可信转载折算，仅供参考 |
| 峰谷 ✓ | 分时段计价，高峰 = 闲时 ×2（前三列取闲时价） |
| 图片 | 图片输入 token 换算规则 |

## DeepSeek（10 条，8 条 official）

| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |
|---|---|---|---|---|---|---|---|
| `deepseek-flash` | 1 | 4 | 0.02 | ✓ 2 / 8 | 封顶 1024/张 | official | 闲时价；高峰翻倍；DeepSeek-V4.1-Flash；支持思考/非思考双模式、图片理解、工具调用、JSON 输出；1M 上下文 / 384K 输出 |
| `deepseek-v4-flash` | 1 | 4 | 0.02 | ✓ 2 / 8 | 封顶 1024/张 | official | 旧模型名（底座已下线，由 V4.1-Flash 承接），按 Flash 价计费；图片/工具/JSON 均可用 |
| `deepseek-v4-flash-vision-exp` | 1 | 4 | 0.02 | ✓ 2 / 8 | 封顶 1024/张 | official | 旧视觉模型名（已下线，由 V4.1-Flash 承接），按 Flash 价计费 |
| `deepseek-v4-flash-0731` | 1 | 4 | 0.02 | ✓ 2 / 8 | — | official | 闲时价；高峰翻倍；日期快照版，无图片输入 |
| `deepseek-chat` | 1 | 4 | 0.02 | ✓ 2 / 8 | 封顶 1024/张 | official | 旧别名，实测回落 deepseek-flash（非思考模式），按 Flash 价计费；支持图片输入 |
| `deepseek-reasoner` | 1 | 4 | 0.02 | ✓ 2 / 8 | 封顶 1024/张 | official | 旧别名，实测回落 deepseek-flash（思考模式），按 Flash 价计费；支持图片输入 |
| `deepseek-v4-pro` | 4.5 | 13.5 | 0.15 | ✓ 9 / 27 | — | official | 闲时价；高峰翻倍；纯文本（实测带图回"无法查看图片"）；⚠️ 2026-09-14 12:00 后路由到 V4.1-Flash 并按 Flash 价计费 |
| `deepseek-v4-pro-0813` | 4.5 | 13.5 | 0.15 | ✓ 9 / 27 | — | official | 闲时价；高峰翻倍；纯文本；日期快照版 |
| `deepseek-v3.1-terminus` | 1 | 4 | 0.02 | ✓ 2 / 8 | — | derived | 旧代，取下线价近似（原价 1.5/4.5） |
| `deepseek-r1-0528` | 4.5 | 13.5 | 0.15 | — | — | derived | 旧代，按 v4-pro 现价近似 |

## 智谱 Z.ai / GLM（19 条，全部 official）

| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |
|---|---|---|---|---|---|---|---|
| `glm-5.3` | 8 | 28 | 2 | — | — | official | 1M 上下文；缓存存储限时免费 |
| `glm-5.3-flash` | 0.4 | 1.4 | 0.115 | — | — | official | 促销价；原价 0.8/1.4/0.23（输入与缓存五折，输出不打折） |
| `glm-5.2` | 8 | 28 | 2 | — | — | official | 1M 上下文 |
| `glm-5.1` | 6 | 24 | 1.3 | — | — | official | ≤32K 档；>32K 为 8/28/2 |
| `glm-5-turbo` | 5 | 22 | 1.2 | — | — | official | ≤32K 档；>32K 为 7/26/1.8 |
| `glm-5` | 4 | 18 | 1 | — | — | official | ≤32K 档；>32K 为 6/22/1.5 |
| `glm-5v-turbo` | 5 | 22 | 1.2 | — | 支持图片输入，换算规则待补 | official | 多模态；>32K 为 7/26/1.8 |
| `glm-4.7` | 2 | 8 | 0.4 | — | — | official | ≤32K 且输出<0.2K；其余档更高 |
| `glm-4.7-flash` | 0 | 0 | 0 | — | — | official | 官方免费 |
| `glm-4.7-flashx` | 0.5 | 3 | 0.1 | — | — | official | 200K 上下文 |
| `glm-4.6` | 4 | 16 | 0.8 | — | — | official | 按 4.7 同档近似 |
| `glm-4.5` | 4 | 16 | 0.8 | — | — | official | 按 4.7 同档近似 |
| `glm-4.5-air` | 0.8 | 2 | 0.16 | — | — | official | ≤32K 且输出<0.2K |
| `glm-4.6v` | 1 | 3 | 0.2 | — | 支持图片输入，换算规则待补 | official | ≤32K；32-128K 为 2/6/0.4 |
| `glm-4.6v-flashx` | 0.15 | 1.5 | 0.03 | — | 支持图片输入，换算规则待补 | official | ≤32K |
| `glm-4.5v` | 2 | 6 | 0.4 | — | 支持图片输入，换算规则待补 | official | ≤32K；32-64K 为 4/12/0.8 |
| `glm-4-plus` | 5 | 5 | — | — | — | official | 旧代 GLM-4 系列 |
| `glm-4-long` | 1 | 1 | — | — | — | official | 旧代，1M 上下文 |
| `glm-4-flash` | 0 | 0 | 0 | — | — | official | 官方免费 |

## 月之暗面 Kimi / Moonshot（4 条，全部 derived）

| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |
|---|---|---|---|---|---|---|---|
| `kimi-k3` | 20 | 100 | 2 | — | 支持图片输入，换算规则待补 | derived | 缓存命中率>90% 时实际成本低得多 |
| `kimi-k2.7-code` | 20 | 100 | 2 | — | — | derived | 编程版，按 K3 档近似 |
| `kimi-k2.6` | 8 | 32 | 1 | — | 支持图片输入，换算规则待补 | derived | 旧代，按美元价折算 |
| `kimi-k2` | 4.32 | 14.4 | 0.5 | — | — | derived | 旧代 |

## MiniMax（9 条，全部 official）

| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |
|---|---|---|---|---|---|---|---|
| `minimax-m3` | 2.1 | 8.4 | 0.42 | — | 支持图片输入，换算规则待补 | official | ≤512K 五折价；>512K 为 4.2/16.8/0.84 |
| `minimax-m2.7` | 2.1 | 8.4 | 0.42 | — | — | official | 缓存写入 2.625 |
| `minimax-m2.7-highspeed` | 4.2 | 16.8 | 0.42 | — | — | official | 高速版，缓存写入 2.625 |
| `minimax-m2.5` | 2.1 | 8.4 | 0.21 | — | — | official | 缓存写入 2.625 |
| `minimax-m2.5-highspeed` | 4.2 | 16.8 | 0.21 | — | — | official | 高速版 |
| `minimax-m2.1` | 2.1 | 8.4 | 0.21 | — | — | official | 缓存写入 2.625 |
| `minimax-m2.1-highspeed` | 4.2 | 16.8 | 0.21 | — | — | official | 高速版 |
| `minimax-m2` | 2.1 | 8.4 | 0.21 | — | — | official | 缓存写入 2.625 |
| `minimax-m1` | 2.1 | 8.4 | 0.21 | — | — | official | 旧代，按现价近似 |

## 小米 MiMo（4 条，全部 derived）

| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |
|---|---|---|---|---|---|---|---|
| `mimo-v2.5` | 1 | 2 | 0.02 | — | 支持图片输入，换算规则待补 | derived | 对标 DeepSeek V4-Flash 同档 |
| `mimo-v2.5-pro` | 3 | 6 | 0.025 | — | 支持图片输入，换算规则待补 | derived | 对标 DeepSeek V4-Pro 同档 |
| `mimo-v2.5-pro-ultraspeed` | 9 | 18 | 0.075 | — | — | derived | 极速版，为 Pro 版 3 倍价 |
| `mimo-v2.5-flash` | 0.72 | 2.16 | — | — | — | derived | 轻量档，按美元价折算（$0.10/$0.30） |

## 阿里通义千问（18 条，全部 derived）

| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |
|---|---|---|---|---|---|---|---|
| `qwen3.8-max` | 14.4 | 43.2 | 3.6 | — | h×w/1024+2，上限 1600 万像素/图 | derived | 1M 上下文；旗舰档 |
| `qwen3.8-max-0902` | 14.4 | 43.2 | 3.6 | — | h×w/1024+2，上限 1600 万像素/图 | derived | 1M 上下文 |
| `qwen3.8-flash` | 0.94 | 3.1 | 0.115 | — | h×w/1024+2，上限 1600 万像素/图 | derived | 1M 上下文；轻量主力（$0.13/$0.43） |
| `qwen3.7-max` | 9 | 27 | — | — | 支持图片输入，换算规则待补 | derived | 按 $1.25/$3.75 折算 |
| `qwen3.7-plus` | 2.3 | 9 | 0.23 | — | h×w/1024+2，上限 1600 万像素/图 | derived | 1M 上下文；均衡主力（$0.32/$1.25） |
| `qwen3.7-plus-2026-05-26` | 2.3 | 9 | 0.23 | — | 支持图片输入，换算规则待补 | derived | 快照版 |
| `qwen3.7-flash` | 0.29 | 1.15 | — | — | h×w/1024+2，上限 1600 万像素/图 | derived | 1M 上下文（$0.04/$0.16） |
| `qwen3.6-flash` | 1.37 | 8.14 | 0.137 | — | h×w/1024+2，上限 1600 万像素/图 | derived | 按 $0.19/$1.13 折算 |
| `qwen3.5-plus` | 2.88 | 12.96 | — | — | 支持图片输入，换算规则待补 | derived | 旧代 |
| `qwen3.5-397b-a17b` | 4.32 | 25.92 | — | — | — | derived | 开源大尺寸 |
| `qwen3-235b-a22b` | 1.44 | 5.76 | — | — | — | derived | 开源 |
| `qwen3-235b-a22b-thinking-2507` | 2.16 | 21.6 | — | — | — | derived | 思考版 |
| `qwen3-coder-plus` | 4 | 20 | — | — | — | derived | 编程版，≤32K 档 |
| `qwen-plus` | 5.76 | 14.4 | — | — | — | derived | 旧代 |
| `qwen-max` | 14.4 | 43.2 | — | — | — | derived | 映射到 3.8-Max 档 |
| `qwen-flash` | 0.29 | 1.15 | — | — | — | derived | 映射到 3.7-Flash 档 |
| `qwen-turbo` | 2.16 | 4.32 | — | — | — | derived | 旧代 |
| `qwen-long` | 3.6 | 14.4 | — | — | — | derived | 10M 上下文 |

## 腾讯混元（8 条，6 条 official）

| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |
|---|---|---|---|---|---|---|---|
| `hunyuan-a13b` | 0.5 | 2 | — | — | — | official | 腾讯云刊例价 |
| `hunyuan-role-latest` | 2.4 | 9.6 | — | — | — | official | 腾讯云刊例价 |
| `hunyuan-translation` | 1.2 | 3.6 | — | — | — | official | 翻译模型 |
| `hunyuan-translation-lite` | 1 | 3 | — | — | — | official | 翻译轻量版 |
| `hunyuan-embedding` | 0.7 | 0.7 | — | — | — | official | 向量模型 |
| `hy4-preview` | 6 | 18 | 0.3 | — | — | derived | 960K 输入 / 64K 输出 |
| `hy3` | 1.15 | 4.6 | 0.29 | — | — | derived | 262K 上下文，按美元价折算（$0.16/$0.64） |
| `hunyuan` | 0.5 | 2 | — | — | — | official | 映射到 a13b 档（腾讯云官方刊例） |

## 字节豆包（2 条，全部 derived）

| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |
|---|---|---|---|---|---|---|---|
| `doubao-pro` | 3.2 | 7.2 | — | — | — | derived | 旗舰档 |
| `doubao-lite` | 0.54 | 1.44 | — | — | — | derived | 轻量档 |

## 百度文心（2 条，全部 derived）

| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |
|---|---|---|---|---|---|---|---|
| `ernie-5.0` | 8.64 | 25.92 | — | — | — | derived | 旗舰档 |
| `ernie-4.5` | 2.88 | 8.64 | — | — | — | derived | 旧代 |

## OpenAI GPT-5.6 系列（21 条，全部 derived）

| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |
|---|---|---|---|---|---|---|---|
| `gpt-5.6-sol` | 28.8 | 144 | 2.88 | — | 支持图片输入，换算规则待补 | derived | 促销价；长上下文 57.6/216 |
| `gpt-5.6-terra` | 14.4 | 86.4 | 1.44 | — | 支持图片输入，换算规则待补 | derived | 促销价；长上下文 28.8/129.6 |
| `gpt-5.6-luna` | 1.44 | 8.64 | 0.14 | — | 支持图片输入，换算规则待补 | derived | 促销价；长上下文 2.88/12.96 |
| `gpt-5.6-cyber` | 90 | 540 | 9 | — | — | derived | Daybreak 计划 |
| `gpt-5.5` | 36 | 216 | 3.6 | — | 支持图片输入，换算规则待补 | derived | 旧代旗舰 |
| `gpt-5.5-pro` | 216 | 1296 | — | — | — | derived | Pro 档 |
| `gpt-5.4` | 18 | 108 | 1.8 | — | 支持图片输入，换算规则待补 | derived | 旧代 |
| `gpt-5.4-mini` | 5.4 | 32.4 | 0.54 | — | — | derived | 旧代 |
| `gpt-5.4-nano` | 1.44 | 9 | 0.14 | — | — | derived | 旧代 |
| `gpt-5.2` | 12.6 | 100.8 | — | — | — | derived | 旧代 |
| `gpt-5.1` | 9 | 72 | — | — | — | derived | 旧代 |
| `gpt-5` | 9 | 72 | — | — | — | derived | 旧代 |
| `gpt-5-mini` | 1.8 | 14.4 | — | — | — | derived | 旧代 |
| `gpt-5-nano` | 0.36 | 2.88 | — | — | — | derived | 旧代 |
| `gpt-4.1` | 14.4 | 57.6 | 2.88 | — | 支持图片输入，换算规则待补 | derived | 旧代 |
| `gpt-4.1-mini` | 2.88 | 11.52 | 0.58 | — | — | derived | 旧代 |
| `gpt-4.1-nano` | 0.72 | 2.88 | 0.14 | — | — | derived | 旧代 |
| `gpt-4o` | 18 | 72 | — | — | 支持图片输入，换算规则待补 | derived | 旧代 |
| `gpt-4o-mini` | 1.08 | 4.32 | — | — | 支持图片输入，换算规则待补 | derived | 旧代 |
| `gpt-oss-120b` | 0.22 | 1.22 | — | — | — | derived | 开源权重 |
| `gpt-oss-20b` | 0.14 | 0.72 | — | — | — | derived | 开源权重 |

## Anthropic Claude（14 条，全部 derived）

| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |
|---|---|---|---|---|---|---|---|
| `claude-fable-5.1` | 72 | 360 | 1.8 | — | 支持图片输入，换算规则待补 | derived | 缓存读已降 75% |
| `claude-mythos-5.1` | 72 | 360 | 1.8 | — | — | derived | 受限供应 |
| `claude-fable-5` | 72 | 360 | 7.2 | — | — | derived | 旧版缓存贵 4 倍 |
| `claude-mythos-5` | 72 | 360 | 7.2 | — | — | derived | 受限供应 |
| `claude-opus-5` | 36 | 180 | 3.6 | — | 支持图片输入，换算规则待补 | derived | 1M 上下文，无长上下文档附加费 |
| `claude-opus-4.8` | 36 | 180 | 3.6 | — | — | derived | 旧代旗舰 |
| `claude-opus-4.7` | 36 | 180 | 3.6 | — | — | derived | 旧代 |
| `claude-opus-4.6` | 36 | 180 | 3.6 | — | — | derived | 旧代 |
| `claude-opus-4.5` | 36 | 180 | 3.6 | — | — | derived | 旧代 |
| `claude-opus-4.1` | 108 | 540 | — | — | — | derived | 已退役 |
| `claude-sonnet-5` | 14.4 | 72 | 1.44 | — | 支持图片输入，换算规则待补 | derived | 促销价已转正 |
| `claude-sonnet-4.6` | 21.6 | 108 | 2.16 | — | — | derived | 旧代 |
| `claude-haiku-4.5` | 7.2 | 36 | 0.72 | — | 支持图片输入，换算规则待补 | derived | 最便宜 |
| `claude-haiku-4.5-batch` | 3.6 | 18 | 0.36 | — | — | derived | Batch 五折 |

## Google Gemini（11 条，全部 derived）

| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |
|---|---|---|---|---|---|---|---|
| `gemini-3.8-flash` | 5.4 | 27 | 0.54 | — | 支持图片输入，换算规则待补 | derived | 促销价至 2026-12-31 |
| `gemini-3.7-flash` | 5.4 | 27 | 0.54 | — | 支持图片输入，换算规则待补 | derived | 促销价至 2026-12-31 |
| `gemini-3.6-flash` | 5.4 | 27 | 0.54 | — | 支持图片输入，换算规则待补 | derived | 促销价至 2026-12-31 |
| `gemini-3.5-flash` | 10.8 | 64.8 | 1.08 | — | — | derived | 原价档 |
| `gemini-3.5-flash-lite` | 2.16 | 18 | 0.22 | — | — | derived | 轻量档 |
| `gemini-3.1-pro` | 14.4 | 86.4 | 1.44 | — | 支持图片输入，换算规则待补 | derived | ≤200K；>200K 翻倍 |
| `gemini-3.1-flash-lite` | 1.8 | 10.8 | 0.18 | — | — | derived | 预览 |
| `gemini-3-flash` | 3.6 | 21.6 | 0.36 | — | — | derived | 预览 |
| `gemini-2.5-pro` | 9 | 72 | 0.9 | — | 支持图片输入，换算规则待补 | derived | 旧代 |
| `gemini-2.5-flash` | 2.16 | 18 | 0.22 | — | 支持图片输入，换算规则待补 | derived | 旧代 |
| `gemini-2.5-flash-lite` | 0.72 | 2.88 | 0.07 | — | — | derived | 旧代 |

## xAI Grok（3 条，全部 derived）

| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |
|---|---|---|---|---|---|---|---|
| `grok-4.6` | 14.4 | 43.2 | 3.6 | — | 支持图片输入，换算规则待补 | derived | ≥200K 输入翻倍 |
| `grok-4.5` | 21.6 | 64.8 | — | — | 支持图片输入，换算规则待补 | derived | 旧代 |
| `grok-4` | 21.6 | 64.8 | — | — | — | derived | 旧代 |

## Meta（5 条，全部 derived）

| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |
|---|---|---|---|---|---|---|---|
| `muse-spark-1.3` | 9 | 30.6 | — | — | — | derived | Contributor 档 0.72/1.44 |
| `muse-spark-1.2` | 9 | 30.6 | — | — | — | derived | Contributor 档 0.72/1.44 |
| `muse-spark-1.1` | 9 | 30.6 | — | — | — | derived | 旧代 |
| `llama-4-maverick` | 1.44 | 5.01 | — | — | — | derived | 开源权重 |
| `llama-3.3-70b` | 1.44 | 1.44 | — | — | — | derived | 开源权重 |

## 其他海外（10 条，全部 derived）

| 模型 id | 输入 | 输出 | 缓存命中 | 高峰价 | 图片 | 来源 | 备注 |
|---|---|---|---|---|---|---|---|
| `mistral-large-3` | 3.6 | 10.8 | — | — | — | derived |  |
| `mistral-medium-3.5` | 10.8 | 54 | — | — | — | derived |  |
| `command-a` | 18 | 72 | — | — | — | derived | Cohere |
| `nemotron-3-ultra` | 4.32 | 25.92 | — | — | — | derived | NVIDIA |
| `nemotron-3.5-lightning` | 0 | 0 | — | — | — | derived | 免费额度 |
| `solar-pro-4` | 0.22 | 0.86 | 0.043 | — | — | derived | Upstage |
| `step-3.7-flash` | 1.15 | 6.62 | — | — | — | derived | 阶跃星辰 |
| `longcat-2.0` | 2.16 | 8.64 | — | — | — | derived | 美团；促销 0.3/1.2 |
| `ling-3.0-flash` | 0.15 | 0.45 | 0.029 | — | — | derived | InclusionAI |
| `granite-4.0-h-micro` | 0.12 | 0.81 | — | — | — | derived | IBM；最便宜付费档 |
