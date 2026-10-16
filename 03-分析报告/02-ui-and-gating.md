# 02 — OpenCode Desktop：UI / 壳层 与 FREE 门禁分析

调查者：teammate `ui-gate`（task-2）
版本：`desktop@1.19.2`（`out/renderer/assets/zh-B5Hw0C7Y.js:5` → `e.SENTRY_RELEASE = { id: "desktop@1.19.2" }`）
证据根目录：解包产物 `99-解包产物与运行时残留\OpenCode-Desktop-1.19.2-解包\`；运行期状态 `%APPDATA%\ai.opencode.desktop\`
方法：只读静态分析（grep/局部 read）+ 只读读取本机持久化状态文件；未修改任何用户配置，未重启进程。

---

## 0. 结论速览（TL;DR）

1. 「FREE 模型限制」的**唯一门禁在服务端 + 核心（core）**：客户端仅按响应体字符串 `FreeUsageLimitError` / `GoUsageLimitError` 分流。渲染层没有任何额度计数、缓存或阈值。
2. 弹窗由 `session.status`（`status.type === "retry"` 且带 `action`）事件驱动，按 `action.reason` 分两支：`free_tier_limit` → 「Free limit reached / 订阅」；`account_rate_limit` → 「Go limit reached / Open settings」。
3. **本机已经永久关闭了免费额度弹窗**：`opencode.global.dat` 的 `go-upsell` 值里 `go_upsell_dont_show` 已被写入时间戳（见 §3 实测值）。因此本机不会再弹窗，用户只能看到重试错误卡片里的英文文本 `Free usage exceeded, subscribe to Go`。
4. 弹窗的「Open settings」**并不打开应用内设置**：它只调用 `platform.openExternal(props.link)` 打开网页 `https://opencode.ai/workspace/<workspace>/go`。设置页里根本没有额度/余额/订阅页，也没有 "enable usage from your available balance" 开关。
5. 免费额度弹窗的「Subscribe」是双动作：先外开 `https://opencode.ai/go`，再在应用内打开 provider 连接弹窗并预选 `opencode-go`。
6. 模型选择器里的「免费」标签判定 = `provider.id === "opencode" && (!cost || cost.input === 0)`；`opencode-go` 不算免费。分组排序把 `opencode` 固定在第一。
7. 客户端唯一的"写死阈值"是弹窗节流 `GO_UPSELL_WINDOW = 864e5`（24h）；真正的重试次数/退避写死在 core：`RETRY_MAX_RETRIES = 5`、`RETRY_INITIAL_DELAY = 2e3`。
8. 英文用户走「服务端原文直出」分支，非英文用户走 i18n 分支 —— 两个分支文案不同（非英文丢失动态的 `It will reset in X`）。

---

## 1. 弹窗完整逻辑与 reason 分流

### 1.1 常量与 key（`out/renderer/assets/main-C07s90t2.js`）

```js
152553: const GO_UPSELL_FREE_TIER_LAST_SEEN_AT = "go_upsell_last_seen_at";
152554: const GO_UPSELL_FREE_TIER_DONT_SHOW = "go_upsell_dont_show";
152555: const GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT = "go_upsell_account_rate_limit_last_seen_at";
152556: const GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW = "go_upsell_account_rate_limit_dont_show";
152557: const GO_UPSELL_WINDOW = 864e5;
152558: const GO_UPSELL_PROVIDERS = /* @__PURE__ */ new Set(["opencode", "opencode-go"]);
```

### 1.2 provider 白名单与 reason → key 映射

```js
152559: function goUpsellKeys(status2) {
152560:   if (status2.type !== "retry" || !status2.action) return;
152561:   const { action } = status2;
152564:   if (!GO_UPSELL_PROVIDERS.has(action.provider)) return;   // ← 只有 opencode / opencode-go 才弹
152565:   if (action.reason === "free_tier_limit") {
152566:     return { lastSeenAt: GO_UPSELL_FREE_TIER_LAST_SEEN_AT, dontShow: GO_UPSELL_FREE_TIER_DONT_SHOW };
152570:   }
152571:   if (action.reason === "account_rate_limit") {
152572:     return { lastSeenAt: GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT, dontShow: GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW };
152576:   }
152577: }
```

