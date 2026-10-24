// 内置「模型图片输入能力」官方资料表（仅图片，不含视频/音频）。
//
// 设计目标：
//   - 用户添加的模型 ID 只要与主流厂商官方模型 ID 对上（大小写/分隔符不敏感），
//     就无需在线探测，直接显示/判定“支持图片输入”或“不支持图片输入”。
//   - 判定分两级：
//       1) 提供商级结论 PROVIDER_DOCS：某条中转链路实际是否透传图片（网关可能拒绝）。
//       2) 模型级结论 MODEL_DOCS：模型厂商官方能力（OpenAI 兼容 image_url 输入）。
//   - 与 scripts/apply-vision-docs.mjs 的区别：本表是运行时代码内置的默认知识；
//     脚本/在线探测写入 config.modelVision 的结论仍优先于本表。
//
// 维护方式：新增模型时在 MODEL_DOCS 里加一行，providerId 有特殊链路时再加 PROVIDER_DOCS。
// 字段：verdict: 'vision' | 'no-vision'；note 里注明来源。

function norm(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// 模型 ID 归一：统一小写；斜杠前后都可匹配（如 deepseek-ai/deepseek-v4-pro-0813 与 deepseek-v4-pro-0813 等价）。
function modelKeys(model) {
  const m = norm(model).replace(/^\/+|\/+$/g, '');
  if (!m) return [];
  const keys = [m];
  const slash = m.lastIndexOf('/');
  if (slash >= 0 && slash < m.length - 1) keys.push(m.slice(slash + 1));
  return keys;
}

// ── 提供商级结论（链路是否透传图片） ─────────────────────────────────────
export const PROVIDER_DOCS = {
  'qwen-token-plan-cn|||qwen3.8-max': {
    verdict: 'vision',
    note: '官方：Qwen3.8-Max 为多模态旗舰，支持图片/视频输入（单图最高 1600 万像素）。来源：platform.qianwenai.com、help.aliyun.com/zh/model-studio/vision'
  },
  'xiaomi-token-plan-cn|||mimo-v2.5-pro': {
    verdict: 'no-vision',
    note: 'MiMo-V2.5-Pro 无原生视觉（GitHub XiaomiMiMo/MiMo-Code#309：pro image:false）；Token Plan 网关亦返回 "No endpoints found that support image input"。来源：github.com/XiaomiMiMo/MiMo-Code/issues/309'
  },
  'xiaomi|||mimo-v2.5-pro-ultraspeed': {
    verdict: 'vision',
    note: 'MiMo-V2.5 基座为原生全模态（图/视频/音频理解），官方提供图片理解 API 文档。来源：mimo.xiaomi.com/mimo-v2-5、mimo.mi.com/docs 图片理解'
  },
  'opencode-go|||deepseek-v4-flash': {
    verdict: 'vision',
    note: 'DeepSeek-V4-Flash 自 2026-09 起支持图片输入（官方视觉能力并入主模型，独立视觉模型 deepseek-v4-flash-vision-exp 仍保留）。来源：api-docs.deepseek.com/zh-cn/guides/vision + 官方 API 实测（2026-09-10，文档滞后：文档仍写仅 vision-exp 收图）'
  },
  'opencode-go|||deepseek-v4-pro': {
    verdict: 'no-vision',
    note: 'DeepSeek V4 Pro 官方能力清单未包含图片输入；V4 系列官方视觉模型是独立的 deepseek-v4-flash-vision-exp。OpenCode Go 上游亦拒绝图片请求（探测 400）。来源：api-docs.deepseek.com、在线探测'
  },
  'a6api|||glm-5.3-flash': {
    verdict: 'vision',
    note: 'GLM-5.3-Flash 为 GLM-5 系列首个原生多模态模型，支持图片/视频输入。来源：docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash'
  },
  'a6api|||DeepSeek-V4-Flash-0731': {
    verdict: 'no-vision',
    note: '日期快照能力冻结在 07-31：不支持图片输入。主模型 deepseek-v4-flash 自 2026-09 起已支持图片，看图请换主模型。来源：api-docs.deepseek.com'
  },
  'a6api|||deepseek-v4-pro-0813': {
    verdict: 'no-vision',
    note: 'DeepSeek V4 Pro 正式版（0813）官方能力清单未包含图片输入；V4 系列视觉模型是独立的 deepseek-v4-flash-vision-exp。来源：api-docs.deepseek.com'
  },
  'a6api|||gemini-3.7-flash': {
    verdict: 'vision',
    note: 'Gemini 3.7 Flash 原生多模态：文本/图片/视频/音频/PDF 输入。来源：ai.google.dev/gemini-api/docs/models/gemini-3.7-flash、deepmind.google'
  },
  'a6api|||gpt-5.6-sol': {
    verdict: 'vision',
    note: 'GPT-5.6 Sol 支持文本+图片输入（多模态）。来源：openai.com/index/previewing-gpt-5-6-sol、artificialanalysis.ai 对比'
  },
  'a6api|||grok-4.6': {
    verdict: 'vision',
    note: 'Grok 4.6 支持 text and image input。来源：x.ai/news/grok-4-6、tryfriday.ai/blog/grok-4-6-vs-gpt-5-6-sol'
  },
  'a6apiforclaude|||claude-fable-5': {
    verdict: 'vision',
    note: 'Claude Fable 5 支持视觉（图表/PDF/图片理解）。注意：A6API 的 anthropic 协议转换可能不透传图片，实际使用请验证。来源：anthropic.com/claude/fable、platform.claude.com/docs 视觉'
  },
  'a6apiforclaude|||glm-5.3-flash': {
    verdict: 'vision',
    note: 'GLM-5.3-Flash 原生多模态。来源：docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash'
  },
  'openrouter|||z-ai/glm-5.3-flash': {
    verdict: 'vision',
    note: 'GLM-5.3-Flash 原生多模态，支持图片/视频输入。来源：docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash'
  },
  'local-8787|||hy4-preview': {
    verdict: 'no-vision',
    note: '混元 Hy4 preview 为语言模型，不具备原生多模态；本机网关探测接受图片可能来自网关转接，效果不保证。来源：凤凰网 Hy4 preview 报道、workbuddy.cn 更新日志'
  },
  'local-8787|||hy4-preview-x': {
    verdict: 'no-vision',
    note: '混元 Hy4 preview 系列为语言模型，不具备原生多模态。来源：凤凰网 Hy4 preview 报道'
  },
  'local-8787|||glm-5.3-flash': {
    verdict: 'vision',
    note: 'GLM-5.3-Flash 原生多模态。来源：docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash'
  },
  'local-8787|||deepseek-v4-flash': {
    verdict: 'vision',
    note: 'DeepSeek-V4-Flash 自 2026-09 起支持图片输入（视觉能力并入主模型）。来源：api-docs.deepseek.com/zh-cn/guides/vision + 官方 API 实测（2026-09-10，文档滞后：文档仍写仅 vision-exp 收图）'
  },
  'local-8787|||deepseek-v4-pro': {
    verdict: 'no-vision',
    note: 'DeepSeek V4 Pro 官方能力清单未包含图片输入；V4 系列视觉模型是独立的 deepseek-v4-flash-vision-exp。来源：api-docs.deepseek.com'
  },
  'nvidia|||deepseek-ai/deepseek-v4-pro-0813': {
    verdict: 'no-vision',
    note: 'DeepSeek V4 Pro 正式版（0813）官方能力清单未包含图片输入；V4 系列视觉模型是独立的 deepseek-v4-flash-vision-exp。来源：api-docs.deepseek.com'
  },
  'nvidia|||deepseek-ai/deepseek-v4-flash-0731': {
    verdict: 'no-vision',
    note: 'DeepSeek-V4-Flash 为纯文本模型。来源：docs.cloudbase.net、api-docs.deepseek.com'
  }
};

// ── 模型级结论（官方能力，OpenAI 兼容 image_url 输入） ────────────────────
export const MODEL_DOCS = {
  // DeepSeek
  'deepseek-chat': {
    verdict: 'vision',
    note: 'deepseek-chat 为 deepseek-v4-flash 的滚动别名，自 2026-09 起随主模型支持图片输入。来源：api-docs.deepseek.com'
  },
  'deepseek-reasoner': {
    verdict: 'no-vision',
    note: 'DeepSeek 推理模型，无图片输入。来源：api-docs.deepseek.com'
  },
  'deepseek-v4-flash': {
    verdict: 'vision',
    note: 'DeepSeek-V4-Flash 自 2026-09 起支持图片输入（官方视觉能力并入主模型）。来源：api-docs.deepseek.com/zh-cn/guides/vision + 官方 API 实测（2026-09-10，文档滞后：文档仍写仅 vision-exp 收图）'
  },
  'deepseek-flash': {
    verdict: 'vision',
    note: '中转站别名（指向 deepseek-v4-flash），随主模型支持图片输入。来源：官方 API 实测 2026-09-10'
  },
  'deepseek-v4-flash-0731': {
    verdict: 'no-vision',
    note: '日期快照能力冻结在 07-31：不支持图片输入。主模型 deepseek-v4-flash 自 2026-09 起已支持图片。来源：api-docs.deepseek.com'
  },
  'deepseek-v4-flash-vision-exp': {
    verdict: 'vision',
    note: 'DeepSeek 官方视觉模型，支持图片输入（URL/base64）。来源：api-docs.deepseek.com/zh-cn/news/news260821'
  },
  'deepseek-v4-pro': {
    verdict: 'no-vision',
    note: 'DeepSeek V4 Pro 官方能力清单未包含图片输入；V4 系列首个官方视觉模型是 deepseek-v4-flash-vision-exp。来源：api-docs.deepseek.com、36kr.com/p/3949138682379651'
  },
  'deepseek-v4-pro-0813': {
    verdict: 'no-vision',
    note: 'DeepSeek V4 Pro 正式版（0813）官方能力清单未包含图片输入；看图请用 deepseek-v4-flash-vision-exp。来源：api-docs.deepseek.com'
  },
  'deepseek-ai/deepseek-v4-pro-0813': {
    verdict: 'no-vision',
    note: 'DeepSeek V4 Pro 正式版（0813）官方能力清单未包含图片输入；看图请用 deepseek-v4-flash-vision-exp。来源：api-docs.deepseek.com'
  },
  'deepseek-ai/deepseek-v4-flash-0731': {
    verdict: 'no-vision',
    note: 'DeepSeek-V4-Flash-0731 为纯文本模型。来源：docs.cloudbase.net'
  },

  // OpenAI
  'gpt-5.6-sol': {
    verdict: 'vision',
    note: 'GPT-5.6 Sol 支持文本+图片输入（多模态）。来源：openai.com/index/previewing-gpt-5-6-sol'
  },
  'gpt-5.6-terra': {
    verdict: 'vision',
    note: 'GPT-5.6 系列为多模态模型，支持图片输入。来源：openai.com/index/previewing-gpt-5-6-sol'
  },
  'gpt-5.6-luna': {
    verdict: 'vision',
    note: 'GPT-5.6 系列为多模态模型，支持图片输入。来源：openai.com/index/previewing-gpt-5-6-sol'
  },
  'gpt-4-vision-preview': {
    verdict: 'vision',
    note: 'OpenAI 视觉模型。来源：platform.openai.com/docs'
  },
  'gpt-4o': {
    verdict: 'vision',
    note: 'GPT-4o 原生多模态，支持图片输入。来源：platform.openai.com/docs'
  },
  'gpt-4o-mini': {
    verdict: 'vision',
    note: 'GPT-4o mini 原生多模态，支持图片输入。来源：platform.openai.com/docs'
  },

  // Anthropic（OpenAI 兼容中转常用模型 ID）
  'claude-fable-5': {
    verdict: 'vision',
    note: 'Claude Fable 5 为视觉模型，支持图片/图表/PDF 理解。来源：anthropic.com/claude/fable'
  },
  'claude-opus-4-8': {
    verdict: 'vision',
    note: 'Claude Opus 4.8 支持图片输入。来源：platform.claude.com/docs'
  },

  // 智谱 GLM
  'glm-5.3-flash': {
    verdict: 'vision',
    note: 'GLM-5.3-Flash 为 GLM-5 系列首个原生多模态模型，支持图片/视频输入。来源：docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash'
  },
  'glm-4.6v-flash': {
    verdict: 'vision',
    note: 'GLM-4.6V-Flash 为视觉语言模型，支持图片输入。来源：docs.bigmodel.cn'
  },
  'glm-4.6v-flash-web': {
    verdict: 'vision',
    note: 'GLM-4.6V-Flash-WEB 为视觉语言模型，支持图文混合输入。来源：docs.bigmodel.cn'
  },
  'glm-4v': {
    verdict: 'vision',
    note: 'GLM-4V 系列为视觉语言模型。来源：docs.bigmodel.cn'
  },

  // 阿里千问
  'qwen3.8-max': {
    verdict: 'vision',
    note: 'Qwen3.8-Max 为多模态旗舰，支持图片/视频输入。来源：platform.qianwenai.com、help.aliyun.com/zh/model-studio/vision'
  },
  'qwen-vl-max': {
    verdict: 'vision',
    note: 'Qwen-VL 系列为视觉语言模型。来源：help.aliyun.com/zh/model-studio/vision'
  },
  'qwen-vl-plus': {
    verdict: 'vision',
    note: 'Qwen-VL 系列为视觉语言模型。来源：help.aliyun.com/zh/model-studio/vision'
  },
  'qwen2.5-vl-72b-instruct': {
    verdict: 'vision',
    note: 'Qwen2.5-VL 为视觉语言模型。来源：help.aliyun.com/zh/model-studio/vision'
  },

  // 腾讯混元
  'hunyuan-turbo-vision': {
    verdict: 'vision',
    note: '混元新一代视觉语言旗舰大模型，支持图片输入。来源：cloud.tencent.com/product/hunyuan'
  },
  'hunyuan-vision': {
    verdict: 'vision',
    note: '混元多模态模型，支持图片输入。来源：cloud.tencent.com/product/hunyuan'
  },
  'hunyuan-turbos': {
    verdict: 'no-vision',
    note: '混元 TurboS 为文本模型。来源：cloud.tencent.com/product/hunyuan'
  },
  'hunyuan-turbo-latest': {
    verdict: 'no-vision',
    note: '混元 Turbo 最新版为文本模型；看图请用 hunyuan-turbo-vision。来源：cloud.tencent.com/product/hunyuan'
  },
  'hunyuan-large-longcontext': {
    verdict: 'no-vision',
    note: '混元 Large LongContext 为文本模型。来源：cloud.tencent.com/product/hunyuan'
  },
  'hy4-preview': {
    verdict: 'no-vision',
    note: '混元 Hy4 preview 为语言模型，无原生视觉。来源：凤凰网 Hy4 preview 报道'
  },
  'hy4-preview-x': {
    verdict: 'no-vision',
    note: '混元 Hy4 preview 系列为语言模型，无原生视觉。来源：凤凰网 Hy4 preview 报道'
  },

  // Kimi / Moonshot
  'kimi-k3': {
    verdict: 'vision',
    note: 'Kimi K3 原生支持图片理解。来源：Moonshot AI 官方开源公告'
  },
  'kimi-k2.5': {
    verdict: 'no-vision',
    note: 'Kimi K2.5 为文本模型；K3 起原生支持图片理解。来源：Moonshot AI 官方公告'
  },
  'kimi-k2.7-code': {
    verdict: 'no-vision',
    note: 'Kimi K2.7 Code 为代码文本模型。来源：Moonshot AI 官方公告'
  },

  // MiniMax
  'minimax-m2': {
    verdict: 'no-vision',
    note: 'MiniMax M2 为编程/智能体文本模型，无原生视觉；看图用 MiniMax-VL-01 或 M2.1 系列。来源：MiniMax 开发者文档'
  },
  'minimax-m2.1': {
    verdict: 'vision',
    note: 'MiniMax M2.1 系列支持图像理解。来源：MiniMax 开发者文档'
  },
  'minimax-vl-01': {
    verdict: 'vision',
    note: 'MiniMax-VL-01 为官方视觉语言模型。来源：MiniMax 开发者文档'
  },
  'abab6.5s': {
    verdict: 'no-vision',
    note: 'MiniMax abab6.5s 为纯文本模型。来源：MiniMax 开发者文档'
  },
  'abab6.5s-chat': {
    verdict: 'no-vision',
    note: 'MiniMax abab6.5s 为纯文本模型。来源：MiniMax 开发者文档'
  },
  'm2.7': {
    verdict: 'no-vision',
    note: 'MiniMax M2.7 为纯文本模型。来源：MiniMax 开发者文档'
  },
  'embo-01': {
    verdict: 'no-vision',
    note: 'MiniMax embo-01 为纯文本模型。来源：MiniMax 开发者文档'
  },

  // xAI
  'grok-4.6': {
    verdict: 'vision',
    note: 'Grok 4.6 支持 text and image input。来源：x.ai/news/grok-4-6'
  },
  'grok-4': {
    verdict: 'vision',
    note: 'Grok 4 支持图片输入。来源：x.ai'
  },
  'grok-4.1': {
    verdict: 'vision',
    note: 'Grok 4.1 支持图片输入。来源：x.ai'
  },

  // Google
  'gemini-3.7-flash': {
    verdict: 'vision',
    note: 'Gemini 3.7 Flash 原生多模态：文本/图片/视频/音频/PDF。来源：ai.google.dev/gemini-api/docs/models/gemini-3.7-flash'
  },
  'gemini-3-pro': {
    verdict: 'vision',
    note: 'Gemini 3 Pro 原生多模态，支持图片输入。来源：ai.google.dev'
  },
  'gemini-2.5-flash': {
    verdict: 'vision',
    note: 'Gemini 2.5 Flash 原生多模态。来源：ai.google.dev'
  },
  'gemini-2.5-pro': {
    verdict: 'vision',
    note: 'Gemini 2.5 Pro 原生多模态。来源：ai.google.dev'
  },

  // 小米 MiMo
  'mimo-v2.5-pro-ultraspeed': {
    verdict: 'vision',
    note: 'MiMo-V2.5 基座为原生全模态，官方提供图片理解 API。来源：mimo.xiaomi.com/mimo-v2-5、mimo.mi.com/docs'
  },
  'mimo-v2.5-pro': {
    verdict: 'no-vision',
    note: 'MiMo-V2.5-Pro 无原生视觉（GitHub XiaomiMiMo/MiMo-Code#309）。来源：github.com/XiaomiMiMo/MiMo-Code/issues/309'
  },

  // NVIDIA NIM 常见路径
  'nvidia/deepseek-ai/deepseek-v4-pro-0813': {
    verdict: 'no-vision',
    note: 'DeepSeek V4 Pro 正式版（0813）官方能力清单未包含图片输入；V4 系列视觉模型是独立的 deepseek-v4-flash-vision-exp。来源：api-docs.deepseek.com'
  },
  'nvidia/deepseek-ai/deepseek-v4-flash-0731': {
    verdict: 'no-vision',
    note: 'DeepSeek-V4-Flash-0731 为纯文本模型。来源：docs.cloudbase.net'
  },
  'deepseek-ai/deepseek-v4-pro-0813': {
    verdict: 'no-vision',
    note: 'DeepSeek V4 Pro 正式版（0813）官方能力清单未包含图片输入；V4 系列视觉模型是独立的 deepseek-v4-flash-vision-exp。来源：api-docs.deepseek.com'
  },
  'deepseek-ai/deepseek-v4-flash-0731': {
    verdict: 'no-vision',
    note: 'DeepSeek-V4-Flash-0731 为纯文本模型。来源：docs.cloudbase.net'
  }
};

/**
 * 查询内置官方资料结论。
 * 返回 { verdict, note, source: 'docs' } 或 null。
 */
export function lookupVisionDoc(providerId, model) {
  const pid = norm(providerId);
  const m = norm(model);
  if (!m) return null;

  // 1) 提供商级结论优先（能表达“该链路实际是否透传图片”）
  const pkey = `${pid}|||${m}`;
  if (PROVIDER_DOCS[pkey]) return { ...PROVIDER_DOCS[pkey], source: 'docs' };

  // 2) 模型级官方结论（大小写不敏感；支持 deepseek-ai/xxx 与 xxx 两种写法）
  for (const key of modelKeys(m)) {
    if (MODEL_DOCS[key]) return { ...MODEL_DOCS[key], source: 'docs' };
  }
  return null;
}

/**
 * 为一批提供商/模型生成 key -> 文档结论 的映射（不包含已持久化在 config.modelVision 的结论）。
 * 用于 /api/vision/results 等接口把内置知识合并给 UI。
 */
export function builtinVisionResults(providers = []) {
  const out = {};
  for (const p of providers || []) {
    const pid = String(p.id || '');
    for (const model of p.models || []) {
      const key = `${pid}|||${model}`;
      const doc = lookupVisionDoc(pid, model);
      if (doc) out[key] = { providerId: pid, model: String(model), ...doc };
    }
  }
  return out;
}
