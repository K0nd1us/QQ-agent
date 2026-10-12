# 搜索来源与网页正文提取

Bing HTML 结果使用静态 DOM 解析，兼容 class 顺序、属性顺序和引号变化，只从结果标题取链接，去除重复结果。`bing.com/ck/a?u=a1...` 跟踪链接解码为真实 HTTP(S) 来源；无效、带账号密码或 Bing 搜索/广告跳转地址不作为结果。

官方 Bing HTML 无结果时额外尝试一次 RSS；自定义搜索 URL 不会被改写为 RSS，也没有主题词猜测和自动改词重试。

`web_fetch` 先在原有 SSRF 和浏览锁保护下读取最多 512 KB，再静态提取最多 2 万 UTF-16 码元的正文，避免旧的 50 KB HTML 前缀全是导航而读不到正文。底层 safeFetch 默认字节预算保持 50 KB，可配置最多 1 MB。返回标题、原文声明的 publishedTime / modifiedTime、fetchedAt 和 extraction；发布日期、更新时间、抓取时间分别返回，不能把任一日期直接当成事件发生时间。

提取优先网页正文容器，失败时使用 Readability 或页面可见文本；不执行脚本、不加载子资源。动态渲染站点、验证码、正文超出读取上限时仍可能无法取得完整内容，结果中的 truncated 标记保留这一限制。

jsdom 从开发依赖改为运行依赖，使用支持 Node 18+ 的 26.x，以兼容本项目 Node 20/Electron 33；Readability 使用 0.6.x。原有 URL 校验、DNS 固定、内网阻断和逐跳浏览锁继续生效。