### 1.3 监听与节流（hook `useUsageExceededDialogs()`，`main-C07s90t2.js:152578`）

```js
152588:   const isEnglish = () => locale2() === "en";
152589:   const [goUpsellState, setGoUpsellState] = persisted(Persist.global("go-upsell"), createStore({
152590:     [GO_UPSELL_FREE_TIER_LAST_SEEN_AT]: null,
152591:     [GO_UPSELL_FREE_TIER_DONT_SHOW]: null,
152592:     [GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT]: null,
152593:     [GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW]: null
152594:   }));
152595:   onCleanup(sdk().event.on("session.status", (evt) => {
152596:     if (evt.properties.sessionID !== params.id) return;      // ← 只对"当前会话"生效
152597:     if (evt.properties.status.type !== "retry") return;
152598:     const { action } = evt.properties.status;
152601:     if (!action) return;
152602:     if (dialog.active) return;                                // ← 已有任意弹窗打开则放弃本次（不排队）
152603:     const keys2 = goUpsellKeys(evt.properties.status);
152604:     if (!keys2) return;
152605:     const seen2 = goUpsellState[keys2.lastSeenAt];
152606:     if (seen2 && Date.now() - seen2 < GO_UPSELL_WINDOW) return;   // ← 24h 冷却
152607:     if (goUpsellState[keys2.dontShow]) return;                    // ← 永久静音
```

要点：
- 冷却窗口 `864e5` ms = **24 小时**；`dontShow` 是**永久**（无过期）。
- 两个 reason **各自独立**的 `lastSeenAt` / `dontShow`。
- `dialog.active` 时不弹、也不重试；且不记录 `lastSeenAt`（下次事件仍可弹）。

### 1.4 两支分流与英文直出

`free_tier_limit`（`main-C07s90t2.js:152608-152635`）：

```js
152608:     if (action.reason === "free_tier_limit") {
152609:       dialog.show(() => createComponent(DialogUsageExceeded, {
152610:         get title() {
152611:           return memo$2(() => !!isEnglish())() ? action.title : t2("dialog.usageExceeded.freeTier.title");
152613:         get description() {
152614:           return memo$2(() => !!isEnglish())() ? action.message : t2("dialog.usageExceeded.freeTier.description");
152616:         get actionLabel() {
152617:           return memo$2(() => !!isEnglish())() ? action.label : t2("dialog.usageExceeded.freeTier.actionLabel");
152619:         get link() { return action.link; },
152622:         onClose: (dontShowAgain) => {
152623:           setGoUpsellState(keys2.lastSeenAt, Date.now());
152624:           if (dontShowAgain) setGoUpsellState(keys2.dontShow, Date.now());
152625:           else {
152626:             void __vitePreload(() => import("./dialog-connect-provider-B_bhWspV.js").then((n2) => n2.d), ...).then((x2) => {
152627:               const controller = x2.useProviderConnectController();
152628:               controller.select("opencode-go");
152629:               void dialog.show(() => createComponent(x2.DialogConnectProvider, { controller }));
152630:             });
152633:           }
152634:         }
```

`account_rate_limit`（`main-C07s90t2.js:152636-152654`）：

```js
152636:     } else if (action.reason === "account_rate_limit") {
152639:           return memo$2(() => !!isEnglish())() ? action.title : t2("dialog.usageExceeded.accountRateLimit.title");
152642:           return memo$2(() => !!isEnglish())() ? action.message : t2("dialog.usageExceeded.accountRateLimit.description");
152645:           return memo$2(() => !!isEnglish())() ? action.label : t2("dialog.usageExceeded.accountRateLimit.actionLabel");
152647:         get link() { return action.link; },
152650:         onClose: (dontShowAgain) => {
152651:           setGoUpsellState(keys2.lastSeenAt, Date.now());
152652:           if (dontShowAgain) setGoUpsellState(keys2.dontShow, Date.now());
152653:         }
```

