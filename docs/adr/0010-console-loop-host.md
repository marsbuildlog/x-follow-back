# 循环宿主迁到控制台(options)

## Context

Route 1(ADR-0004)与回关直连(Phase 2)落地后, 关注/搜索/扫描的**传输**已不依赖 x.com 页面重放。
用户仍须开着任意 x.com 标签页, 只因**长任务编排**(循环、429 等待、连扫)仍宿主在 content script。
目标 UX: 用户常开控制台盯进度; 缺模板/tid 时控制台引导开页旁听, 旁听成功即可关页。

## Decision

1. **循环宿主 = options 页**(常开扩展页)。长任务(关注循环、手动连扫、抓取编排、断供补池时钟下的自动抓取、未回关名单 Following 翻页拉取)在控制台跑; **不**搬进 MV3 SW(与 ADR-0006 同论: SW 会被杀)。
2. **x.com 降为临时供血/兑底页**: webRequest 旁听 GraphQL/`create.json`、Route 1 传输失败时的页面重放、身份 DOM 兑底。控制台「就绪清单」缺哪项亮哪项并一键开页。
3. **宿主在线 = 控制台心跳**(`rf_console_host`, 约 15s 内有更新)。关掉控制台 → 循环让出领导权并通知(对标旧「关光 x.com」)。
4. **content 兼容**: 控制台心跳存活时, content **不**抢跑循环/抓取/连扫; 仅当控制台离线时 content 仍可作兜底宿主(旧行为), 浮层提示优先打开控制台。
5. **ADR-0007 不变**(选 A): 逛 X 时 page-hook 静默接住撞额度失败; **不是**控制台依赖。

## Consequences

- options 须常开才能无人值守跑循环; 被浏览器挂起时靠 heartbeat + 可选 `chrome.alarms` 巡检(整段 sleep 仍不在 SW)。
- 兑底重放仍需瞬时存在已注入的 x.com 标签页且旁听过 `create.json`。
- 修订 ADR-0004/0006 中「循环必须留在 x.com」的表述。
