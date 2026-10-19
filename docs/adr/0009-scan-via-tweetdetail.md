# 扫回复主路径: TweetDetail 代替 conversation_id Search

## Context

主动关注扫描阶段原先用 `SearchTimeline` + `conversation_id:<帖子ID>` 翻页抽评论者。实测页面 `reply_count` 与搜索吐出的页数严重不符(例如 76 评论只扫到 2 页): Search 索引不是帖子详情楼的同源接口。

打开 `x.com/.../status/<id>` 时页面走 GraphQL **TweetDetail**, 响在 `threaded_conversation_with_injections_v2`, 回复多在 `conversationthread-*` 模块——与用户看到的评论列表一致。

## Decision

- **扫描主路径 = TweetDetail**(Route 1 `rf_tpl:TweetDetail`, 变量补丁 `focalTweetId` + `cursor`)。
- **兑底 = 原 conversation_id Search**: 未旁听到详情模板, 或详情首屏传输/解析失败时回退, 行为不劣于改前。
- **模板来源**: 用户打开任意帖子详情页一次(webRequest 已按 op 名自动收模板); 不写死 queryId。
- **发射节奏**: 与 Search 共用 `SEARCH_MIN_GAP_MS`(不同路径 tid 池, 但限流桶仍要留余量)。

## Consequences

- 扫全楼能力接近页面评论数; 入队仍受蓝 V / 求粉过滤, `候选+0` 仍可能出现。
- 日志区分 `详情N页, 解析M条` 与 `搜索N页`。
- 自动供血小窗本轮仍只收 SearchTimeline; 详情 tid 靠用户刷帖/开详情页自然供血。