**English 直出 vs i18n 分支差异**（`isEnglish = () => locale() === "en"`，`main-C07s90t2.js:152588`）：

| | English（`locale === "en"`） | 非 English（含 zh） |
|---|---|---|
| title | 服务端 `action.title` = `Free limit reached` / `Go limit reached` | `dialog.usageExceeded.*.title` |
| description | 服务端 `action.message` | `dialog.usageExceeded.*.description` |
| actionLabel | 服务端 `action.label` = `subscribe` / `open settings`（**小写**） | `…actionLabel` = `订阅` / `打开设置` |
| 动态信息 | `account_rate_limit` 的 message 含 `It will reset in <days/hours/minutes>`（core 拼装） | **丢失**，i18n 静态串为 `Usage limit reached. To continue using this model now, enable usage from your available balance` |

### 1.5 弹窗组件本体

```js
152510: function DialogUsageExceeded(props) {
152514:   const runAction = () => {
152515:     if (props.link) platform2.openExternal(props.link);
152516:     props.onClose?.();          // ← 注意：不传参 ⇒ dontShowAgain === undefined（falsy）
152517:     dialog.close();
152518:   };
152519:   const dismiss3 = () => {
152520:     props.onClose?.(true);      // ← 「不再显示」路径
152521:     dialog.close();
152522:   };
...
152533:     insert(_el$2, createComponent(Button, { variant: "ghost", size: "large", onClick: dismiss3,
152538:           return language.t("dialog.usageExceeded.dontShowAgain");
152541:     insert(_el$2, createComponent(Button, { variant: "primary", size: "large", onClick: runAction,
152546:           return props.actionLabel;
```

⇒ 主按钮（`Subscribe` / `Open settings`）点击后一律：
1. `openExternal(action.link)`；
2. `onClose(undefined)` ⇒ `free_tier_limit` 走 **else 分支**，额外打开应用内 provider 连接弹窗并 `controller.select("opencode-go")`（152626-152632）；`account_rate_limit` 走**空**分支（只写 `lastSeenAt`）。

> **重要偏差**：`account_rate_limit` 的按钮文案是 `Open settings` / `打开设置`，但渲染层**不会打开设置对话框**，只打开 `action.link` 指向的网页。设置页里也确实没有对应开关（见 §5）。

---

## 2. 弹窗动作目标：URL / 深链

core（`out/main/chunks/node-ibnNxpSl.js`，`retryable(error, provider9)`，函数起于 441406）：

```js
441411:     if (!error.data.isRetryable && !(status2 !== void 0 && status2 >= 500) && !matchesRetryableMessage(error.data.message) && !matchesRetryableMessage(error.data.responseBody))
441412:       return;
441413:     if (error.data.responseBody?.includes("FreeUsageLimitError")) {
441414:       return {
441415:         message: GO_UPSELL_MESSAGE,
441416:         action: {
441417:           reason: "free_tier_limit",
441418:           provider: provider9,
441419:           title: "Free limit reached",
441420:           message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
441421:           label: "subscribe",
441422:           link: GO_UPSELL_URL
441423:         }
441424:       };
441425:     }
441426:     if (error.data.responseBody?.includes("GoUsageLimitError")) {
441427:       const body22 = parseJSON13(error.data.responseBody);
441428:       const workspace = str3(body22?.metadata?.workspace);
441429:       const limitName = str3(body22?.metadata?.limitName);
441430:       const retryAfter = num(error.data.responseHeaders?.["retry-after"]);
...  (resetIn 由 retry-after 换算 day/hour/minute，441431-441444)
441445:       const message7 = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`;
441446:       const link2 = `https://opencode.ai/workspace/${workspace}/go`;
441447:       return {
441448:         message: `${message7} - ${link2}`,
441449:         action: {
441450:           reason: "account_rate_limit",
441451:           provider: provider9,
441452:           title: "Go limit reached",
441453:           message: message7,
441454:           label: "open settings",
441455:           link: link2
441456:         }
441457:       };
441458:     }
```

常量（`out/main/chunks/node-ibnNxpSl.js:441519`）：

```js
441519: var GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go", GO_UPSELL_URL = "https://opencode.ai/go",
        RETRY_INITIAL_DELAY = 2e3, RETRY_BACKOFF_FACTOR = 2, RETRY_JITTER_FACTOR = 0.25,
        RETRY_MAX_DELAY_NO_HEADERS = 3e4, RETRY_MAX_DELAY = 2147483647, RETRY_MAX_RETRIES = 5, ...
