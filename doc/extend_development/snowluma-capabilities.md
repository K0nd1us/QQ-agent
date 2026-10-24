# SnowLuma 能力清单（OneBot v11 接口规范）

本文档完整记录 SnowLuma 协议端提供的所有 OneBot action，供插件开发者参考。

> 🔗 **写 Skill 的请看这里**：这些接口在 Skill 里**全部可调用**（`ctx.onebot.call(action, params)`，
> 无白名单）。Skill 视角的用法（调用姿势、错误处理、写操作注意事项、消息段类型）
> 见 [skill-reference.md 第 10.2 节](./skill-reference.md#102-ctxonebot-方法)。
> 本文负责"协议端有哪些接口、参数是什么"，那份负责"Skill 怎么用"。

## 目录

- [信息](#信息)
- [消息](#消息)
- [好友](#好友)
- [群信息](#群信息)
- [群管理](#群管理)
- [群文件](#群文件)
- [请求](#请求)
- [扩展](#扩展)
- [群相册](#群相册)
- [空间](#空间)
- [系统表情](#系统表情)
- [流式接口](#流式接口)

---

## 信息

### get_login_info
获取当前登录账号的 QQ 号与昵称。

**参数**：无

**返回**：
```json
{ "user_id": 123456, "nickname": "机器人昵称" }
```

### get_status
获取运行状态。

**参数**：无

**返回**：
```json
{ "online": true, "good": true }
```
- `online`: 是否在线
- `good`: 收发链路健康状态

### get_version_info
获取实现与协议版本信息。

**参数**：无

**返回**：
```json
{ "app_name": "SnowLuma", "app_version": "1.14.13-node", "protocol_version": "v11" }
```

### can_send_image
查询是否支持发送图片。

**参数**：无

**返回**：`{ "yes": true }`

### can_send_record
查询是否支持发送语音。

**参数**：无

**返回**：`{ "yes": true }`

---

## 消息

### send_msg
发送消息（按 message_type/群号 自动路由群聊或私聊）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| message | array | 是 | 消息内容（OneBot 消息段数组） |
| message_type | string | 否 | 'group' 或 'private' |
| group_id | number | 否 | 群号（群聊时必填） |
| user_id | number | 否 | QQ 号（私聊时必填） |
| auto_escape | boolean | 否 | 是否转义纯文本（默认 false） |

**返回**：`{ "message_id": 12345 }`

### send_private_msg
发送私聊消息。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| user_id | number | 是 | 对方 QQ 号 |
| message | array | 是 | 消息内容 |
| group_id | number | 否 | 临时会话来源群号 |
| auto_escape | boolean | 否 | 是否转义纯文本 |

**返回**：`{ "message_id": 12345 }`

### send_group_msg
发送群消息。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| message | array | 是 | 消息内容 |
| auto_escape | boolean | 否 | 是否转义纯文本 |

**返回**：`{ "message_id": 12345 }`

### get_msg
获取消息详情。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| message_id | number | 是 | 消息 ID |

**返回**：消息事件对象（含 real_id 字段）

### delete_msg
撤回消息。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| message_id | number | 是 | 消息 ID |

**返回**：无

---

## 好友

### get_friend_list
获取好友列表。

**参数**：无

**返回**：好友数组，每项含 `user_id`, `nickname`, `remark`

### get_stranger_info
获取陌生人信息。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| user_id | number | 是 | QQ 号 |

**返回**：用户资料对象（含昵称、性别、年龄、个性签名等）

---

## 群信息

### get_group_list
获取群列表。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| no_cache | boolean | 否 | 是否强制刷新缓存 |

**返回**：群信息数组，每项含 `group_id`, `group_name`, `member_count` 等

### get_group_info
获取群信息。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| no_cache | boolean | 否 | 是否强制刷新缓存 |

**返回**：群信息对象

### get_group_member_list
获取群成员列表。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| no_cache | boolean | 否 | 是否强制刷新缓存 |

**返回**：群成员数组，每项含 `user_id`, `nickname`, `card`, `role` 等

### get_group_member_info
获取群成员信息。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| user_id | number | 是 | QQ 号 |
| no_cache | boolean | 否 | 是否强制刷新缓存 |

**返回**：群成员信息对象

---

## 群管理

### set_group_kick
踢出群成员。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| user_id | number | 是 | QQ 号 |
| reject_add_request | boolean | 否 | 是否拒绝其后续加群请求 |

### set_group_kick_members
批量踢出群成员。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| user_id | number[] | 是 | QQ 号数组 |
| reject_add_request | boolean | 否 | 是否拒绝其后续加群请求 |

### set_group_ban
禁言群成员（duration=0 解除）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| user_id | number | 是 | QQ 号 |
| duration | number | 否 | 禁言秒数（默认 1800） |

### set_group_whole_ban
全员禁言开关。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| enable | boolean | 否 | 是否开启（默认 true） |

### set_group_admin
设置/取消管理员。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| user_id | number | 是 | QQ 号 |
| enable | boolean | 否 | 是否设为管理员（默认 true） |

### set_group_card
设置群名片（空字符串清除）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| user_id | number | 是 | QQ 号 |
| card | string | 否 | 群名片内容 |

### set_group_add_option
设置加群选项。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| add_type | number | 否 | 加群方式 |
| group_question | string | 否 | 加群问题 |
| group_answer | string | 否 | 加群答案 |

### get_group_admin_settings
获取群管理设置的当前值。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |

**返回**：群管理设置对象

---

## 群文件

### upload_group_file
上传群文件。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| file | string | 是 | 文件路径/URL/base64 |
| name | string | 否 | 文件名 |
| folder | string | 否 | 目标文件夹路径 |

**返回**：`{ "file_id": "xxx" }`

### upload_private_file
上传私聊文件。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| user_id | number | 是 | QQ 号 |
| file | string | 是 | 文件路径/URL/base64 |
| name | string | 否 | 文件名 |

**返回**：`{ "file_id": "xxx" }`

### get_group_file_url
获取群文件下载链接。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| file_id | string | 是 | 文件 ID |

**返回**：`{ "url": "https://..." }`

### get_group_root_files
获取群根目录文件列表。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |

**返回**：`{ "files": [...], "folders": [...] }`

### get_group_files_by_folder
获取群子目录文件列表。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| folder_id | string | 是 | 文件夹 ID |

**返回**：`{ "files": [...], "folders": [...] }`

---

## 请求

### set_friend_add_request
处理好友添加请求。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| flag | string | 是 | 请求标识 |
| approve | boolean | 否 | 是否同意（默认 true） |

### set_group_add_request
处理加群请求。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| flag | string | 是 | 请求标识 |
| sub_type | string | 否 | 请求类型 |
| approve | boolean | 否 | 是否同意（默认 true） |
| reason | string | 否 | 拒绝理由 |

---

## 扩展

### send_like
点赞。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| user_id | number | 是 | QQ 号 |
| times | number | 否 | 点赞次数（默认 1） |

### friend_poke
好友拍一拍。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| user_id | number | 是 | QQ 号 |
| target_id | number | 否 | 目标 QQ 号 |

### group_poke
群拍一拍。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| user_id | number | 是 | QQ 号 |

### send_poke
拍一拍（群聊/私聊自动路由）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| user_id | number | 是 | QQ 号 |
| group_id | number | 否 | 群号（群聊时传） |

### set_essence_msg
设置精华消息。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| message_id | number | 是 | 消息 ID |

### delete_essence_msg
移除精华消息。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| message_id | number | 是 | 消息 ID |

### get_essence_msg_list
获取精华消息列表。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |

**返回**：精华消息数组

### set_group_reaction
群聊表情回应。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 否 | 群号 |
| message_id | number | 是 | 消息 ID |
| code | string | 是 | 表情代码 |
| is_set | boolean | 否 | 是否设置（默认 true） |

### add_custom_face
添加收藏表情。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | string | 是 | 图片路径/URL/base64 |

**返回**：`{ "emoji_id": "xxx" }`

### delete_custom_face
删除收藏表情。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| emoji_id | string | 是 | 表情 ID |

### modify_custom_face
修改收藏表情备注。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| emoji_id | string | 是 | 表情 ID |
| desc | string | 否 | 备注内容 |

### get_group_msg_history
获取群消息历史。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| message_id | number | 否 | 锚点消息 ID |
| count | number | 否 | 数量（默认 20） |
| reverse_order | boolean | 否 | 是否倒序（默认 true） |

**返回**：`{ "messages": [...] }`

### get_friend_msg_history
获取好友消息历史。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| user_id | number | 是 | QQ 号 |
| message_id | number | 否 | 锚点消息 ID |
| count | number | 否 | 数量（默认 20） |
| reverse_order | boolean | 否 | 是否倒序（默认 true） |

**返回**：`{ "messages": [...] }`

### mark_group_msg_as_read
标记群消息已读。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| message_id | number | 是 | 消息 ID |
| group_id | number | 否 | 群号 |

### mark_private_msg_as_read
标记私聊消息已读。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| message_id | number | 是 | 消息 ID |
| user_id | number | 否 | QQ 号 |

### mark_msg_as_read
标记消息已读（群聊/私聊自动路由）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| message_id | number | 是 | 消息 ID |
| target_id | number | 否 | 目标 ID |

### _send_group_notice
发送群公告。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| content | string | 是 | 公告正文 |
| image | string | 否 | 公告图片 |
| pinned | number | 否 | 是否置顶 |
| send_to_new_members | boolean | 否 | 是否新成员可见 |

### _get_group_notice
获取群公告。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |

**返回**：公告数组

### upload_forward_msg
上传转发消息。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| messages | array | 是 | 消息节点数组 |
| group_id | number | 否 | 群号 |

**返回**：`{ "res_id": "xxx", "forward_id": "xxx" }`

### get_image
获取图片信息。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | string | 否 | 图片 ID |
| file_id | string | 否 | 图片 ID |

**返回**：图片信息对象

### get_record
获取语音信息。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | string | 否 | 语音 ID |
| file_id | string | 否 | 语音 ID |
| out_format | string | 否 | 输出格式（mp3/amr/wma/m4a/spx/ogg/wav/flac） |

**返回**：语音信息对象（含 base64 如果指定 out_format）

### fetch_ptt_text
获取语音转文字结果。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| message_id | number | 是 | 消息 ID |

**返回**：`{ "text": "识别结果" }`

### get_cookies
获取 Cookies。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| domain | string | 是 | 域名 |

**返回**：`{ "cookies": "xxx" }`

---

## 群相册

### get_group_album_list
获取群相册列表。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |

**返回**：相册数组

### get_qun_album_list
获取群相册列表（NapCat 风格）。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| attach_info | string | 否 | 分页游标 |

**返回**：`{ "album_list": [...], "attach_info": "xxx", "has_more": false }`

### upload_image_to_qun_album
上传图片到群相册。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| album_id | string | 是 | 相册 ID |
| album_name | string | 是 | 相册名称 |
| file | string | 是 | 图片路径/URL/base64 |

### get_group_album_media_list
获取群相册媒体列表。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| group_id | number | 是 | 群号 |
| album_id | string | 是 | 相册 ID |
| attach_info | string | 否 | 分页游标 |

**返回**：`{ "mediaList": [...], "nextAttachInfo": "xxx" }`

---

## 空间

### get_qzone_msg_list
获取 QQ 空间说说列表。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| target_uin | number | 否 | 目标 QQ 号（默认机器人自己） |
| pos | number | 否 | 起始偏移（默认 0） |
| num | number | 否 | 数量（默认 20，最大 100） |

**返回**：`{ "total": 100, "msglist": [...] }`

### get_qzone_feeds
获取 QQ 空间好友动态。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| page_num | number | 否 | 页码（默认 1） |
| count | number | 否 | 数量（默认 10，最大 50） |

**返回**：`{ "feeds": [...], "has_more": true }`

### send_qzone_msg
发表说说。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| content | string | 是 | 说说正文 |
| images | string[] | 否 | 图片数组 |
| ugc_right | number | 否 | 查看权限（默认 1=所有人可见） |

**返回**：发表结果

### delete_qzone_msg
删除说说。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| tid | string | 是 | 说说 ID |

### like_qzone
给说说点赞。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| tid | string | 是 | 说说 ID |
| target_uin | number | 否 | 说说所属 QQ 号 |

---

## 系统表情

### fetch_sys_faces
获取 QQ 系统表情目录。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| refresh | boolean | 否 | 是否刷新缓存 |

**返回**：`{ "packs": [...] }`

### fetch_face_entity
按编号查询 QQ 系统表情。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| face_id | number | 是 | 表情编号 |
| refresh | boolean | 否 | 是否刷新缓存 |

**返回**：表情详情对象

### search_sys_faces
搜索 QQ 系统表情。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 搜索词 |

**返回**：`{ "faces": [...] }`

---

## 流式接口

### upload_file_stream
以流式分块方式上传文件到机器人本地。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| stream_id | string | 是 | 流 ID（UUID） |
| chunk_data | string | 否 | 分块数据（Base64） |
| chunk_index | number | 否 | 分块索引 |
| total_chunks | number | 否 | 总分块数 |
| is_complete | boolean | 否 | 是否最后一块 |

**返回**：流式帧

### download_file_stream
以流式方式下载文件。

**参数**：
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | string | 否 | 文件 ID/路径/URL |
| chunk_size | number | 否 | 分块大小 |

**返回**：流式帧

### download_file_image_stream
以流式方式下载图片。

**参数**：同 download_file_stream

### download_file_record_stream
以流式方式下载语音。

**参数**：同 download_file_stream

---

## 插件开发建议

### 只读接口（安全）
以下接口只读取数据，不修改任何状态，适合频繁调用：
- get_login_info, get_status, get_version_info
- get_friend_list, get_stranger_info
- get_group_list, get_group_info, get_group_member_list, get_group_member_info
- get_msg, get_group_msg_history, get_friend_msg_history
- get_image, get_record, fetch_ptt_text
- get_group_album_list, get_qun_album_list, get_group_album_media_list
- get_qzone_msg_list, get_qzone_feeds
- fetch_sys_faces, fetch_face_entity, search_sys_faces

### 写操作接口（需谨慎）
以下接口会修改 QQ 状态，建议加权限控制：
- send_msg, send_private_msg, send_group_msg
- delete_msg
- set_group_kick, set_group_ban, set_group_admin
- upload_group_file, upload_private_file
- set_essence_msg, delete_essence_msg
- send_qzone_msg, delete_qzone_msg

### 消息段类型
OneBot 消息段支持以下类型：
- `text`: 纯文本
- `face`: QQ 表情
- `image`: 图片
- `record`: 语音
- `video`: 视频
- `at`: @某人
- `reply`: 回复消息
- `forward`: 合并转发
- `file`: 文件
- `json`: JSON 消息
- `xml`: XML 消息
- `poke`: 戳一戳
