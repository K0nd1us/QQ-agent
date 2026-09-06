// 一次性应用：把联网调研（官方文档/权威报道）得出的图片输入结论写入 config.modelVision。
// 用法：先停应用，然后 node scripts/apply-vision-docs.mjs，再启动应用。
// verdict 判的是"该目录项实际能否看图"：模型能力 + 该网关链路是否透传。
import { updateConfig, getConfig } from '../src/config.js';

const DOC_ENTRIES = {
  'qwen-token-plan-cn|||qwen3.8-max': {
    verdict: 'vision',
    note: '官方：多模态旗舰，支持图片/视频输入（单图最高1600万像素）。来源：platform.qianwenai.com、help.aliyun.com/zh/model-studio/vision'
  },
  'xiaomi-token-plan-cn|||mimo-v2.5-pro': {
    verdict: 'no-vision',
    note: 'MiMo-V2.5-Pro 无原生视觉（GitHub XiaomiMiMo/MiMo-Code#309：pro image:false）；Token Plan 网关亦返回"No endpoints found that support image input"。来源：github.com/XiaomiMiMo/MiMo-Code/issues/309'
  },
  'xiaomi|||mimo-v2.5-pro-ultraspeed': {
    verdict: 'vision',
    note: 'MiMo-V2.5 基座为原生全模态（图/视频/音频理解），官方提供图片理解 API 文档。来源：mimo.xiaomi.com/mimo-v2-5、mimo.mi.com/docs 图片理解'
  },
  'opencode-go|||deepseek-v4-flash': {
    verdict: 'no-vision',
    note: 'DeepSeek-V4-Flash 为纯文本模型，塞图报错；官方视觉是独立模型 deepseek-v4-flash-vision-exp。来源：docs.cloudbase.net、api-docs.deepseek.com/zh-cn/news/news260821'
  },
  'opencode-go|||deepseek-v4-pro': {
    verdict: 'no-vision',
    note: 'V4-Pro 模型本身支持图片输入，但 OpenCode Go 上游拒绝图片请求（探测 400），该链路实际不可看图。来源：docs.cloudbase.net（pro 支持 image_url）+ 在线探测'
  },
  'a6api|||glm-5.3-flash': {
    verdict: 'vision',
    note: 'GLM-5.3-Flash 为 GLM-5 系列首个原生多模态模型，支持图片/视频输入。来源：docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash'
  },
  'a6api|||DeepSeek-V4-Flash-0731': {
    verdict: 'no-vision',
    note: 'DeepSeek-V4-Flash 为纯文本模型（官方视觉为独立的 deepseek-v4-flash-vision-exp）。来源：docs.cloudbase.net、api-docs.deepseek.com'
  },
  'a6api|||deepseek-v4-pro-0813': {
    verdict: 'vision',
    note: 'DeepSeek-V4-Pro 支持图片输入（messages 内 image_url）。探测时"固定商家不可用"是中转商家容量问题，与图片无关。来源：docs.cloudbase.net/recipes/add-multimodal-image-cloudbase-deepseek-v4'
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
    note: 'Claude Fable 5 支持视觉（图表/PDF/图片理解）。注意：探测中中转回复"未看到图片"，A6API 的 anthropic 协议转换可能不透传图片，实际使用请验证。来源：anthropic.com/claude/fable、platform.claude.com/docs 视觉'
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
    note: '混元 Hy4 preview 为语言模型，不具备原生多模态；WorkBuddy 平台上图片任务会自动切其他模型。本机网关探测接受图片可能来自网关转接，效果不保证。来源：凤凰网 Hy4 preview 报道、workbuddy.cn 更新日志'
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
    verdict: 'no-vision',
    note: 'DeepSeek-V4-Flash 为纯文本模型。来源：docs.cloudbase.net、api-docs.deepseek.com/zh-cn/news/news260821'
  },
  'local-8787|||deepseek-v4-pro': {
    verdict: 'vision',
    note: 'DeepSeek-V4-Pro 支持图片输入。来源：docs.cloudbase.net/recipes/add-multimodal-image-cloudbase-deepseek-v4'
  },
  'nvidia|||deepseek-ai/deepseek-v4-pro-0813': {
    verdict: 'vision',
    note: 'DeepSeek-V4-Pro 支持图片输入（探测超时为 NVIDIA 实例冷启动，与能力无关）。来源：docs.cloudbase.net'
  },
  'nvidia|||deepseek-ai/deepseek-v4-flash-0731': {
    verdict: 'no-vision',
    note: 'DeepSeek-V4-Flash 为纯文本模型。来源：docs.cloudbase.net、api-docs.deepseek.com'
  }
};

const patch = {};
for (const [key, e] of Object.entries(DOC_ENTRIES)) {
  const [providerId, model] = key.split('|||');
  patch[key] = { providerId, model, verdict: e.verdict, note: e.note, source: 'docs', checkedAt: Date.now() };
}
const next = updateConfig({ modelVision: patch });
const results = next.modelVision || {};
const n = (v) => Object.values(results).filter((r) => r.verdict === v).length;
console.log(`已写入 ${Object.keys(patch).length} 条官方资料结论；当前共 ${Object.keys(results).length} 条：支持 ${n('vision')} / 不支持 ${n('no-vision')} / 其他 ${n('unknown')}`);
console.log(`配置文件：${getConfig().__file ?? '(config.json)'}`);