```

动作目标汇总：

| reason | 弹窗按钮 | `action.link` | 实际动作 |
|---|---|---|---|
| `free_tier_limit` | `Subscribe` / `订阅` | `https://opencode.ai/go` | 外开网页 + 应用内打开 provider 连接弹窗并预选 `opencode-go` |
| `account_rate_limit` | `Open settings` / `打开设置` | `https://opencode.ai/workspace/<workspace>/go` | 仅外开网页（**不打开设置对话框**） |

外开实现：`out/preload/index.js:95` → `openExternal: (url) => electron.ipcRenderer.send("open-external", url)`。

`enable usage from your available balance`：**客户端无任何对应开关**。全树搜索 `available balance|availableBalance|useBalance|enableUsage|usage_from|use_balance` 只命中两处文案（`out/main/chunks/node-ibnNxpSl.js:441445` 的 core message 与 `out/renderer/assets/main-C07s90t2.js:10795` 的 i18n description）。该开关在**服务端/网页控制台**。

---

## 3. 24h 冷却与「不再显示」的存储位置与 key

### 3.1 逻辑位置
- 存储目标：`persisted(Persist.global("go-upsell"), …)`（`main-C07s90t2.js:152589`）
- `Persist.global(key, legacy)`（`main-C07s90t2.js:49241-49244`）：
  ```js
  49241: const Persist = {
  49242:   global(key2, legacy) {
  49243:     return { storage: GLOBAL_STORAGE, key: key2, legacy };
  49244:   },
  ```
- `GLOBAL_STORAGE` 定义（`main-C07s90t2.js:48876-48877`）：
  ```js
  48876: const LEGACY_STORAGE = "default.dat";
  48877: const GLOBAL_STORAGE = "opencode.global.dat";
  ```
- Desktop 分支（`main-C07s90t2.js:49314-49325`）：`isDesktop → platform2.storage?.(config2.storage)`，即 preload 的 `storeGet/storeSet`（`out/preload/index.js:67-72`）→ IPC `store-get` / `store-set`（`out/main/index.js:2123-2150`）→ 文件 `join(app.getPath("userData"), name)`（`out/main/index.js:1157`）。

**落地路径**：`%APPDATA%\ai.opencode.desktop\opencode.global.dat` → JSON 顶层 key `"go-upsell"` → 其值是一段**序列化后的 JSON 字符串**。

### 3.2 本机实测值（只读）
文件：`%APPDATA%\ai.opencode.desktop\opencode.global.dat`

```json
	"go-upsell": "{\"go_upsell_last_seen_at\":1789396439021,\"go_upsell_dont_show\":1789396439021,\"go_upsell_account_rate_limit_last_seen_at\":null,\"go_upsell_account_rate_limit_dont_show\":null}"
```

**结论**：本机 `go_upsell_dont_show` 已置为时间戳（且与 `last_seen_at` 相同 ⇒ 用户点的是「不再显示」而非主按钮）⇒ **免费额度弹窗在本机永久不再出现**；`account_rate_limit` 两项仍为 `null` ⇒ Go 限额弹窗**仍会弹一次**（并受 24h 冷却约束）。

---

## 4. 模型选择器里的「免费」标识 / 排序 / 降级提示

### 4.1 判定函数（写死）

```js
// main-C07s90t2.js:122461（模型选择列表）
const isFree = (provider, cost) => provider === "opencode" && (!cost || cost.input === 0);

// main-C07s90t2.js:127735（新版未付费模型选择器）
const isFree2 = (item) => item.provider.id === "opencode" && (!item.cost || item.cost.input === 0);
127736:   const freeModels = createMemo(() => model.list().filter(isFree2));
```

