# Responses 搜索来源校验

搜索设置中的 DeepSeek 槽位保留原密钥、模型和接口配置；控制台现在也能编辑 Responses 搜索地址。

DeepSeek 官方 Responses API 文档明确将内置 `web_search` 列为忽略的工具（核对日期：2026-10-12）：https://api-docs.deepseek.com/zh-cn/guides/responses_api/

因此官方端点会在请求前返回可操作错误，用户可选择 Bing 或其它搜索服务。自建兼容服务必须返回完成的 Responses 响应、完成的 `web_search_call` 和有效 HTTP(S) 来源引用；普通文本、未完成调用、无来源、带账号密码的 URL 均不作为结果。服务若返回 action.sources，引用还必须属于该来源集合。

返回的摘要仍需用 `web_fetch` 核验正文；工具调用记录和引用元数据是所配置搜索服务提供的检索证据，不代表客户端已经验证文章内容真实。
