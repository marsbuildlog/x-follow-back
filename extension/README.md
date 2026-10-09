# XFollowBack — Twitter/X 自动回关认证粉丝

浏览器插件(Chrome / Edge, MV3)。自动回关蓝V认证粉丝, 带限流退避与状态展示。

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

1. 打开 `https://x.com/<你的handle>/verified_followers`, 等页面加载完(顶部会出现 XFollowBack 状态条)
2. 点插件图标 → 「打开控制台」→ 点 **检查捕获**, 确认操作列表里出现 `BlueVerifiedFollowers`(认证粉丝接口的实际名称)
3. 在认证粉丝列表里**点一次「回关」按钮**(为了捕获回关请求 `friendships/create.json`), 再点「检查捕获」确认两个关键接口齐全
4. 点 **拉取认证粉丝** → 观察日志中的分页情况(`第N页: +M, cursor=有/无`), 确认能拉全
5. 点 **关注第 1 个待回关** → 到 x.com 上确认真的关注成功
6. 若第 5 步被拒(`x-client-transaction-id` 校验失败), 记录原始错误 → 启用备选方案(DOM 点击关注按钮, 见下方)

## 工作原理

生产者/消费者架构: 拉取器与回关循环解耦, 队列是唯一交界面。

```
x.com 标签页
├── page-hook.js   (MAIN world, 先于页面脚本)
│     hook fetch/XHR → 捕获页面发出的请求(含全部请求头):
│       GraphQL (/i/api/graphql/...) 按操作名登记, v1.1 REST (/i/api/1.1/...) 按路径登记
│     收到指令时用捕获的请求头模板重放:
│       BlueVerifiedFollowers (GraphQL, 拉认证粉丝)
│       /i/api/1.1/friendships/create.json (v1.1 REST, 回关, 仅替换 user_id)
└── content.js     (隔离世界, 入口唯一文件)
      启动时 await import() 显式加载 shared/constants.js 与 shared/logic.js 并校验挂载
      (⚠ 不用 manifest 多文件列表保证顺序: Chrome 的多文件注入顺序不可靠, 出过 logic.js 未执行的确定性 bug)
      拉取器(生产者): 翻页拉认证粉丝(100/页, 上限500页) → 纯追加合并进队列(不碰已有条目)
        触发: 手动「更新列表」/ 打开页面且距上次拉取超过 autoFetchMin(默认30分钟)
        429 自行退避重试(同一页最多3次), 不影响回关循环
        已关注过滤: 只信列表自带 relationship_perspectives.following
      回关循环(消费者): 只消费 pending, 随机间隔3~8s 逐个关注
        失败处理: 429/88→不标失败, 按 reset 精确等待后重试同一人(连续3次才跳过); remaining=0→主动等重置不吃429
                  403+161→关注上限暂停+每小时探测重试+通知; 纯403→立即暂停(template-expired)+通知
                  请求层连续异常2次→暂停(error)+通知; 连续失败30min→暂停(stalled)+通知
        队列空→done(等待新粉); 拉取器写入新 pending 后自动续跑
        暂停恢复: 手动恢复随时; daily-limit/stalled/error 到点自动尝试; 所有自动暂停发 Chrome 系统通知(带声音)
      状态条: verified_followers 页顶部注入(总数/待回关/今日数/操作按钮)
      数据按账号分键: rf_task:{handle}, rf_daily:{handle}; 换账号互不干扰
options 控制台: 队列表(含失败原始出错信息)/设置/日志/PoC面板
```

注意: 任务跑在打开的 x.com 标签页里, **使用期间请保持一个 x.com 标签页开启**; 关闭后任务暂停, 重新打开会自动接管继续。

## 存储

全部在 `chrome.storage.local`, 任务/今日数按账号分键:

| key | 内容 |
|-----|------|
| `rf_task:{handle}` | 该账号的任务状态机 + 回关队列(每人状态/出错信息/完成时间) + lastFetchAt |
| `rf_daily:{handle}` | `{date, followed}` 该账号今日已关注数 |
| `rf_active` | 最近活跃账号(options/popup 无页面上下文时定位任务) |
| `rf_settings` | 间隔/退避/自动拉取间隔等设置(全局) |
| `rf_lock` | 多标签页领导权锁 |
| `rf_log` | 运行日志(200条, 全局) |

## 备选方案(若重放被 x-client-transaction-id 拦截)

改为 DOM 交互方案: 在 verified_followers 页解析用户卡片, 未关注的直接点击「关注」按钮, 完全走页面自身代码路径(无需自己构造任何请求头)。已在本插件结构下预留切换点(content.js 中的 `callGraphQL` 是唯一请求出口)。