- **只有 `provider.id === "opencode"` 的模型会被标记为免费**；`opencode-go` 不标免费。
- `!cost`（无成本元数据）也判为免费 —— 这是"免费"标签可能误标的口径。

### 4.2 标签渲染

```js
122540:       insert(_el$, createComponent(Show, {
122541:         get when() { return isFree(i2.provider.id, i2.cost); },
122545:           return createComponent(Tag$1, { get children() { return language.t("model.tag.free"); } });
122552:       insert(_el$, createComponent(Show, { get when() { return i2.latest; } ... t("model.tag.latest")
```

Tooltip 标题也会追加 `Free`（`main-C07s90t2.js:122223-122236`）：

```js
122223:   const title = () => {
122224:     const tags = [];
122225:     if (props.latest) tags.push(language.t("model.tag.latest"));
122226:     if (props.free) tags.push(language.t("model.tag.free"));
122227:     const suffix = tags.length ? ` (${tags.join(", ")})` : "";
122228:     return `${sourceName(props.model)} ${props.model.name}${suffix}`;
```

`props.free` 来自 `isFree(item.provider.id, item.cost)`（`main-C07s90t2.js:122521-122522`）。

### 4.3 排序：`opencode` 恒排第一

```js
76691: const popularProviders = [
76692:   "opencode",
76693:   "opencode-go",
76694:   "anthropic",
76695:   "github-copilot",
76696:   "openai",
76697:   "google",
76698:   "openrouter",
76699:   "vercel"
76700: ];
76701: const popularProviderSet = new Set(popularProviders);
```

```js
122503:     sortGroupsBy: (a2, b2) => {
122504:       const aProvider = a2.items[0].provider.id;
122505:       const bProvider = b2.items[0].provider.id;
122506:       if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1;
122507:       if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1;
122508:       return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider);
122509:     },
```

以及另一处 `sortModelGroups`（`main-C07s90t2.js:122464-122473`）同口径。组内按 `name.localeCompare` 排序（`122501`）。

### 4.4 功能降级提示
- **客户端没有任何针对免费模型的"功能降级"提示或降级逻辑**：`isFree` / `isFree2` 只用于显示标签（`grep isFree` 仅命中 122461/122522/122542/122978/123012/127735/127818）。
- 未付费/未连接时的替代入口是另一个选择器 `DialogSelectModelUnpaidV2`（`main-C07s90t2.js:127722`；旧版 `DialogSelectModelUnpaid` 于 `123143`），由 `onUnpaidClick` 打开（`129716`）：
  ```js
  127720: const featuredProviders = ["opencode", "opencode-go", "openai", "anthropic", "google", "github-copilot"];
  127721: const displayModelName = (name2) => name2.replace(/\s+(?:\(free\)|free)$/i, "");
  127737:   const openProviders = (provider) => { ... controller.select(provider); ... }
  ```
  该弹窗含 `dialog.model.unpaid.freeModels.title`（`127793`）、`dialog.model.unpaid.addMore.title`（`127861`）、`dialog.model.unpaid.viewMoreProviders`（`127902`）——**注意 `displayModelName` 会把模型名里的 ` (free)` / `free` 后缀剥掉**，即免费模型在列表里主要靠 Tag 而非名字区分。

---

## 5. 设置页中的额度 / 余额 / 用量 UI

**结论：不存在额度/余额/账单/订阅设置页。**

设置页枚举（i18n key，`main-C07s90t2.js:50665-50701`）：

```
50665: "settings.shortcuts.title": "Keyboard shortcuts",
50681: "settings.providers.title": "Providers",
50692: "settings.models.title": "Models",
50694: "settings.agents.title": "Agents",
50696: "settings.commands.title": "Commands",
50698: "settings.mcp.title": "MCP",
50700: "settings.permissions.title": "Permissions",
（General 段：50535-50664）
```

