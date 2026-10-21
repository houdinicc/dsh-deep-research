# dsh-deep-research 第二阶段：侧边栏面板（DeepResearch）契约 v0.1

> 目标：在 DSH Web GUI 左侧栏新增一个与「Raindrop Dashboard」同级的入口 **DeepResearch**，
> 点击打开中央面板：输入研究问题 → 调宿主真实检索 → 展示证据报告 → 保留历史。
>
> 本文件是 host-api / panel-client 两个并行实现的唯一事实来源。参考实现（已在本机跑通）：
> `~/vscode/dsh/dsh插件开发/dsh-raindrop/lib/{store,routes,client}.js`。需要偏离先改本文件。

---

## 1. 分工与写作用域

| 文件 | 负责人 |
|---|---|
| `SPEC.md`、`SPEC-UI.md`、`package.json`、`cordis.patch.yml`、`locale/*.json`、`lib/index.js`、`lib/tools.js`、`README.md` | Lead |
| `lib/store.js`、`lib/routes.js`、`test/store.test.mjs`、`test/routes.test.mjs` | **host-api** |
| `lib/client.js` | **panel-client** |

不要改别人的文件；不要运行 `plugin_manager`、不要在 profile 里装包（Lead 负责安装与验收）。

---

## 2. 数据模型（`lib/store.js`）

```js
export function resolveDataDir()   // $DSH_HOME/deep-research（DSH_HOME 缺省 ~/.dsh）
export function createStore(options = {}) // { dir, maxRuns = 20, now = () => new Date() }
// returns { file, save(result, extra?), list(), get(id), clear() }
```

- 文件 `runs.json`：`{ version: 1, runs: [record, ...] }`，新记录在前，最多 `maxRuns` 条。
- 写入：目录 `0700`、文件 `0600`、临时文件 + `rename` 原子替换；目录不存在则递归创建。
- 文件缺失/JSON 损坏/结构不认识：**不抛错**，按空列表处理（下次写入覆盖）。
- `record`（由 `save(result)` 从 `runResearch` 结果派生）：
  ```js
  { id, savedAt, question, depth, generatedAt, ok: true,
    stats, queries, sources, evidence, coverage, gaps, warnings, reportMarkdown }
  ```
  `id` 形如 `r-<时间戳36>-<6位随机>`；`savedAt` 为 ISO。
- `save()` 只接受 `result.ok === true` 的结果，否则抛 `Error('only successful runs are stored')`（route 层不保存失败）。
- `list()` 返回摘要（不含 reportMarkdown/正文）：`{ id, savedAt, question, depth, sourceCount, evidenceCount, elapsedMs }`。
- `get(id)` 返回完整 record 或 `null`。
- 测试用临时目录（`node:fs` + `os.tmpdir()`），覆盖：保存/列表/读取、超过 maxRuns 淘汰最旧、损坏文件容错、权限位（可选断言）、空库。

> 数据目录允许在测试时通过 `createStore({ dir })` 注入，**不要**在测试里碰真实 `~/.dsh`。

---

## 3. HTTP 路由（`lib/routes.js`）

```js
export function createRoutes({ config, store, web, now }) // => WebRoute[]
```

- `config`：已归一化的插件配置（含 `toolTimeoutMs` 等）；`web`：`() => ctx.get('web')`；
  `store`：上面的 store；`now`：`() => Date`。
- 调研究流水线：`import { runResearchRequest } from './tools.js'`，签名
  `runResearchRequest(args, runtime) -> Promise<ResearchResult>`，`runtime = { config, web, now }`。
- 路由前缀 `/api/dsh-deep-research`，**注册路径带前导斜杠**；客户端用文档相对路径 `api/dsh-deep-research/...`。
- 只接受回环请求：直接复用 `dsh-raindrop/lib/routes.js` 的 `isLoopbackRequest` 实现
  （`::1`/`127.*` 来源 + 回环 Host 头 + 非 cross-site），非回环一律 403。
- 信封：成功 `{ ok: true, value }`；失败 `{ ok: false, error: { code, message } }`。
- 三条 `kind: 'exact'` 路由：

| 方法/路径 | 行为 |
|---|---|
| `GET /runs` | `{ ok:true, value: { runs: store.list() } }` |
| `GET /runs?id=<id>` | 命中 `store.get(id)` → `{ ok:true, value: record }`；否则 404 `not-found` |
| `POST /run` | 读 JSON body（≤16 KiB）→ `runResearchRequest({ question, subquestions?, depth?, max_sources?, fetch_top? }, { config, web, now })` → 成功（`result.ok === true`）时 `store.save(result)`，返回 `{ ok:true, value: result }`；`result.ok === false` 时**仍 200** 返回 `{ ok:true, value: result }`（让 UI 统一渲染失败态）；body 非法/超限 → 400 `invalid-body` |

