# tid 来源: 生成器路线否决, 定案 webRequest 被动收割池

主动关注/回关的重放都依赖 `x-client-transaction-id`(tid)。此前 tid 只能从打开的 X 标签页被动捕获, 于是有了"能否用生成器自己造 tid, 彻底脱离页面"的问题。2026-10-10 对开源生成器做了真实请求验证, 结论:**不可用, 且短期内不会可用**。

## 实测(2026-10-10, 同刻对照法, 4 发)

同一份 SearchTimeline 捕获模板, 只换 tid:

| tid 来源 | 结果 |
|---|---|
| 页面捕获的原 tid(基线) | 200, 正常结果 |
| swyxio/XClientTransactionJS(2025-07 JS 移植)生成的 | 404 空 body |
| 原 tid 再打(隔离模板/冷却变量) | 200 —— 404 只能归因于生成的 tid 被服务端拒绝 |
| 父库 iSarabjitDhiman/XClientTransaction v1.0.3(2026-06)生成的 | 404 空 body |

测试输入无瑕疵: 当天登录态首页 HTML + 按新版索引表格式(`,59924:"ondemand.s"` 两步查 hash)手工提取的真实 ondemand.s 文件, 生成路径所需材料齐全。

## 三层坏死原因

1. **JS 移植停在 2025-07**: `getOndemandFileUrl` 还在找旧格式 `'ondemand.s':'hash'`, 该格式已从页面消失——装上即挂;
2. **父库 v1.0.3 算法核心也被拒**: 2026-07 底 X 前端整体迁移到 x-web 新架构(入口脚本 `responsive-web` → `x-web`), 密钥材料位置与校验逻辑已变;
3. **生态全灭**: 父仓库 2026-07-25 起连续 4 个 issue 报挂, 最新修复 PR(2026-09-28, 改从 /i/jf/ 取数据)尚未合并——当前不存在任何已知可用的开源实现。

## Decision

- **否决生成器路线**(含自研与第三方): X 的挑战文件/校验随前端架构轮换, 追不动; 复测方法=本文的同刻对照法(新模板基线 200 + 生成 tid 404 即仍失效), 生态若复活按此一键验证。
- **定案 webRequest 被动收割池**: background SW 旁听 x.com API 请求头, 把页面自己产生的 tid 存入 `rf_tid_pool`(带捕获路径与时间), 重放时按路径取用、60 秒冷却内轮换, 尽量复用。
- **池子按路径分捡**: ADR-0002 已证 tid 跨查询可用, 但**跨路径未证实**(tid 生成时哈希了 method+path, 服务端很可能校验)。池子优先同路径 tid, 无同路径可用再考虑跨路径(待专门实验放行)。
- **接受架构事实**: 彻底无人值守暂不可达(池子需要页面活动供血)。缓解: 池子见底时自动开非聚焦小窗收割几秒再关——**已落地**(见下文 Amendment「遗留B」); 平时用户正常刷 X 即持续供血。
- **搜索拉取从 10 页减到 4 页**(产品决策, 用户拍板): 每轮搜索更轻, 配合池子轮换时间大幅缩短。
- **搜索拉取再 4 页减到 1 页**(2026-10-11 产品决策): 一页 20 帖足够——帖子只负责"被发现",
  候选人主要来自扫描阶段的帖内评论回复者, 多页收益递减且加倍消耗限流桶。

## Consequences

- Route 1(脱离 X 标签页跑循环)的 tid 供给=收割池; 运行期无 X 页面时依赖池子存量(每个 tid 60 秒 1 发, 存量 N 个 ≈ N 发/分钟)。
- manifest 新增 `webRequest` 权限(纯旁听, 不改写)。
- 生成器路线的重新评估门槛: 上述任一开源库在其最新版能通过同刻对照实验。

## Amendment (2026-10-11): Route 1 已落地——搜索/扫描传输切直连

同刻对照实验通过(options 控制台「Route 1 直连实验」卡片, 分步进度走 rf_r1_probe):
- full(页面原头+三件套)→ 200;**minimal(bearer + csrf + tid 三件套)→ 也 200**,页面原头非必需
- 循环迁移: content `searchPage` 优先 `route1-graphql`(background 直连),结构性缺料才回退页面内重放
- 实施中新发现(均有日志实证):
  1. **cursor 绑定会话变量基准**(product 等): 翻页跨基准 → `MalformedCursor: Unknown request cursor`;两条传输路径的变量基准统一取 rf_tpl 首见形状
  2. **被 X 完整处理过的失败(如 422 校验)同样启动 tid 冷却计时**(422 后 30s 同 tid → 404 空 body);ADR-0002 的"失败不延长冷却"仅适用 404 空 body(拒绝型)。route1Graphql 对非 404 的 4xx 按"已消耗"记 ok 提前轮换
- 切换后收益: 扫描/搜索不再依赖"互关标签页开着且本页捕获过 SearchTimeline",浏览器刚重启即可跑
- 遗留B已实现(2026-10-11): 自动供血——池见底(route1Graphql 无同路径可用 tid)时开**非聚焦独立小窗**收 3 发
  SearchTimeline(反馈驱动: 每轮等池子真入库再翻页, 8s 不出活提前收工), 完事自关, 70s 冷却后轮换可用;
  options 控制台有「手动供血」手动档。实施教训: ①后台页签整页加载 5~9s, 盲等 4s 必扑空;
  ②active:false 页签 visibilityState=hidden, x.com 路由级取数被可见性门控(应用启动但搜索不发)——
  非聚焦窗口内选中标签 visibility=visible, 不抢焦点照常发请求 ③await 漏写让轮询 Promise
  恒真值, "106ms 收满 3 发"秒关页面——逐轮诊断字段(rounds/winCreateMs)是抓出它的关键
- BlueVerifiedFollowers 拉取已同法迁移(2026-10-11): route1-graphql 契约泛化成 vars 变量补丁
  (mergeVariables 纯函数, null 值删键——screen_name 剔除/cursor 缺省删除), 实测页1直连 200、
  页2+池空自动回退, 混合传输 cursor 连续(基准已统一)。拉粉节奏快(1~2s/页) tid 消耗大,
  自动供血小窗只收 SearchTimeline 路径, 粉丝路径靠页面在场自然供血(回关循环本就要求页面开着)
- 回关动作 friendships/create.json Route 1 已切生产(2026-10-19 Phase 2): background 直连
  (bearer+csrf, tid 拒收时再试池内跨路径 tid), 仅传输失败兑底页面重放; 业务响应不重放防双关。
  关注循环**不搬进 SW**(长任务/限流等待与 ADR-0006 同论); 宿主已迁到常开控制台(ADR-0010),
  x.com 仅供血/兑底/ADR-0007。