- 对 `out/renderer/assets/dialog-settings-BURAy5dR.js` 与新版 `out/renderer/assets/index-DJY-56lK.js` 搜索 `usage|limit|balance|billing|subscription`：**仅命中 `opencode-go` 的推荐标签/文案**，无任何额度面板。
- 唯一与 `opencode-go` 相关的 UI：
  ```js
  // dialog-settings-BURAy5dR.js:1110-1115（PROVIDER_NOTES）
  1110: const PROVIDER_NOTES = [{
  1111:   match: (id) => id === "opencode",
  1112:   key: "dialog.provider.opencode.note"
  1113: }, {
  1114:   match: (id) => id === "opencode-go",
  1115:   key: "dialog.provider.opencodeGo.tagline"
  ...
  // dialog-settings-BURAy5dR.js:1348-1359 / index-DJY-56lK.js:1383-1388
  1348:             insert(_el$20, createComponent(Show, {
  1349:               get when() { return item.id === "opencode-go"; },
  1353:                 return createComponent(Tag$1, { get children() { return language.t("dialog.provider.tag.recommended"); } });
  ```
  ⇒ Providers 页里 `opencode-go` 带「推荐 / Recommended」标签 + 副标题「适合所有人的低成本订阅 / Low cost subscription for everyone」（`dialog.provider.opencodeGo.tagline`），按钮是 `common.connect`。
- 应用内唯一叫 "Usage" 的 UI 是**上下文用量**（token/成本展示，非计费额度）：
  ```js
  50186: "context.stats.usage": "Usage",
  50196: "context.usage.tokens": "Tokens",
  50198: "context.usage.cost": "Cost",
  50200: "context.usage.view": "View context usage",
  ```
- 数据来源：`session.usage.updated` 事件只更新会话 token/cost 统计（`main-C07s90t2.js:63077`、`64937`），与免费额度/账单无关。

---

## 6. 客户端是否存在本地额度计数 / 缓存 / 写死阈值

| 项目 | 结论 | 证据 |
|---|---|---|
| 本地额度计数器 | **无** | 全树无 `count/limit` 计费逻辑；判定全靠 responseBody 字符串 |
| 本地额度缓存 | **无** | 只有弹窗节流状态（4 个字段）持久化 |
| 免费额度阈值（如 $10、N 次/天） | **无（不在客户端）** | 只有文案里的 `$10/month`（`main-C07s90t2.js:10792`） |
| 唯一写死阈值 | `GO_UPSELL_WINDOW = 864e5` | `main-C07s90t2.js:152557` |
| 重试策略写死值 | `RETRY_MAX_RETRIES = 5`、`RETRY_INITIAL_DELAY = 2e3`、`RETRY_BACKOFF_FACTOR = 2`、`RETRY_JITTER_FACTOR = 0.25`、`RETRY_MAX_DELAY_NO_HEADERS = 3e4` | `out/main/chunks/node-ibnNxpSl.js:441519` |
| 错误识别方式 | 字符串包含：`responseBody.includes("FreeUsageLimitError")` / `("GoUsageLimitError")` | `out/main/chunks/node-ibnNxpSl.js:441413` / `441426` |
| 死键（定义了但渲染层从未引用） | `ui.sessionTurn.error.freeUsageExceeded`、`ui.sessionTurn.error.addCredits` | 定义：`main-C07s90t2.js:10789-10790`（及全部语言包）；全渲染层 grep 仅命中定义处，无 `t("ui.sessionTurn.error.*")` 调用 |

---

## 7. 用户实际看到的界面（弹窗被静音时）

会话重试错误卡片（`main-C07s90t2.js:138505-138608`）：

```js
138522:   const message2 = createMemo(() => {
138523:     const current2 = retry2();
138524:     if (!current2) return "";
138525:     if (current2.message.includes("exceeded your current quota") && current2.message.includes("gemini")) {
138526:       return i18n.t("ui.sessionTurn.retry.geminiHot");
138527:     }
138528:     if (current2.message.length > 80) return current2.message.slice(0, 80) + "...";
138529:     return current2.message;
138530:   });
...
138536:   const info = createMemo(() => { ... i18n.t("ui.sessionTurn.retry.inSeconds", { seconds: count }) ...
138544:     const line = [retrying, delay].filter(Boolean).join(" ");
138548:     return i18n.t("ui.sessionTurn.retry.attemptLine", { line, attempt: current2.attempt });
```