- 统一用 `kind: 'exact'` 路由 + query 参数取 id（`GET /runs?id=…`）。**不要**依赖 `kind:'prefix'`：
  本机已验证的 WebRoute 形状只有 exact（见 `dsh-raindrop/lib/routes.js` 的 `endpoint()`）。
- 错误归一：`RouteError(status, code, message)`；未知异常 → 500 `internal`。
- 测试：构造 fake req/res 直接调用 route.handler（不启动 HTTP server），覆盖：
  loopback 围栏（非回环 403）、`GET /runs` 空库、`GET /runs/<id>` 命中/未命中、
  `POST /run` 成功（fake web + 真实 runResearchRequest）并写库、`POST /run` 失败结果仍 200、
  非法 body 400、未知路径/方法 404。

---

## 4. 客户端面板（`lib/client.js`）

手写单文件 bundle，与 `dsh-raindrop/lib/client.js` 同款：

```js
window.__ModuleLoader__.load({
  id: 'dsh-deep-research',
  factory(require) { const React = require('react'); ...; return { inject: ['slots','locale'], apply(ctx) {...} }; },
});
```

- `apply`：`ctx.effect(installStyles, …)`、`ctx.effect(() => ctx.locale.register(NS, { zh, en }), …)`、
  `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name:'sidebar.panellist', id:'deep-research', order: 36, label: () => t('entry.label') }, Glyph))`、
  `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:'deep-research', locale: NS }, Panel))`。
- **入口/面板显示名：`DeepResearch`**（zh/en 都是 `DeepResearch`；面板标题同）。
- 图标：手写一个简单 SVG 组件（放大镜/层叠），用 `currentColor` 或主题 token，尺寸 18–20。
- 只使用 `--dsw-alias-*` 主题 token（可参考 raindrop 的样式变量），不写死颜色；不写组件之外的 DOM。
- UI 结构：
  1. 头部：`DeepResearch` + 一句话说明 + 右侧「刷新历史」；
  2. 表单：问题 textarea（必填）、depth 选择（quick/standard/deep）、`max_sources`、`fetch_top` 数字输入、
     「开始研究」按钮；运行中禁用 + 计时；
  3. 结果区：统计（查询数/来源数/证据数/耗时）、来源列表（`S1…`、标题、域名、`取证 ok/failed/skipped`、外链）、
     证据摘录（`>` 引用块 + 匹配词项 + 来源编号）、缺口列表、可折叠的完整报告；
  4. 历史区：最近 20 次（问题、时间、来源数、耗时），点击载入结果；
  5. 失败态：明确显示 `code + message` + 重试；空态：提示可以问什么。
- 数据通道：相对路径 `fetch('api/dsh-deep-research/...')`。
  - 首次加载 `GET runs`；运行 `POST run`；点历史 `GET runs?id=<id>`。
  - 浏览器端请求超时按 180 s 处理（研究可能跑很久），用 `AbortController`。
- 文案走 `ctx.locale`，中英各一份（`zh`/`en` 字典，`t('x', {n})` 插值格式与 raindrop 一致）。
- 组件内不要做全局副作用；卸载后无残留监听（`useEffect` cleanup）。

---

## 5. package.json / 宿主装配（Lead）

```json
"exports": { ".": "./lib/index.js", "./client": "./lib/client.js", ... },
"dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" },
         "client": { "platform": "web", "immediately": true } }
```

`lib/index.js`：
- `createStore({ dir: resolveDataDir() })`；
- `ctx.inject(['webServer'], …)` 注册 `createRoutes(...)`；
- `ctx.inject(['tools'], …)` 注册工具，并通过 `createTools({ onResult: (value) => store.save(value) })` 让 Agent 侧研究也进历史。

---

## 6. 验收（Lead 执行）

1. `npm test` 全绿（新增 store/routes 测试）。
2. `plugin_manager install_bundle` → `application: applied`。
3. 页面刷新后左侧栏出现 **DeepResearch** 入口；点开有表单、历史、空态（截图验证）。
4. 重启 Harness 后（宿主路由生效）：面板里跑一次真实研究 → 有来源/证据/缺口；刷新后历史仍在。
5. 工具侧 `deep_research` 跑一次 → 面板历史里能看到这条记录。
