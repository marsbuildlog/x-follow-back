# 手动关注兜底: 页面点「关注」撞额度的失败自动收进主动关注队列

## Context

用户在 X 上浏览时会遇到想关注的博主, 但当日关注额度(错误码 161)已耗尽, 手动点「关注」只会得到一个报错 toast——意图流失: 事后既记不住是谁, 也不会再回去点。插件侧已有完善的额度恢复机制(161 暂停→每小时探测), 缺的只是"把这一次失败意图接住"。

## Decision

**捕获点在 page-hook(MAIN world)**: 它已 hook fetch/XHR, 对 `POST /i/api/1.1/friendships/create.json`(页面自己的关注按钮与插件回关同端点)额外读取响应体(clone 后读, 不消费原响应流)。判定用 logic.js 纯函数 `isFollowLimitFailure`:
- HTTP 429, 或 403 包 `errors[].code = 161`(单日上限)/`88`(限流), 或响应文本含 "unable to follow more / follow limit / rate limit" → 额度类失败;
- 160(已关注)、保护账号(108)等其它失败**不收**——它们没有"稍后补关注"的价值。
命中后从请求 body 提取 `user_id`/`screen_name`, 存 `failedFollows`(按 userId 去重, 最多 50 条)。

**消费点在 content(`pollManualFollows`, ensureBar 每 5s)**:
- `take-failed-follows` 取走即清; 身份未知时不取(留给下轮), 不丢记录;
- **意图分诊**: 在自己的认证粉丝页(`/handle/verified_followers`)上的失败 = 回关意图, 目标必是已关注自己的人, 回关自动拉取会自然把它们收进回关队列 → 不重复入主动关注; 其余任意页面(逛主页/搜索/时间线/别人的关注列表)= 主动关注意图 → 入主动关注队列;
- 经 `enqueueAfCandidates` 入队: **显式人工意图 → 不做蓝V/求粉特征过滤**(用户自己点的关注, 过滤等于违背意图); 队列 userId 去重与回关队列互斥照旧;
- done 状态自动续跑(既有逻辑), 系统通知确认"已记入稍后关注"。

## Considered Options

- **webRequest 在 background 拦截**: 否。MV3 webRequest 读不到响应体, 判不了 161。
- **在认证粉丝页的失败也入主动关注**: 否。那里的目标是已关注自己的人, 语义是回关; 且回关拉取(≤30min)必然覆盖, 双队列重复入队只会制造混乱。
- **让用户手动维护"想关注"清单(粘贴 @handle)**: 交互成本高且违背"顺手点一下"的真实动线, 拦截零成本接住意图; 未来若需要可作为补充, 不替代本机制。
- **失败后立刻由插件重试关注**: 否。额度没恢复, 重试只会撞墙并加深限流; 入队走既有循环节奏(回关优先+随机间隔)才安全。

## Consequences

- 额度恢复的唤醒依赖既有机制: 161 会触发循环级暂停+每小时自动探测恢复(ADR-0001), 队列里的人届时按节奏被补关注;
- 若对方在额度恢复前改名/注销, 关注会以 userId 重试失败并标记 failed(队列可见), 无额外处理;
- page-hook `hookVersion` 3→4; `recent` 流水里关注路径额外携带 body(含 user_id, 无凭证), 仅用于失败捕获。