- 卡片 = `Card variant="error"` + `Spinner` + 文本（截断 80 字符，`138528`；完整文本在 Tooltip，`138579-138589`）+ `retrying in {{seconds}}s - attempt #{{attempt}}`。
- **卡片内没有任何按钮或链接**。由于 `retry.message` 来自 core（`GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"`），在 `dontShow` 已置位时（本机状态，§3.2），用户只会看到这条**英文原文**，并且**永远看不到弹窗**。

---

## 8. 语言包 key 清单（zh / en 对照）

zh 由**两个**字典合并（`main-C07s90t2.js:50779-50787`）：

```js
50779: const merge$1 = (app, ui) => Promise.all([app, ui]).then(([a2, b2]) => ({
50780:   ...base$1,
50781:   ...flatten({ ...a2.dict, ...b2.dict })
50782: }));
50786: const loaders = {
50787:   zh: () => merge$1(import("./zh-cgKeHQ8h.js"), import("./zh-B5Hw0C7Y.js")),
```

⇒ 以 `base$1`（英文）为底、语言包覆盖；缺失 key 会回落英文，不会显示裸 key。

| key | English | 中文（zh） | 中文来源 |
|---|---|---|---|
| `dialog.usageExceeded.freeTier.title` | `Free limit reached` (`main-C07s90t2.js:10791`) | `免费额度已用完` | `zh-B5Hw0C7Y.js:89` |
| `dialog.usageExceeded.freeTier.description` | `Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.` (`:10792`) | `每月 $10 订阅 OpenCode Go，可靠地使用最佳开源模型。` | `zh-B5Hw0C7Y.js:90` |
| `dialog.usageExceeded.freeTier.actionLabel` | `Subscribe` (`:10793`) | `订阅` | `zh-B5Hw0C7Y.js:91` |
| `dialog.usageExceeded.accountRateLimit.title` | `Go limit reached` (`:10794`) | `Go 额度已用完` | `zh-B5Hw0C7Y.js:92` |
| `dialog.usageExceeded.accountRateLimit.description` | `Usage limit reached. To continue using this model now, enable usage from your available balance` (`:10795`) | `使用额度已达上限。如需立即继续使用此模型，请启用余额付费` | `zh-B5Hw0C7Y.js:93` |
| `dialog.usageExceeded.accountRateLimit.actionLabel` | `Open settings` (`:10796`) | `打开设置` | `zh-B5Hw0C7Y.js:94` |
| `dialog.usageExceeded.dontShowAgain` | `Don't show again` (`:50169`) | `不再显示` | `zh-cgKeHQ8h.js:536` |
| `model.tag.free` | `Free` (`:49922`) | `免费` | `zh-cgKeHQ8h.js:300` |
| `model.tag.latest` | `Latest` (`:49923`) | — | — |
| `dialog.model.unpaid.freeModels.title` | `Free models provided by OpenCode` (`:49848`) | `OpenCode 提供的免费模型` | `zh-cgKeHQ8h.js:226` |
| `dialog.model.unpaid.addMore.title` | `Add more models from popular providers` (`:49849`) | `从热门提供商添加更多模型` | `zh-cgKeHQ8h.js:227` |
| `dialog.model.unpaid.viewMoreProviders` | `See 70+ more providers` (`:49850`) | `查看另外 70 多个提供商` | `zh-cgKeHQ8h.js:228` |
| `dialog.provider.opencodeGo.tagline` | `Low cost subscription for everyone` (`:49835`) | `适合所有人的低成本订阅` | `zh-cgKeHQ8h.js:213` |
| `dialog.provider.tag.recommended` | （`dialog-settings-BURAy5dR.js:1343` 引用） | `推荐` | `zh-cgKeHQ8h.js:210` |
| `ui.sessionTurn.error.freeUsageExceeded` | `Free usage exceeded` (`:10789`) — **死键** | `免费使用额度已用完` | `zh-B5Hw0C7Y.js:87` |
| `ui.sessionTurn.error.addCredits` | `Add credits` (`:10790`) — **死键** | `充值` | `zh-B5Hw0C7Y.js:88` |
| `ui.sessionTurn.retry.retrying` | `retrying` (`:10784`) | — | — |
| `ui.sessionTurn.retry.inSeconds` | `in {{seconds}}s` (`:10785`) | — | — |
| `ui.sessionTurn.retry.attempt` | `attempt #{{attempt}}` (`:10786`) | — | — |
| `ui.sessionTurn.retry.attemptLine` | `{{line}} - attempt #{{attempt}}` (`:10787`) | — | — |

