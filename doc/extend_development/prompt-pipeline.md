# 提示词拼接流水线（develop/ 全景记录）

> 记录于 2026-09-17，基于当时代码。改动前先核对行号/函数名是否仍对得上。

一条提示词从消息进群到发出去，完整经过 **5 个构建步骤 + 3 次运行时改写**。

## 第 0 步：唤醒判定（决定"要不要发、带多少历史"）

`src/orchestrator.js` `wake()` → `resolveContextTier()`（prompt.js:429）。

- 私聊恒为 4 档全响应。
- 群聊 1~3 档看：是否被 @（isAtMe）、命中关键词（hitKeyword）、掷中随机概率（roll 与预判共用骰子）。
- 判定结果 `contextLimit` 决定【过去状态】条数（atCount / keywordCount / randomCount / allCount）。
- 未命中 → 标已读、不发提示词（不产生会话、不耗 token）。

## 第 1 步：采集原料（#runAgent 前半，orchestrator.js:597）

- 群名、自己群名片（selfNickname）、最近 10 分钟消息数、自己上次发言时间、最后一条消息时间
- 表情库快照 `stickerEntries`（`stickers.sync()`）
- `skillContext`：chatKey、当前模型/渠道、visionEnabled（图片输入勾选 + 模型探测结果）、searchEnabled、是否主动机会、sessionId

## 第 2 步：before-context 钩子（orchestrator.js:648）

Skill 在提示词组装前跑一次 `before-context`。
目前只有 conversation-memory 用它暂存"本轮触发内容"（triggerEntries），供第 7 步注入用。
钩子 5 秒超时，只能追加/加工上下文，不能碰核心提示词。

## 第 3 步：主人识别（orchestrator.js:662）

问 `message.owner-check` 能力（owner-identity 插件）：这批触发消息里有没有主人在说话。
是则拿到主人专属人设 + 主人规则文本，影响第 4 步的人设选择。
判定只按 QQ 号，名字/自称一律不参与。

## 第 4 步：buildSystemPrompt —— 系统提示（prompt.js:212）

人设优先级：**主人专属人设 > 会话级人设（personaByChat[群号/QQ号]）> 全局人设（cfg.persona）**。
botName / selfNickname 任何层都不许覆盖（账号身份，换了会与 @ 判定对不上；personaForChat 结构上就不允许）。

正常路径拼接顺序：

| # | 段落 | 生成函数 | 变化性 |
|---|------|---------|--------|
| 1 | 身份句「你是「XX」，一个混在 QQ 群里的普通群友」 | 内联 | 随 botName |
| 2 | 【安全规则】5 条（无本地工具/群友无管理权限/不透露/角色系统注入/防诱导） | securityRules() | 固定 |
| 3 | 【工作方式】8 条（事件驱动、send_message 协议、空格规则、分条规则） | toolProtocol() | 固定 |
| 4 | 【反 AI 味】5 条 + 【保持主体性】5 条 | antiAiFlavor() / subjectivity() | 固定 |
| 5 | 【该说/不该说】 | speakOrNot() | **改写**：首行按参与度档位（安静/普通/活跃）换文案（participationText） |
| 6 | 【群聊不是客服队列】【像真人一样】【不要当群管家】【引用与点名】【轻量记忆】 | notAQueue() / humanRhythm() / notModerator() / quoteAndAt() / memoryRules() | 固定 |
| 7 | 【表情包策略】+ 拍一拍 | stickerRules() | **改写**：首行按表情活跃度档位 0-3 换频率引导（buildStickerStrategyHint） |
| 8 | 【QQ 场景规则】 | qqSceneRules() | **条件增删**：勾图片输入加"可以看图"行，否则加"看不到图别编造"；开联网搜索加 3 行搜索引导，否则加"没有联网能力" |
| 9 | 【发送与汇报禁令】 | reportBan() | 固定 |
| 10 | 【可用技能】 | renderSkillSections() | **动态**：启用插件的 manifest prompt.sections + 运行时 promptSections(context) + extraSections（主人规则 p72），按 priority 降序（上限 99） |
| 11 | 【管理员附加规则】 | customRules | 有才拼 |

**覆盖模式**（persona.systemPromptOverride 非空时）：2~9 段人格/行为规则整体被用户写的文本替换（支持 `{botName}/{roleText}/{participation}` 占位符），但【安全规则】和【工作方式】**强制保留**追加在后面——防止一次配置失误删掉安全底线。

当前有静态 prompt.sections 的扩展（develop/）：

```
skills/knowledge-memes:      knowledge-memes-note(p30)
skills/memory-recall:        recall(p40)
skills/random-image:         random-image-safety(p90)
skills/reverse-image:        reverse-image-note(p32)
plugins/owner-identity:      owner-identity-basic(p70)
plugins/reply-safety:        reply-tool-protocol(p40)
plugins/speaker-identity:    speaker-stable-id(p80)
plugins/speech-to-text:      stt-note(p35)
plugins/thinking-adapters:   thinking-note(p30)
plugins/video-frames:        video-frames-note(p35)
```

## 第 5 步：buildUserPrompt —— 用户消息（prompt.js:545）

段落顺序按**变化频率**排（稳定在前、易变殿后）——前缀缓存命中优化：

