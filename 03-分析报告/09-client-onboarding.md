# 09 — 客户端正向路径：首次使用免费模型时客户端做了什么

调查者：teammate `ui-gate`（task-9）
版本：`desktop@1.19.2`（`out/renderer/assets/zh-B5Hw0C7Y.js:5` → `e.SENTRY_RELEASE = { id: "desktop@1.19.2" }`）
证据根：解包产物 `99-解包产物与运行时残留\OpenCode-Desktop-1.19.2-解包\`；运行期状态 `%APPDATA%\ai.opencode.desktop\`、`%USERPROFILE%\.local\share\opencode\`
约束遵守：只读；未重启/未杀 OpenCode 进程；未修改任何状态文件；未输出任何密钥明文（下文只列键名/字段名/类型）。

---

## 0. 直接回答 Lead 的两个必答点

### 必答 1：首次启动/未登录时，客户端是否创建匿名设备/安装身份？

**答案：没有。客户端不创建任何匿名设备/安装身份、不注册、不申请 token。**

免费调用的"身份"就是**一个写死的字符串 `"public"`** 作为 apiKey，没有任何设备/安装/账户标识参与：

```js
// out/main/chunks/node-ibnNxpSl.js:313630-313646（OpencodePlugin 的 catalog 变换）
313630:         const item2 = catalog.provider.get(ID7.opencode);
313631:         if (!item2)
313632:           return;
313633:         const hasKey = Boolean(process.env.OPENCODE_API_KEY || connected || item2.provider.request.body.apiKey);
313634:         catalog.provider.update(item2.provider.id, (provider9) => {
313635:           if (!hasKey)
313636:             provider9.request.body.apiKey = "public";
313637:         });
313638:         if (hasKey)
313639:           return;
313640:         for (const model8 of item2.models.values()) {
313641:           if (!model8.cost.some((cost3) => cost3.input > 0))
313642:             continue;
313643:           catalog.model.update(item2.provider.id, model8.id, (draft) => {
313644:             draft.enabled = false;
313645:           });
313646:         }
```

第二处同语义实现（provider loader，更早执行）：

```js
// out/main/chunks/node-ibnNxpSl.js:654799-654818
654799:     opencode: fnUntraced2(function* (input) {
654800:       const env2 = yield* dep.env();
654801:       const hasKey = iife2(() => {
654802:         if (input.env.some((item2) => env2[item2]))
654803:           return true;
654804:         return false;
654805:       });
654806:       const ok2 = hasKey || Boolean(yield* dep.auth(input.id)) || Boolean((yield* dep.config()).provider?.["opencode"]?.options?.apiKey);
654807:       if (!ok2) {
654808:         for (const [key2, value4] of Object.entries(input.models)) {
654809:           if (value4.cost.input === 0)
654810:             continue;
654811:           delete input.models[key2];
654812:         }
654813:       }
654814:       return {
654815:         autoload: Object.keys(input.models).length > 0,
654816:         options: ok2 ? {} : { apiKey: "public" }
654817:       };
654818:     }),
```

判定"已登录"的三个条件（654806）：`OPENCODE_API_KEY` 环境变量、`auth("opencode")` 凭据、`config.provider.opencode.options.apiKey`。**三者都不需要注册**；都不满足时直接注入 `"public"`。

免费 provider 的静态定义（内嵌 models.dev 快照，`node-ibnNxpSl.js:169228` 这一行内）：

```
opencode:     { id:"opencode",     env:["OPENCODE_API_KEY"], npm:"@ai-sdk/openai-compatible", api:"https://opencode.ai/inference/v1",    name:"OpenCode",    doc:"https://opencode.ai/v2/docs/console/models/" }
"opencode-go":{ id:"opencode-go",  env:["OPENCODE_API_KEY"], npm:"@ai-sdk/openai-compatible", api:"https://opencode.ai/inference/go/v1", name:"OpenCode Go", doc:"https://opencode.ai/v2/docs/console/go/" }
```

**检索过的键名与文件清单（全部为"无身份"证据）**

| 位置 | 检索内容 | 结果 |
|---|---|---|
| `out/**/*.js`（全解包产物） | `installId` `install_id` `installationId` `machineId` `machine-id` `telemetryId` `anonymousId` `distinctId` `deviceId` `device_id` | **0 处相关命中**（仅 `node-ibnNxpSl.js:77281` 的 `/etc/machine-id` —— 属 OpenTelemetry resource detector，Linux 专用且未被启用；无任何安装 ID 生成） |
| `out/renderer/assets/main-C07s90t2.js` | `Sentry.setUser` / `setUser(` | 仅命中 Sentry SDK 的 `Scope.setUser` **定义**（`:3026`），**全树无调用点** ⇒ Sentry 事件不带用户/设备标识 |
| `%USERPROFILE%\.local\share\opencode\auth.json` | 顶层键 | 仅 `asaf`、`cline-pass`、`workbuddy`、`tokenharhur`（均为用户自建 `{type,key}` API key 条目）；**无 `opencode` 条目、无 oauth/refresh token** |
| `%USERPROFILE%\.local\share\opencode\opencode.db` | 表 `credential` / `account` / `control_account` | 均 **0 行**（Lead 已用 node:sqlite 只读确认）⇒ 设备流从未成功落库 |
| `%APPDATA%\ai.opencode.desktop\opencode.global.dat` | 顶层键（6 个） | `command.catalog.v1`、`notification`、`server`、`model`、`layout`、`go-upsell` —— **无 token / 无 device / 无 install** |
| `%APPDATA%\ai.opencode.desktop\opencode.settings` | 顶层键（4 个） | `oldLayoutEligible`(Bool)、`tauriMigrated`(Bool)、`windowIds`(Object[])、`firstLaunchOnboardingComplete`(Bool) —— 纯 UI/引导状态 |
| `%APPDATA%\ai.opencode.desktop\default.dat` | 顶层键（3 个） | `app-version.v1`、`settings.v3`、`highlights.v1` |
| `%APPDATA%\ai.opencode.desktop\opencode.window.<uuid>.dat` | 顶层键 | `tabs`、`tabs.recent`、`tabs.info`、`tabs.closed` |
| `%APPDATA%\ai.opencode.desktop\opencode.workspace.*.dat` | 顶层键 | `workspace:project`、`workspace:vcs` |
| `Local Storage\leveldb\*` | 全部键 | 唯一业务键 `opencode.desktop.window.<uuid>.last-active-url`（origin = `ai.opencode.desktop`）；**无 opencode.ai origin、无 token** |
| `%APPDATA%\ai.opencode.desktop\Network\Cookies` | 是否存在 opencode.ai cookie | **无法读取**：Chromium 以独占方式持有该文件（`FileShare::ReadWrite` 仍报"正由另一进程使用"）。未采取任何绕过手段（不杀进程、不改文件），此项**未能验证**，属已知取证缺口 |
| `%APPDATA%\ai.opencode.desktop\Network\Network Persistent State` | 明文 host | 含 `opencode.ai`、`o4511072101138432.ingest.us.sentry.io`、`redirector.gvt1.com` ⇒ 渲染层确实访问过 opencode.ai（但该文件不含凭据） |

**唯一带"客户端身份"色彩的产物（都不是设备身份）**

| 产物 | 位置 | 性质 |
|---|---|---|
| `.updaterId` | `%APPDATA%\ai.opencode.desktop\.updaterId`，36 字符 UUID | electron-updater 的更新通道 id，与鉴权/免费额度无关 |
| `opencode.window.<uuid>.dat` | 同上目录 | 窗口 id（多窗口恢复用） |
| `x-opencode-client` 请求头 | `node-ibnNxpSl.js:441034` `"x-opencode-client": input.flags.client` | **常量** `"desktop"`（取值域见 `node-ibnNxpSl.js:637252` `["app","cli","desktop"].includes(flags2.client)`），标识"哪个客户端形态"，非用户/设备 id |
| `client_id` | `node-ibnNxpSl.js:313520` `clientID2 = "opencode-cli"`；`dialog-connect-provider-B_bhWspV.js:1149` `url.searchParams.set("client_id", "opencode-desktop")` | OAuth 客户端 id（**仅交互式登录时**用），非设备 id |

**每个 `opencode*` 模型请求携带的关联头**（`node-ibnNxpSl.js:441020-441035`，仅当 `input.model.providerID.startsWith("opencode")`）：

```js
441020:     const opencodeProjectID = input.model.providerID.startsWith("opencode") ? (yield* context4).project.id : void 0;
441027:       headers: {
441028:         "x-opencode-session-id": input.sessionID,
441031:           ...opencodeProjectID ? { "x-opencode-project": opencodeProjectID } : {},
441032:           "x-opencode-session": input.sessionID,
441033:           "x-opencode-request": input.user.id,
441034:           "x-opencode-client": input.flags.client,
441035:           "User-Agent": USER_AGENT2
```

`x-opencode-project` = 本地 project id、`x-opencode-request` = 本地消息 user id（ULID），均为**本地生成、每次请求临时携带、不作为身份持久化**。服务端可用它们做请求关联与限流，但客户端没有任何注册动作。

**关于设备流（Lead 关注的 OAuth）**：设备流**确实存在且渲染层有完整 UI**，但它只服务于**用户主动连接 OpenCode Console 账户**（付费/额度绑定），**与免费模型的可用性无关**：

```js
// out/main/chunks/node-ibnNxpSl.js:313396-313421（core 侧，opencode integration 的 oauth method）
313396: function oauth(http5) {
313397:   return {
313398:     integrationID: ID16.make("opencode"),
313400:       id: methodID,
313401:       type: "oauth",
313402:       label: "OpenCode Console account"
313404:     authorize: () => gen2(function* () {
313405:       const device = yield* post2(http5, `${defaultServer}/auth/device/code`, { client_id: clientID2 }, Device);
313408:           const url3 = new URL(device.verification_uri_complete, `${defaultServer}/`);
313415:       return {
313416:         mode: "auto",
313417:         url: verification.href,
313418:         instructions: `Enter code: ${device.user_code}`,
313419:         callback: poll(http5, defaultServer, device.device_code, seconds(device.interval))
```

- `defaultServer = "https://opencode.ai/console"`、`clientID2 = "opencode-cli"`（`node-ibnNxpSl.js:313520`）
- token 轮询：`POST ${server}/auth/device/token`，body `{grant_type:"urn:ietf:params:oauth:grant-type:device_code", device_code, client_id}`（`313475-313477`）
- 刷新：`{grant_type:"refresh_token", refresh_token, client_id}`（`313424`）
- 另一份同构实现（Account 服务，用于 CLI `auth login`）：`Account.login` = `POST ${server}/auth/device/code`（`573416-57437`）、`Account.poll` = `POST ${server}/auth/device/token` 后 `repo.persistAccount({id,email,url,accessToken,refreshToken,expiry,orgID})`（`57438-57464`）
- 桌面壳/渲染层**有对应 UI**：`out/renderer/assets/dialog-connect-provider-B_bhWspV.js`
  - `1130-1163`：选中 `oauth` 方法 → `serverSDK().api.integration.oauth.connect({integrationID, methodID, inputs, location})`
  - `1147-1151`：桌面特化 —— `if (props.provider === "opencode" && platform.platform === "desktop")` 时把 `client_id=opencode-desktop` 写进 verification URL
  - `1745-1827`：`OAuthAutoView()` —— 从 `instructions` 里按 `":"` 切出验证码（`1746-1752`），展示 `provider.connect.oauth.auto.confirmationCode`（`1814`）+ 外链 `store.authorization.url`（`1801-1808`），并每 1s 轮询 `oauth.status`（`1757-1794`，`setTimeout(poll, 1e3)`）

⇒ 设备流是"**可选升级路径**"（连账户 → 获得账户额度/余额），不是免费模型的前置条件。凭据落地在 `credential`/`account` 表（当前均 0 行）。

---

### 必答 2：从 UI 角度，「第一次用免费模型」实际需要几步？

**答案：0 步配置 + 0~2 次点击。不登录、无向导、无同意弹窗；免费模型所在分组固定排第一。**

**① 首次启动引导（与身份无关）**

```js
// out/main/index.js:2586-2601
2586: function isFirstLaunchOnboardingPending() {
2587:   const pending = getStore().get(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY) !== true;
2591: async function finishFirstLaunchOnboarding(createDefaultProject) {
2596:   const defaultProject = createDefaultProject ? join(app.getPath("documents"), DEFAULT_PROJECT_DIR) : null;
2597:   if (defaultProject) await mkdir(defaultProject, { recursive: true });
2598:   getStore().set(FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY, true);
```

- 常量：`out/main/index.js:1115` `FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY = "firstLaunchOnboardingComplete"`；`:1116` `OLD_LAYOUT_ELIGIBLE_KEY = "oldLayoutEligible"`；`:2573` `DEFAULT_PROJECT_DIR = "Default Project"`
- 渲染层触发点 `DesktopFirstLaunchOnboarding`（`main-C07s90t2.js:160781-160822`）：仅当 `!existingInstall && initialUrl === "/" && tabs.length === 0 && server.list.every(ServerConnection.builtin)` 时创建 `Documents\Default Project` 并开一个 draft tab（`160797`、`160811-160816`）。**无登录、无 provider 选择、无同意页。**
- 本机已完成：`opencode.settings` 的 `firstLaunchOnboardingComplete = true`；12 个 `logs/*/onboarding.log` 全部 `pending: false`（例：`logs\20261016T034020\onboarding.log:1` `(onboarding) first launch onboarding pending checked { pending: false }`）
- 名称含 onboarding 的 i18n 全是 **WSL 引导**（`main-C07s90t2.js:50081-50141` `wsl.onboarding.*`），与免费额度无关。

**② 免费模型如何自动可用**：见必答 1 的 `apiKey:"public"` + 禁用 `cost.input > 0` 的模型。⇒ 未登录时 `opencode` provider 依旧出现在引擎 provider 列表（Lead 实测 `connected` 含 `"opencode"`，且 `options.apiKey = "public"`），因此渲染层视为"已连接"：

```js
// main-C07s90t2.js:61663-61665
61663:   return {
61664:     all: all2,
61665:     connected: providers.map((provider) => provider.id),
```

**③ 默认模型解析（可能零点击直接命中免费模型）**

```js
// main-C07s90t2.js:78031-78061
78031:     const configuredModel = () => {
78032:       const model2 = resolveDefaultModel(providers.defaultModel(), sync2().data.config.model);
78034:       if (validModel(model2)) return model2;
78036:     const recentModel = () => {
78037:       for (const item of models.recent.list()) {
78038:         if (validModel(item)) return item;
78041:     const defaultModel = () => {
78042:       const defaults3 = providers.default();
78043:       for (const provider of providers.connected()) {
78044:         const configured2 = defaults3[provider.id];
78052:         const first2 = Object.values(provider.models)[0];
78061:     const fallback2 = createMemo(() => configuredModel() ?? recentModel() ?? defaultModel());
```

`providers.default()` 每个 provider 取"首个非 deprecated 模型"（`61667-61672`）。⇒ 首次启动时按 `opencode` 在 provider 列表中的位置取首个可用（免费）模型，用户**可以完全不操作**。

**④ 模型选择器中的免费路径**

```js
// main-C07s90t2.js:76691-76700（分组顺序，opencode 恒第一）
76691: const popularProviders = [
76692:   "opencode",
76693:   "opencode-go",
76694:   "anthropic", "github-copilot", "openai", "google", "openrouter", "vercel"
76700: ];
// main-C07s90t2.js:122503-122509（分组排序）
122503:     sortGroupsBy: (a2, b2) => {
122506:       if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1;
122508:       return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider);
// main-C07s90t2.js:122461（"免费"判定）
122461: const isFree = (provider, cost) => provider === "opencode" && (!cost || cost.input === 0);
// main-C07s90t2.js:122540-122551（标签渲染）
122540:       insert(_el$, createComponent(Show, {
122541:         get when() { return isFree(i2.provider.id, i2.cost); },
122545:           return createComponent(Tag$1, { get children() { return language.t("model.tag.free"); } });
// main-C07s90t2.js:122223-122228（tooltip 追加 "(Free)"）
122224:     const tags = [];
122226:     if (props.free) tags.push(language.t("model.tag.free"));
122228:     return `${sourceName(props.model)} ${props.model.name}${suffix}`;
```

同口径第二处：`main-C07s90t2.js:127735` `const isFree2 = (item) => item.provider.id === "opencode" && (!item.cost || item.cost.input === 0);`

未付费用户的专用选择器 `DialogSelectModelUnpaidV2`（`main-C07s90t2.js:127722`，由 `129716` `onUnpaidClick` 打开；旧版 `DialogSelectModelUnpaid` 在 `123143`）：

```js
127720: const featuredProviders = ["opencode", "opencode-go", "openai", "anthropic", "google", "github-copilot"];
127721: const displayModelName = (name2) => name2.replace(/\s+(?:\(free\)|free)$/i, "");
127736:   const freeModels = createMemo(() => model.list().filter(isFree2));
127793:           insert(_el$4, () => language.t("dialog.model.unpaid.freeModels.title"));
```

**步骤结论**：`0 步`（默认模型即免费模型，直接发消息）→ 若需手动选：`1 次点击打开模型选择器 + 1 次点击 OpenCode 分组里的免费模型`。**全程无登录、无 OAuth、无额度告知、无"受限"提示**（见 §3）。

---

## 1. 首次使用流程图

```
首次启动
  │
  ├─ Electron 主进程 (out/main/index.js:4154-4175)
  │    app.setPath("userData", %APPDATA%\ai.opencode.desktop)
  │    initializeOldLayoutEligibility()  → opencode.settings.oldLayoutEligible
  │    写日志 logs/<ts>/onboarding.log
  │
  ├─ 渲染层 DesktopFirstLaunchOnboarding (main-C07s90t2.js:160781)
  │    isFirstLaunchOnboardingPending()  ← opencode.settings.firstLaunchOnboardingComplete !== true
  │    finishFirstLaunchOnboarding(shouldTrigger)
  │      └─ mkdir Documents\Default Project + open draft tab
  │    ★ 无登录 / 无 provider 选择 / 无同意
  │
  ├─ 引擎启动（内嵌 opencode server, out/main/chunks/node-ibnNxpSl.js）
  │    provider loader "opencode" (654799-654818):
  │      hasKey = OPENCODE_API_KEY || auth("opencode") || config...apiKey
  │      !hasKey → 删除 cost.input>0 的模型, options = { apiKey: "public" }, autoload = true
  │    OpencodePlugin catalog transform (313630-313646): 同上，request.body.apiKey = "public"
  │    ★ 无注册请求、无设备码请求
  │
  ├─ /provider → connected 含 "opencode"（options.apiKey="public"）
  │    main-C07s90t2.js:61665 connected = providers.map(p => p.id)
  │
  └─ 默认模型 fallback (main-C07s90t2.js:78061)
       configuredModel() ?? recentModel() ?? defaultModel()
       defaultModel() → providers.connected() 里第一个 provider 的首个非 deprecated 模型
       ⇒ 命中 opencode 免费模型 ⇒ 用户零操作即可发消息
          │
          └─ 请求头 (node-ibnNxpSl.js:441027-441035)
               x-opencode-session-id / x-opencode-project / x-opencode-session
               x-opencode-request / x-opencode-client: "desktop"
               → POST https://opencode.ai/inference/v1 （Bearer public）
```

可选分支（**非**免费前提）：设置 → Providers → OpenCode → "OpenCode Console account"（OAuth 设备流）→ 浏览器打开 `verification_uri_complete` → 输入 `Enter code: XXXX` → 凭据落 `credential`/`account` 表。

---

## 2. provider 连接弹窗（`controller.select("opencode-go")` 之后）

`free_tier_limit` 弹窗主按钮触发（task-2 已确认，`main-C07s90t2.js:152626-152632`）：

```js
152626:             void __vitePreload(() => import("./dialog-connect-provider-B_bhWspV.js").then((n2) => n2.d), ...).then((x2) => {
152627:               const controller = x2.useProviderConnectController();
152628:               controller.select("opencode-go");
152629:               void dialog.show(() => createComponent(x2.DialogConnectProvider, { controller }));
```

`DialogConnectProvider`（`out/renderer/assets/dialog-connect-provider-B_bhWspV.js`）：

| 行为 | 行号 | 说明 |
|---|---|---|
| 方法来源 | `1023-1036` | `serverSDK().api.integration.get({integrationID: props.provider})`；过滤 `type === "key" \|\| type === "oauth"`；失败回落 `fallback()`（`:1019-1022` 只有 `{type:"key", label: provider.connect.method.apiKey}`） |
| oauth 连接 | `1130-1163` | `api.integration.oauth.connect({integrationID, methodID, inputs, location})` |
| **桌面特化** | `1147-1151` | `if (props.provider === "opencode" && platform.platform === "desktop")` → `url.searchParams.set("client_id", "opencode-desktop")` |
| auto 模式 UI | `1745-1827` | 提取验证码 + 外链 + 每秒轮询 `oauth.status` |
| code 模式 UI | `1590-1660` | 粘贴授权码 → `api.integration.oauth.complete`（`:1610`） |
| opencode 专属文案 | `1438`、`1516` | `provider().id === "opencode"` 时显示 `provider.connect.opencodeZen.line1/line2` + `opencode.ai/zen` 链接（`:1447-1457`、`:1520-1530`） |
| `opencode` vs `opencode-go` 差异 | `692`、`788`、`810`、`922-927` | 仅 tagline 不同：`opencode` → `dialog.provider.opencode.tagline`，`opencode-go` → `dialog.provider.opencodeGo.tagline`；`featured = ["opencode","opencode-go",...]`（`:810`）；`:922` `provider.id === "opencode" \|\| "opencode-go"` 走同一分支 |

**核心差异在服务端而非渲染层**：`opencode` 的 integration 提供 `oauth`（"OpenCode Console account"）+ `key`（"API key (service account)"）两种方法（`node-ibnNxpSl.js:313565-313571`）：

```js
313565:       yield* ctx.integration.transform((draft) => {
313566:         draft.update("opencode", (integration) => {
313567:           integration.name = "OpenCode";
313569:         draft.method.update(oauth(http5));
313570:         draft.method.update({ integrationID: "opencode", method: { type: "key", label: "API key (service account)" } });
```

`opencode-go` 在静态快照里是**独立 provider**（`api: https://opencode.ai/inference/go/v1`），不是 `opencode` 的方法变体；UI 上二者是并列的两个 provider 条目。

---

## 3. 免费模型是否有"受限/可能限流"提示

**没有任何前置提示。** 全树检索渲染层与语言包，`free` 相关 UI 只有"免费"标签与未付费选择器标题，**没有**"可能限流 / 会耗尽 / 仅限免费额度"之类的预警文案。唯一与限流相关的文案全部是**事后**（收到 `FreeUsageLimitError` / `GoUsageLimitError` 之后）才出现的弹窗与重试卡片（task-2 §1、§7）。

`model.tag.free` 的全部渲染点（`grep model.tag.free`）：

| 文件:行号 | 用途 |
|---|---|
| `main-C07s90t2.js:49922` | 英文定义 `"model.tag.free": "Free"` |
| `main-C07s90t2.js:122547` | 模型列表项标签（`isFree(...)`，`:122541` 判定） |
| `main-C07s90t2.js:122226` | Tooltip 标题后缀 `(Free)` |
| `zh-cgKeHQ8h.js:300` | 中文 `"model.tag.free": "免费"` |
| `zh-B5Hw0C7Y.js` | （无此 key，由 `zh-cgKeHQ8h.js` 提供） |

判定函数只出现在 `122461`（`isFree`）与 `127735`（`isFree2`），调用点 `122522` / `122542` / `127818` —— **纯展示，不参与任何门禁或降级**。

---

## 4. 本地状态键名全表（只列键名与类型）

### 4.1 `%APPDATA%\ai.opencode.desktop\`

| 文件 | 顶层键 | 类型 | 备注 |
|---|---|---|---|
| `opencode.global.dat` | `command.catalog.v1` | String(3214) | 命令面板目录缓存 |
| | `notification` | String(87022) | 通知历史 |
| | `server` | String(888) | 服务器列表（**无 token**，Lead 已确认） |
| | `model` | String(8410) | 模型选择状态（current/recent） |
| | `layout` | String(4080) | 布局 |
| | `go-upsell` | String(171) | 弹窗节流（task-2 §3.2 实测值） |
| `opencode.settings` | `oldLayoutEligible` | Bool | 老布局资格 |
| | `tauriMigrated` | Bool | 迁移标记 |
| | `windowIds` | Object[] | 窗口 id |
| | `firstLaunchOnboardingComplete` | Bool | **首次引导完成标记**（唯一"首次运行"状态） |
| `default.dat` | `app-version.v1` / `settings.v3` / `highlights.v1` | String | 版本、设置、高亮 |
| `opencode.window.<uuid>.dat` | `tabs` / `tabs.recent` / `tabs.info` / `tabs.closed` | String | 标签页状态 |
| `opencode.workspace.<hash>.<rand>.dat` | `workspace:project` / `workspace:vcs` | String | 项目/VCS 信息（无账户信息） |
| `opencode.updater` | — | 空/2B | 更新状态 |
| `.updaterId` | — | 36 字符 UUID | electron-updater id（非鉴权身份） |

**结论：上述所有文件中没有任何账户/设备/免费身份键。** 唯一与"首次"相关的是 `firstLaunchOnboardingComplete`（纯 UI 引导标记）。

### 4.2 Local Storage / Chromium 存储

| 位置 | 键名 | 说明 |
|---|---|---|
| `Local Storage\leveldb` | `opencode.desktop.window.<uuid>.last-active-url` | origin = `ai.opencode.desktop`；**唯一业务键** |
| `Network\Network Persistent State` | （host 列表，非键值） | 含 `opencode.ai`、`...ingest.us.sentry.io` |
| `Network\Cookies` | **未能读取**（进程独占锁） | 无法确认是否存在 opencode.ai cookie —— 取证缺口，未采取绕过手段 |

### 4.3 `%USERPROFILE%\.local\share\opencode\`

| 文件 | 状态 |
|---|---|
| `auth.json` (419 B) | 顶层键仅 `asaf`、`cline-pass`、`workbuddy`、`tokenharhur`（`{type,key}`），**无 opencode 条目** |
| `opencode.db` (~6.1 GB) | `credential`/`account`/`control_account` = **0 行**；`session` 67、`project` 4、`message` 14972 |
| `log\opencode.log` (27 MB) | 运行期日志：大量 `providerID=opencode modelID=*-free` 的调用记录（见 §5），**无 `auth/device` 调用痕迹** |
| `storage\`、`snapshot\`、`repos\`、`tool-output\` | 会话/快照数据，无身份文件 |

---

## 5. 运行期佐证（免费模型确实在无凭据下被调用）

`%USERPROFILE%\.local\share\opencode\log\opencode.log` 中的实际调用记录（同文件 `grep opencode.ai`）：

```
line 2320:   timestamp=2026-09-14T13:15:00.296Z level=ERROR message="stream error" providerID=opencode modelID=ling-3.0-flash-fin-free  ... error="AI_APICallError: Cannot connect to API: Connect Timeout Error
line 6453:   ... providerID=opencode modelID=nemotron-3-ultra-free  ...
line 25815:  ... providerID=opencode modelID=muse-spark-1.3-contributor-free  ...
line 41258:  ... providerID=opencode modelID=mimo-v2.6-flash-free  ...
line 6740:   ... error="Cannot connect to API: Connect Timeout Error (attempted address: opencode.ai:443, timeout: 10000ms)"
```

⇒ 这些请求发生在 `auth.json` **没有** `opencode` 条目、`credential`/`account` 表 **0 行** 的前提下 —— 直接证实"无身份即可调用免费模型"（此处失败仅为网络不可达）。

---

## 6. 中英文案对照（本次相关 key）

zh 由两个字典合并（`main-C07s90t2.js:50779-50787`）：

```js
50779: const merge$1 = (app, ui) => Promise.all([app, ui]).then(([a2, b2]) => ({
50780:   ...base$1,
50781:   ...flatten({ ...a2.dict, ...b2.dict })
50786: const loaders = {
50787:   zh: () => merge$1(import("./zh-cgKeHQ8h.js"), import("./zh-B5Hw0C7Y.js")),
```

| key | English | 中文 | zh 来源 |
|---|---|---|---|
| `model.tag.free` | `Free` (`main-C07s90t2.js:49922`) | `免费` | `zh-cgKeHQ8h.js:300` |
| `model.tag.latest` | `Latest` (`:49923`) | `最新` | `zh-cgKeHQ8h.js:301` |
| `dialog.model.unpaid.freeModels.title` | `Free models provided by OpenCode` (`:49848`) | `OpenCode 提供的免费模型` | `zh-cgKeHQ8h.js:226` |
| `dialog.model.unpaid.addMore.title` | `Add more models from popular providers` (`:49849`) | `从热门提供商添加更多模型` | `zh-cgKeHQ8h.js:227` |
| `dialog.model.unpaid.viewMoreProviders` | `See 70+ more providers` (`:49850`) | `查看另外 70 多个提供商` | `zh-cgKeHQ8h.js:228` |
| `dialog.provider.tag.recommended` | `Recommended`（引用点 `dialog-settings-BURAy5dR.js:1353`） | `推荐` | `zh-cgKeHQ8h.js:210` |
| `dialog.provider.opencode.note` | `Curated models including Claude, GPT, Gemini and more` | `精选模型，包括 Claude、GPT、Gemini 等` | `zh-cgKeHQ8h.js:211` |
| `dialog.provider.opencode.tagline` | `Reliable optimized models` | `可靠的优化模型` | `zh-cgKeHQ8h.js:212` |
| `dialog.provider.opencodeGo.tagline` | `Low cost subscription for everyone` | `适合所有人的低成本订阅` | `zh-cgKeHQ8h.js:213` |
| `provider.connect.title` | `Connect {{provider}}` | `连接 {{provider}}` | `zh-cgKeHQ8h.js:230` |
| `provider.connect.selectMethod` | `Choose how to sign in to {{provider}}.` | `选择 {{provider}} 的登录方式。` | `zh-cgKeHQ8h.js:232` |
| `provider.connect.method.apiKey` | `API key` | `API 密钥` | `zh-cgKeHQ8h.js:233` |
| `provider.connect.method.browser` | `Browser` | `浏览器` | `zh-cgKeHQ8h.js:234` |
| `provider.connect.method.headless` | `Headless` | `无头模式` | `zh-cgKeHQ8h.js:235` |
| `provider.connect.status.inProgress` | `Authorizing...` | `正在授权...` | `zh-cgKeHQ8h.js:236` |
| `provider.connect.status.waiting` | `Waiting for authorization...` | `等待授权...` | `zh-cgKeHQ8h.js:237` |
| `provider.connect.status.failed` | `Authorization failed: {{error}}` | `授权失败：{{error}}` | `zh-cgKeHQ8h.js:238` |
| `provider.connect.apiKey.description` | `Enter your {{provider}} API key to connect your account and use {{provider}} models in OpenCode.` (`:49861`) | `输入你的 {{provider}} API 密钥以连接账户，并在 OpenCode 中使用 {{provider}} 模型。` | `zh-cgKeHQ8h.js:239` |
| `provider.connect.opencodeZen.line1` | `OpenCode Zen gives you access to a curated set of reliable optimized models for coding agents.` (`:49865`) | `OpenCode Zen 为你提供一组精选的可靠优化模型，用于代码智能体。` | `zh-cgKeHQ8h.js:243` |
| `provider.connect.opencodeZen.line2` | `With a single API key you'll get access to models such as Claude, GPT, Gemini, GLM and more.` (`:49866`) | `只需一个 API 密钥，你就能使用 Claude、GPT、Gemini、GLM 等模型。` | `zh-cgKeHQ8h.js:244` |
| `provider.connect.opencodeZen.visit.link` | `opencode.ai/zen` (`:49868`) | `opencode.ai/zen` | `zh-cgKeHQ8h.js:246` |
| `provider.connect.oauth.auto.confirmationCode` | `Confirmation code`（引用 `dialog-connect-provider-B_bhWspV.js:1814`） | `确认码` | `zh-cgKeHQ8h.js:258` |
| `provider.connect.oauth.auto.visit.suffix` | ` and enter the code below to connect your account and use {{provider}} models in OpenCode.` (`:49879`) | ` 并输入以下代码，以连接你的账户并在 OpenCode 中使用 {{provider}} 模型。` | `zh-cgKeHQ8h.js:257` |
| `provider.connect.oauth.code.visit.suffix` | ` to collect your authorization code to connect your account and use {{provider}} models in OpenCode.` (`:49872`) | ` 获取授权码，以连接你的账户并在 OpenCode 中使用 {{provider}} 模型。` | `zh-cgKeHQ8h.js:250` |
| `provider.connect.oauth.code.label` | `{{method}} authorization code` | `{{method}} 授权码` | `zh-cgKeHQ8h.js:251` |
| `provider.connect.toast.connected.title` | `{{provider}} connected` | `{{provider}} 已连接` | `zh-cgKeHQ8h.js:259` |
| `command.provider.connect` | `Connect provider` | `连接提供商` | `zh-cgKeHQ8h.js:137` |
| `dialog.usageExceeded.freeTier.title` | `Free limit reached` (`:10791`) | `免费额度已用完` | `zh-B5Hw0C7Y.js:89` |
| `dialog.usageExceeded.freeTier.description` | `Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.` (`:10792`) | `每月 $10 订阅 OpenCode Go，可靠地使用最佳开源模型。` | `zh-B5Hw0C7Y.js:90` |
| `dialog.usageExceeded.freeTier.actionLabel` | `Subscribe` (`:10793`) | `订阅` | `zh-B5Hw0C7Y.js:91` |
| `dialog.usageExceeded.accountRateLimit.title` | `Go limit reached` (`:10794`) | `Go 额度已用完` | `zh-B5Hw0C7Y.js:92` |
| `dialog.usageExceeded.accountRateLimit.actionLabel` | `Open settings` (`:10796`) | `打开设置` | `zh-B5Hw0C7Y.js:94` |
| `dialog.usageExceeded.dontShowAgain` | `Don't show again` (`:50169`) | `不再显示` | `zh-cgKeHQ8h.js:536` |
| `ui.sessionTurn.error.freeUsageExceeded` | `Free usage exceeded` (`:10789`) — **死键** | `免费使用额度已用完` | `zh-B5Hw0C7Y.js:87` |
| `ui.sessionTurn.error.addCredits` | `Add credits` (`:10790`) — **死键** | `充值` | `zh-B5Hw0C7Y.js:88` |

死键判定依据：`grep "sessionTurn\.error"` 在 `main-C07s90t2.js` 只命中 `10789`/`10790` 两处**定义**，无任何 `t("ui.sessionTurn.error.*")` 调用点。

---

## 7. 结论汇总

1. **客户端不创建任何匿名设备/安装身份。** 免费额度不依赖注册：未登录时引擎直接给 `opencode` provider 注入 `apiKey: "public"`（`node-ibnNxpSl.js:313636`、`:654816`），并禁用 `cost.input > 0` 的模型（`:313640-313646`、`:654807-654812`）。检索 `installId/install_id/machineId/telemetryId/anonymousId/distinctId/deviceId` 在全解包产物中 **0 命中**；`auth.json` 无 opencode 条目；`credential`/`account`/`control_account` 均 0 行；Sentry `setUser` 无调用点。
2. **唯一"身份"是常量级标识**：请求头 `x-opencode-client: "desktop"`（`node-ibnNxpSl.js:441034`，取值域见 `:637252`）+ 本地 project/session/request ULID 关联头（`:441028-441033`）。OAuth 的 `client_id`（`opencode-cli` @ `:313520`、`opencode-desktop` @ `dialog-connect-provider-B_bhWspV.js:1149`）只在交互式登录时用。
3. **设备流是可选升级路径**，端点为 `https://opencode.ai/console` 的 `/auth/device/code`（`node-ibnNxpSl.js:313405`、`57418`）与 `/auth/device/token`（`:313424`/`:313475`/`:57439`），渲染层有完整 UI（`dialog-connect-provider-B_bhWspV.js:1745-1827` `OAuthAutoView`），凭据落 `credential`/`account` 表 —— 当前 0 行 ⇒ 从未使用。
4. **首次使用免费模型是 0 配置 + 0~2 次点击**：首启引导只建 `Documents\Default Project`（`out/main/index.js:2586-2601`）；`opencode` 分组恒排第一（`main-C07s90t2.js:76691-76700`、`:122503-122509`）；免费模型带 `model.tag.free` 标签（`:122540-122551`）；默认模型 fallback 链 `configuredModel() ?? recentModel() ?? defaultModel()`（`:78061`）可能直接命中免费模型。
5. **无任何"免费模型可能受限"的前置提示**；所有限流文案都是事后弹窗/重试卡片。
6. **已知取证缺口**：`Network\Cookies` 被运行中的 Chromium 独占锁定，无法确认是否存在 opencode.ai cookie（未采取任何绕过手段）。

---

## 8. 证据文件清单

| 文件 | 覆盖内容 |
|---|---|
| `out/main/chunks/node-ibnNxpSl.js` | 引擎核心：provider loader `opencode` 的 `apiKey:"public"` 逻辑（`654799-654818`）、OpencodePlugin catalog transform（`313630-313646`）、OAuth 设备流（`313396-313436`、`57416-57464`）、请求头拼装（`441020-441044`）、内嵌 models.dev 快照（`169228` 行内）、`GO_UPSELL_URL`/`RETRY_*`（`441519`）、Sentry env（`1452`） |
| `out/main/index.js` | Electron 主进程：首启引导（`1115-1116`、`2573-2601`）、userData 路径（`4153-4175`）、IPC（`2077-2082`）、store 路径（`1157`）、store IPC（`2123-2150`） |
| `out/preload/index.js` | `storeGet/storeSet`（`67-72`）、`openExternal`（`95`）、`setNativeTranslations`（`130`） |
| `out/renderer/assets/main-C07s90t2.js` | 渲染层主 bundle：`DesktopFirstLaunchOnboarding`（`160781-160822`）、i18n 装载（`50774-50929`、`160740-160759`）、provider 列表归一化（`61584-61674`）、默认模型（`78031-78061`）、模型选择器与 `isFree`（`76691-76700`、`122223-122228`、`122455-122560`）、`DialogSelectModelUnpaidV2`（`127720-127736`）、弹窗 hook（`152553-152654`） |
| `out/renderer/assets/dialog-connect-provider-B_bhWspV.js` | connect 弹窗：oauth/key 方法（`1019-1036`）、`oauth.connect`（`1140-1163`）、桌面 `client_id=opencode-desktop`（`1147-1151`）、`OAuthAutoView`（`1745-1827`）、opencode 专属文案（`1438`、`1516`）、`opencode`/`opencode-go` tagline（`692`、`922-927`） |
| `out/renderer/assets/zh-cgKeHQ8h.js` / `zh-B5Hw0C7Y.js` | 中文语言包两半（app 字典 / ui 字典） |
| `%APPDATA%\ai.opencode.desktop\*` | `opencode.global.dat`、`opencode.settings`、`default.dat`、`opencode.window.*.dat`、`opencode.workspace.*.dat`、`.updaterId`、`Local Storage\leveldb\*`、`Network\*`、`logs\*` |
| `%USERPROFILE%\.local\share\opencode\` | `auth.json`（键名）、`opencode.db`（表行数）、`log\opencode.log`（免费模型调用记录） |