- **注意**：core 里拼给 English 的 `action.label` 是小写 `subscribe` / `open settings`（`node-ibnNxpSl.js:441421` / `441454`），而 i18n 版本是首字母大写（`Subscribe` / `Open settings`）；中文用户因此看到的是更规范的本地化按钮。
- 繁体包同类 key 存在：`zht-CjjP4EPK.js:87-88`（`免費使用額度已用完` / `新增點數`）。

---

## 9. 证据文件清单

| 文件 | 覆盖内容 |
|---|---|
| `out/renderer/assets/main-C07s90t2.js` | 渲染层主 bundle（5.9MB）：弹窗 hook/组件、i18n 字典、模型选择器、设置对话框入口、重试错误卡片、持久化框架 |
| `out/renderer/assets/dialog-settings-BURAy5dR.js` | 旧版设置对话框（Providers 页、`opencode-go` 推荐标签、PROVIDER_NOTES） |
| `out/renderer/assets/index-DJY-56lK.js` | 新版布局设置对话框（同 `opencode-go` 推荐逻辑） |
| `out/renderer/assets/zh-cgKeHQ8h.js` / `zh-B5Hw0C7Y.js` | 中文语言包两半（app 字典 / ui 字典） |
| `out/renderer/assets/zht-CjjP4EPK.js` 等 60+ 语言文件 | 各语言 UI 字典（`ui.sessionTurn.error.*` 等） |
| `out/main/chunks/node-ibnNxpSl.js` | core 重试/门禁：`retryable()`、`GO_UPSELL_URL`、`GO_UPSELL_MESSAGE`、`FreeUsageLimitError`/`GoUsageLimitError` 识别、`RETRY_*` 常量 |
| `out/main/index.js` | Electron 主进程：`store-get/set` IPC 与 store 文件路径（`join(app.getPath("userData"), name)`，`:1157`；IPC `:2123-2150`） |
| `out/preload/index.js` | `contextBridge` API：`storeGet/storeSet`（`:67-72`）、`openExternal`（`:95`）、`setNativeTranslations`（`:130`） |
| `%APPDATA%\ai.opencode.desktop\opencode.global.dat` | 运行期持久化状态，含实测 `go-upsell` 值（§3.2） |

---

## 10. 对「FREE 模型限制」调查的 UI 侧结论

1. **限流判定与文案完全由服务端响应体 + core 字符串匹配决定**；客户端可被"骗过"的唯一变量是 `action.provider` 是否在 `{opencode, opencode-go}` 内（`main-C07s90t2.js:152558/152564`）——若服务端返回的 provider 不是这两个，弹窗**不会出现**（但重试错误卡片仍会显示 message）。
2. **本机已永久静音免费额度弹窗**（§3.2 实测），因此"看不到提示"是客户端持久化状态所致，不是功能缺失；清空 `opencode.global.dat` 里的 `go-upsell` 即可恢复弹窗（本次调查未执行，遵守只读约束）。
3. 想绕过限制，客户端侧**没有任何可改的额度阈值**；`opencode.ai/go`、`opencode.ai/workspace/<id>/go` 都是服务端订阅/余额开关，`enable usage from your available balance` 只能在网页控制台开启。
4. 非英文用户损失 `account_rate_limit` 的动态重置时间（`It will reset in …`），因为 i18n 分支用的是静态串（§1.4）。
5. `account_rate_limit` 的按钮文案 `Open settings` / `打开设置` 是**误导性文案**：实际只外开网页，不打开应用内设置（§1.5、§2）。