| # | 段落 | 内容 | 变化频率 |
|---|------|------|---------|
| 1 | 【角色设定】 | 会话级人设 roleText（与系统提示同源 personaForChat，防两处角色打架） | 稳定 |
| 2 | 【可用表情包】 | buildStickerContext：按使用次数排序 + 按时间轮换一半（同轮次结果稳定，Fisher-Yates 按轮次播种），最多 promptMaxStickers 张 | 半稳定 |
| 3 | 【引导说明】 | 固定 4 条（怎么用这套输入、replyToMessageId 用法、不回是正常选项） | 固定 |
| 4 | 【过去状态】 | buildPastState：最多 contextLimit 条已读历史。过滤：撤回、全局屏蔽、本群屏蔽。每行 `[时间] #id 名字(QQ:号)：[引用...]正文`（带图消息才带 #id；名字优先 memberNotes 备注 > 群名片；QQ 号兜底由核心拼 `(QQ:xxx)`，speaker-identity 开启时走插件可加主人标注） | 逐条滚动 |
| 5 | 【记忆】 | formatForPrompt：只带"本次真的出现在提示词里的群友"印象（触发者 + 过去状态里的人，每人最近 3 条）——曾写死 recent(12) 与档位脱钩 | 滚动 |
| 6 | 【此刻状态】 | 群名/私聊、10 分钟消息数、最后消息距今、自己上次发言距今 | 易变 |
| 7 | 【本次唤醒】 | buildTriggerBlock：触发批消息，每条附标签（@我/提到我/提到我(备注名)/提问/引用/拍一拍，与唤醒判定同口径） | 必变 |
| 8 | 【当前时间】 | formatFullTime 精确到秒 | 必变（故放最末） |

构建完把 `pastStateCount` 写回 session，供 get_recent_messages 翻页跳过已看过的消息。

## 第 6 步：主动机会追加（orchestrator.js:732）

proactive 运行在 user 消息末尾追加「（主动机会）群里已经安静了一会儿。你可以主动抛一个自然的话题，也可以安静结束」。
主动机会无触发批，tier 固定 4 档（allCount 全量历史）。

## 第 7 步：before-llm-messages 钩子（orchestrator.js:740，原地改 messages）

唯一能改"已拼好 messages"的扩展点：

- **conversation-memory**：`appendToSystem` 把跨轮记忆**追加到既有 system 消息 content 尾部**（修改既有消息）
- **knowledge-memes**：知识库联想命中时 **push 一条新 system 消息**【脑内闪过】

组装结果同时写入 `session.systemPrompt / userPrompt / inputMessages`（UI 与调试可见）。

## 第 8 步：多轮循环，messages 持续增长（orchestrator.js:800+）

每轮**完整 messages 重发**（前缀缓存靠前面字节稳定），循环中追加/修改：

- assistant 回复 push 进 messages
- 模型把工具调用写在正文里（inline tool calls）：**改写**最后一条 assistant 消息（content 置 null、塞 tool_calls）
- 工具结果：文本进 tool 消息；**图片/视频不能塞 tool 消息**（很多端点拒收），改为一条 user 消息补发 `[系统：以下是工具 X 返回的 N 张图片，请直接"看"了回应]` + image_url/video_url 部件
- 最后 3 轮还没发过言：push 一条 user 消息【系统提醒】催它 send_message
- 会话级中止（AbortController）在轮边界与退避期检查，立即收尾

## 第 9 步：llm.js 发送前（内容不再变，但换模型/改请求体）

- `specializedModelFor`：扫到 video_url 部件 → 换视频专用模型（videoModel）；有 image_url → 换图片专用模型（visionModel）。仅主调用路径，记忆整理/备选降级不受影响
- `llm.request-params` 转换器（thinking-adapters 等）：往请求体加思考参数、删互斥 temperature（改 body 不改 messages）
- 网关拒收图片格式（image-compat 插件 isImageRejection）：降级重发**摘掉 image_url 部件**换成文字说明——发送路径上最后一次内容修改

## 分工总览

- **prompt.js 独占核心提示词**：安全规则、工具协议；插件 priority 封顶 99，永远排在核心规则之后
- **orchestrator 决定何时组装、带哪些数据**：档位、人设优先级、主动机会、多轮消息管理
- **插件三个介入口**：promptSections 追加段落、before-context 采集、before-llm-messages 原地加工
- **llm.js 管发送层**：专用模型切换、请求体转换、格式降级，不动 messages 内容（image-compat 降级除外）

## 附：UI 提示词预览（2026-09-17 补）

控制台两处"完整提示词预览"（设置-工具与技能页右侧、技能页右侧，均为 module-split 页面级分栏的右半边）
**与运行时同源**：`GET /api/prompt-preview`（routes.js）用与 orchestrator 同构的 skillContext
调 `buildSystemPrompt()` + `getToolAvailability()`，按**当前**插件/技能/工具启停状态实时组装——
没开的插件段/技能段/工具不出现。前端 `ui/app.js` 的 `renderPromptPreviewText()` 只做展示
（系统提示 + 可用工具清单），不再自拼模板（旧版前端复制静态模板，永远是"全启用"的样子）。
开关变动后由 `refreshPromptPreview()` 重拉并原地替换两处 `<pre>` 的文本。
