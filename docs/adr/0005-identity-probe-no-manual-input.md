# 身份识别: background 探针免输入, 手填用户名废除

Popup 曾让用户手填自己的用户名来拼接认证粉丝页 URL——与登录账号不一致时,拉取/回关会写进错误任务键(错配源头,ADR-0003 同类问题的 UI 层残留)。手填存在的唯一理由:身份识别链(whoami)依赖已打开的 x.com 页面,首次安装/未开页面时无解。

## Decision

- background 新增**身份探针**:读 ct0 cookie + bearer(收割优先,x.com 公共 web bearer 预置兜底)直接调 `GET /i/api/1.1/account/settings.json`,取 `screen_name` 写入 `rf_active`。
- 触发点:SW 冷启动 + popup/控制台打开时(消息 `identity-probe`)。成功缓存 10 分钟;失败(429 等)负缓存 5 分钟,与 page-hook whoami 同策略。
- **Popup 输入框删除**。探针失败(未登录/限流窗口)→ 按钮变「打开 x.com 完成识别」,登录后由 content script 的 whoami 被动嗅探链接管——全程零手动输入,错配类错误根治。
- 公共 bearer 说明:x.com 前端 JS 内置的公共 token,非用户专属,开源生态普遍内置;收割到的动态值始终优先,常量只在空窗期兜底。

## Consequences

- 已登录前提下,安装即自动识别,认证粉丝页一键直达。
- settings.json 429 窗口内 popup 短暂显示「未识别」,打开 x.com 后由页面链兜底;两套识别同源(settings.json/Viewer),不冲突。
- 公共 bearer 若被 X 轮换:探针退化为「开过 x.com 后才可识别」(收割 bearer 接管),无硬故障。

## Amendment (2026-10-11): 冷却跨账号误伤 + /home 无识别触发器

实测两个缺陷: ①旧账号 429 写入的冷却(最长 15 分)在换号后依然生效——但限额桶按账号计, 新账号本可立即探; ②「打开 x.com 完成识别」打开的是 /home, 而页面侧唯一入口 pageHandle 要求 URL 含 handle, /home 上 whoami 永远不跑——按钮闭环断裂。

修复:
- 探针: `cookies.onChanged` 监听 auth_token 变化即作废探针缓存(换号=新限额桶); 无活跃账号时失败冷却降为 45s(识别不出是最贵状态, 多一发失败请求无害), 有账号时维持 5 分钟。
- 页面: autoTick 在 active 为空时直接调 whoamiHandle(不限 URL handle)——任意 x.com 页面 30s 内可建立身份, 内部负缓存防扛接口。

## Amendment (2026-10-11 晚): 双水源 + 全局闸门

实测 settings.json 对探针调用返回 404(疑似也开始校验 tid), 页面侧 whoami 链同样依赖它——三条识别路径单点。且 SW 冷启动探针用内存态冷却, 被 webRequest 事件高频唤醒时反复裸发, 曾把小限额桶打成 429 风暴。

- 全局闸门 `rf_whoami_gate`(storage): 探针与页面 whoami 链共享, 跨重启/跨标签页; 60s 内任何一方刚试过就不叠, 失败按 retryAt 冷却(429 用服务端窗口), 成功 10 分钟内互认。
- 水源② HTML 内嵌身份: X 前端自己已不从 API 拿登录身份, 身份在页面 SSR HTML。锚点 = twid cookie(数字 uid) ↔ HTML 中同 uid 用户对象的 screen_name, 双重匹配不误认。探针先试 settings.json(便宜), 失败落 HTML 水源(重但稳: 页面能登上就识别得出)。

## Amendment (2026-10-11 晚二): 实测 + DOM 锚点转正

HTML 水源实测未中(home SSR 里无内嵌用户对象, screen_name 仅 2 处), 但诊断确认了真锚点: 侧栏「个人资料」标签(`AppTabBar_Profile_Link`)永远指向当前登录账号, 多账号不误——ADR-0003 否的是账号切换器(首链接可能是别人), Profile 标签无此问题, 转正为页面侧首选身份源(零请求, 同步读)。链路: whoami(API, 带闸门) → Profile 标签 DOM → 切换器(兼容兑底) → rf_active; autoTick 心跳接管(启动时立即执行一跳, 新装页面 1~2s 内识别)。实测多账号切换下识别正确。
