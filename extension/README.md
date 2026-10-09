# Refollow — Twitter/X 自动回关认证粉丝

浏览器插件(Chrome / Edge, MV3)。自动回关蓝V认证粉丝, 带限流退避、每日上限与状态展示。

需求与决策见 `docs/biz-plan.md`。

## 开发与测试

```bash
npm test        # 仓库根目录运行, 跑核心逻辑单元测试(node ≥ 18, 零依赖)
```

- 纯逻辑(响应解析/错误解释/队列合并/重放构造/停顿判定)全部在 `extension/src/shared/logic.js`, 由 `extension/test/logic.test.js` 覆盖
- 出过 bug 的场景都有回归测试: 字段位置变化(如 relationship_perspectives.following)、重复关注(旧快照引用)、已关注过滤、cursor 永不消失的翻页终止、form body 参数替换
- 改代码后: `npm test` 全绿 → 再重载插件

## 安装(开发者模式)

1. 打开 `chrome://extensions`(Edge: `edge://extensions`)
2. 右上角开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本目录的 `extension/` 文件夹
4. 打开 https://x.com 并登录

## PoC 验证清单(当前阶段目标)

验证两个技术风险点: GraphQL 请求能否在页面上下文重放(关键是 `x-client-transaction-id`)、`verified_followers` 能否翻页拉全。

1. 打开 `https://x.com/<你的handle>/verified_followers`, 等页面加载完(顶部会出现 Refollow 状态条)
2. 点插件图标 → 「打开控制台」→ 点 **检查捕获**, 确认操作列表里出现 `BlueVerifiedFollowers`(认证粉丝接口的实际名称)
3. 在认证粉丝列表里**点一次「回关」按钮**(为了捕获回关请求 `friendships/create.json`), 再点「检查捕获」确认两个关键接口齐全
4. 点 **拉取认证粉丝** → 观察日志中的分页情况(`第N页: +M, cursor=有/无`), 确认能拉全
5. 点 **关注第 1 个待回关** → 到 x.com 上确认真的关注成功
6. 若第 5 步被拒(`x-client-transaction-id` 校验失败), 记录原始错误 → 启用备选方案(DOM 点击关注按钮, 见下方)

## 工作原理

```
x.com 标签页
├── page-hook.js   (MAIN world, 先于页面脚本)
│     hook fetch/XHR → 捕获页面发出的请求(含全部请求头):
│       GraphQL (/i/api/graphql/...) 按操作名登记, v1.1 REST (/i/api/1.1/...) 按路径登记
│     收到指令时用捕获的请求头模板重放:
│       BlueVerifiedFollowers (GraphQL, 拉认证粉丝)
│       /i/api/1.1/friendships/create.json (v1.1 REST, 回关, 仅替换 user_id)
└── content.js     (隔离世界)
      任务执行器: 拉粉丝→过滤已关注→逐个关注(随机间隔30~90s)
      失败处理: 429/88→退避15min; 161→当日停止; 连续失败30min→暂停
      暂停恢复: 手动恢复; 未恢复则每小时自动尝试
      状态条: verified_followers 页顶部注入(进度/今日数/操作按钮)
      状态持久化: chrome.storage.local, 刷新/重开浏览器可恢复
options 控制台: 队列表(含失败原始出错信息)/设置/日志/PoC面板
```

注意: 任务跑在打开的 x.com 标签页里, **使用期间请保持一个 x.com 标签页开启**; 关闭后任务暂停, 重新打开会自动接管继续。

## 存储

全部在 `chrome.storage.local`:

| key | 内容 |
|-----|------|
| `rf_settings` | 每日上限/间隔/退避等设置 |
| `rf_daily` | `{date, followed}` 今日已关注数 |
| `rf_task` | 任务状态机 + 回关队列(每人状态与出错信息) |
| `rf_lock` | 多标签页领导权锁 |
| `rf_log` | 运行日志(200条) |

## 备选方案(若重放被 x-client-transaction-id 拦截)

改为 DOM 交互方案: 在 verified_followers 页解析用户卡片, 未关注的直接点击「关注」按钮, 完全走页面自身代码路径(无需自己构造任何请求头)。已在本插件结构下预留切换点(content.js 中的 `callGraphQL` 是唯一请求出口)。
