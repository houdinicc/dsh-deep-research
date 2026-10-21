/**
 * DeepResearch（dsh-deep-research）—— 客户端半（浏览器 bundle）。
 *
 * 这是宿主 `exports["./client"]` 指向的产物：一个自注册的懒工厂，由
 * `window.__ModuleLoader__` 在浏览器里登记。`id` 必须等于包名 `dsh-deep-research`。
 *
 * 契约（SPEC-UI.md §4）：
 *  - 这是**手写 bundle**，不是 npm 包：只用 `require('react')`，其余全部手写，
 *    零第三方依赖、无构建步骤；
 *  - 这是**无副作用工厂**：工厂体内只声明组件与常量，样式注入与 locale 注册
 *    全部放在 `apply` 的 `ctx.effect` 里；
 *  - 只注册 `sidebar.panellist`（id `deep-research`，order 36）与 `main`
 *    （key `deep-research`）两个槽位；不写组件之外的 DOM；
 *  - 只使用 `--dsw-alias-*` 主题 token，不写字面色值。
 *
 * 数据通道：宿主 HTTP 路由 `/api/dsh-deep-research/*`。这里用**文档相对路径**
 * （GUI 有 `<base href="./">`，根绝对路径会在子路径部署下逃出前缀）。
 * 响应信封统一为 `{ ok:true, value }` / `{ ok:false, error:{ code, message } }`。
 * 注意：`POST /run` 即使研究失败也返回 HTTP 200 + `value.ok === false`，
 * 所以必须按 `value.ok` 判定成功/失败，不能只看 HTTP 状态。
 * 浏览器侧请求超时统一 180 s（AbortController）；组件卸载时中止在途请求并清理计时器。
 */

window.__ModuleLoader__.load({
  id: 'dsh-deep-research',

  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'deep-research';
    const API = 'api/dsh-deep-research';
    const REQUEST_TIMEOUT_MS = 180_000;
    const HISTORY_LIMIT = 20;
    const DEPTHS = ['quick', 'standard', 'deep'];

    // ---------------------------------------------------------------- 文案

    const zh = {
      'entry.label': 'DeepResearch',
      'panel.title': 'DeepResearch',
      'panel.subtitle': '多查询检索 · 正文取证 · 带引用的证据报告',
      'panel.refresh': '刷新历史',
      'panel.refreshing': '刷新中…',

      'form.title': '发起研究',
      'form.question': '研究问题',
      'form.questionPlaceholder': '一句话说明你要研究的问题，例如：2026 年开源向量数据库的选型对比',
      'form.depth': '研究档位',
      'form.maxSources': '最多来源',
      'form.fetchTop': '取证来源数',
      'form.optional': '留空用默认',
      'form.submit': '开始研究',
      'form.submitting': '研究进行中…',
      'form.elapsed': '已运行 {time}',
      'form.hint': '一次研究通常需要 10–120 秒，请保持页面打开；取证来源数填 0 表示只取检索结果。',

      'depth.quick': '快速（1 轮检索）',
      'depth.standard': '标准（2 轮 + 取证）',
      'depth.deep': '深度（更大预算）',

      'stats.queries': '查询',
      'stats.sources': '来源',
      'stats.evidence': '证据',
      'stats.elapsed': '耗时',

      'section.sources': '来源（按相关度）',
      'section.sources.note': '共 {n} 个',
      'section.sources.empty': '这次研究没有返回来源。',
      'section.evidence': '证据摘录',
      'section.evidence.note': '共 {n} 段',
      'section.evidence.empty': '没有抽取到证据段落，可以看完整报告或放宽取证设置。',
      'section.gaps': '缺口与提示',
      'section.gaps.empty': '这次研究没有记录到缺口。',
      'section.warnings': '运行提示',
      'section.report': '完整报告',
      'section.report.note': '{n} 字符',
      'section.report.toggle': '展开 Markdown 原文',
      'report.empty': '这次运行没有生成报告。',

      'source.untitled': '未命名来源',
      'source.unknownDomain': '未知域名',
      'source.open': '在新标签页打开：{title}',
      'source.hits': '命中 {n} 条查询',
      'source.fetch.ok': '取证 ok',
      'source.fetch.failed': '取证 failed',
      'source.fetch.skipped': '取证 skipped',
      'source.fetch.truncated': '取证 截断',
      'source.fetch.other': '取证 {status}',

      'evidence.matched': '匹配词项：{terms}',
      'evidence.empty': '（空摘录）',

      'result.generated': '生成于 {time}',
      'result.depth': '档位：{depth}',
      'result.saved': '已存入历史 · {time}',

      'history.title': '历史研究',
      'history.note': '最近 {n} 次',
      'history.empty': '还没有历史记录。完成一次研究后会出现在这里。',
      'history.loading': '载入中…',
      'history.loadFailed': '历史加载失败：{error}',
      'history.recordFailed': '载入这条研究失败：{error}',
      'history.retry': '重试',
      'history.loadRecord': '载入这次研究：{question}',
      'history.untitled': '未命名研究',
      'history.metaSources': '{n} 个来源',
      'history.metaElapsed': '耗时 {time}',

      'state.loading': '加载中…',
      'state.running': '正在检索与取证，请稍候…',

      'empty.title': '从一个研究问题开始',
      'empty.intro':
        '插件会围绕问题扩展多条查询、合并去重、抓取高相关正文并抽取证据段落，最后给出带来源编号的证据报告。',
      'empty.exampleLabel': '可以这样问：',
      'empty.example1': '对比 2026 年主流开源向量数据库的检索性能',
      'empty.example2': 'Rust 异步运行时在 2026 年的选型现状与最新进展',
      'empty.example3': '全电发票的报销合规要求有哪些',

      'failure.title': '研究未完成',
      'failure.retry': '重试',

      'error.network': '网络请求失败：宿主可能未启动，或路由未注册。',
      'error.timeout': '请求超过 180 秒仍未返回，已中止。',
      'error.badResponse': '宿主返回了无法解析的响应。',
      'error.notFound': '记录不存在或已被清理。',
      'error.unknown': '未知错误（{error}）',

      'duration.ms': '{n} 毫秒',
      'duration.seconds': '{n} 秒',
      'duration.minutes': '{m} 分 {s} 秒',
      'list.sep': '、',
    };

    const en = {
      'entry.label': 'DeepResearch',
      'panel.title': 'DeepResearch',
      'panel.subtitle': 'Multi-query search · source fetching · cited evidence report',
      'panel.refresh': 'Refresh history',
      'panel.refreshing': 'Refreshing…',

      'form.title': 'Start a research run',
      'form.question': 'Research question',
      'form.questionPlaceholder': 'State the question in one sentence, e.g. comparing open-source vector databases in 2026',
      'form.depth': 'Depth',
      'form.maxSources': 'Max sources',
      'form.fetchTop': 'Sources to fetch',
      'form.optional': 'Blank = default',
      'form.submit': 'Start research',
      'form.submitting': 'Researching…',
      'form.elapsed': 'Running for {time}',
      'form.hint': 'A run usually takes 10–120 s; keep this page open. Set sources to fetch to 0 to skip fetching.',

      'depth.quick': 'Quick (1 round)',
      'depth.standard': 'Standard (2 rounds + fetch)',
      'depth.deep': 'Deep (bigger budget)',

      'stats.queries': 'Queries',
      'stats.sources': 'Sources',
      'stats.evidence': 'Evidence',
      'stats.elapsed': 'Elapsed',

      'section.sources': 'Sources (by relevance)',
      'section.sources.note': '{n} total',
      'section.sources.empty': 'This run returned no sources.',
      'section.evidence': 'Evidence excerpts',
      'section.evidence.note': '{n} excerpts',
      'section.evidence.empty': 'No evidence passages were extracted; see the full report or relax the fetch settings.',
      'section.gaps': 'Gaps and caveats',
      'section.gaps.empty': 'No gaps were recorded for this run.',
      'section.warnings': 'Run warnings',
      'section.report': 'Full report',
      'section.report.note': '{n} chars',
      'section.report.toggle': 'Show Markdown source',
      'report.empty': 'This run produced no report.',

      'source.untitled': 'Untitled source',
      'source.unknownDomain': 'Unknown domain',
      'source.open': 'Open in a new tab: {title}',
      'source.hits': 'Matched {n} queries',
      'source.fetch.ok': 'fetch ok',
      'source.fetch.failed': 'fetch failed',
      'source.fetch.skipped': 'fetch skipped',
      'source.fetch.truncated': 'fetch truncated',
      'source.fetch.other': 'fetch {status}',

      'evidence.matched': 'Matched terms: {terms}',
      'evidence.empty': '(empty excerpt)',

      'result.generated': 'Generated {time}',
      'result.depth': 'Depth: {depth}',
      'result.saved': 'Saved to history · {time}',

      'history.title': 'Research history',
      'history.note': 'Latest {n}',
      'history.empty': 'No history yet. Finished runs will show up here.',
      'history.loading': 'Loading…',
      'history.loadFailed': 'Failed to load history: {error}',
      'history.recordFailed': 'Failed to load this run: {error}',
      'history.retry': 'Retry',
      'history.loadRecord': 'Load this run: {question}',
      'history.untitled': 'Untitled run',
      'history.metaSources': '{n} sources',
      'history.metaElapsed': 'took {time}',

      'state.loading': 'Loading…',
      'state.running': 'Searching and fetching sources…',

      'empty.title': 'Start with a research question',
      'empty.intro':
        'The plugin expands your question into multiple queries, merges and de-duplicates results, fetches the most relevant pages, extracts evidence passages and returns a cited evidence report.',
      'empty.exampleLabel': 'Try an example:',
      'empty.example1': 'Compare retrieval performance of mainstream open-source vector databases in 2026',
      'empty.example2': 'Rust async runtimes in 2026: current choices and recent progress',
      'empty.example3': 'Compliance requirements for reimbursement with fully digital invoices',

      'failure.title': 'Research did not finish',
      'failure.retry': 'Retry',

      'error.network': 'Network request failed: the host may be down or the route is not registered.',
      'error.timeout': 'The request did not return within 180 s and was aborted.',
      'error.badResponse': 'The host returned an unreadable response.',
      'error.notFound': 'The record does not exist or was removed.',
      'error.unknown': 'Unknown error ({error})',

      'duration.ms': '{n} ms',
      'duration.seconds': '{n} s',
      'duration.minutes': '{m} min {s} s',
      'list.sep': ', ',
    };

    // --------------------------------------------------------------- 样式

    const CSS = `
.dr-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dr-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 20px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dr-header-main{display:flex;align-items:center;gap:8px;min-width:0;flex:0 0 auto}
.dr-title{margin:0;font-size:16px;font-weight:600;white-space:nowrap}
.dr-subtitle{min-width:0;flex:1 1 220px;font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-spacer{flex:1 1 auto}
.dr-glyph{display:inline-flex;color:var(--dsw-alias-brand-primary)}
.dr-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 20px 32px}
.dr-layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px;align-items:start;max-width:1320px;margin:0 auto}
.dr-main{min-width:0}
.dr-side{min-width:0;position:sticky;top:0}
.dr-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;margin:0 0 12px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.dr-side .dr-card{margin:0}
.dr-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.dr-card-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dr-card-note{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8}
.dr-form{display:flex;flex-direction:column;gap:10px}
.dr-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dr-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.dr-textarea,.dr-input,.dr-select{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 10px;font:inherit}
.dr-textarea{min-height:76px;resize:vertical;line-height:21px}
.dr-textarea:disabled,.dr-input:disabled,.dr-select:disabled{opacity:.6;cursor:not-allowed}
.dr-textarea:focus,.dr-input:focus,.dr-select:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dr-textarea::placeholder,.dr-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.7}
.dr-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.dr-row>.dr-field{flex:1 1 140px}
.dr-form-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:2px}
.dr-primary{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-brand-primary);border:0;border-radius:6px;padding:5px 12px;font:inherit;cursor:pointer;flex:0 0 auto;white-space:nowrap}
.dr-primary:disabled{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:default}
.dr-ghost{color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer;flex:0 0 auto;white-space:nowrap}
.dr-ghost:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.dr-ghost:disabled{opacity:.55;cursor:default}
.dr-hint{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dr-timer{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dr-timer.is-live{color:var(--dsw-alias-brand-primary)}
.dr-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin:4px 0 0}
.dr-kpi{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 12px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.dr-kpi-value{font-size:22px;font-weight:600;line-height:30px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-kpi-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dr-result-question{font-size:15px;font-weight:600;line-height:24px;margin:2px 0 6px;overflow-wrap:anywhere}
.dr-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);margin:0 0 10px;overflow-wrap:anywhere}
.dr-items{display:flex;flex-direction:column;min-width:0}
.dr-result{min-width:0}
.dr-source{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}
.dr-source:last-child{border-bottom:0}
.dr-source-badge{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:22px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.dr-source-main{flex:1 1 auto;min-width:0}
.dr-source-title{color:var(--dsw-alias-label-primary);text-decoration:none;font-weight:500;overflow-wrap:anywhere}
.dr-source-title:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}
.dr-source-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:3px}
.dr-domain{overflow-wrap:anywhere}
.dr-flag{display:inline-flex;align-items:center;padding:0 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:16px;white-space:nowrap}
.dr-flag.is-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dr-flag.is-failed{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dr-flag.is-skipped{color:var(--dsw-alias-label-secondary)}
.dr-flag.is-truncated{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dr-evidence{padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}
.dr-evidence:last-child{border-bottom:0}
.dr-quote{margin:0;padding:8px 12px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);border-radius:0 8px 8px 0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:21px;overflow-wrap:anywhere;white-space:pre-wrap}
.dr-evidence-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:6px}
.dr-evidence-ref{color:var(--dsw-alias-brand-primary);text-decoration:none;font-weight:600}
.dr-evidence-ref:hover{text-decoration:underline}
.dr-list{margin:0;padding-left:18px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dr-list li{margin:4px 0;overflow-wrap:anywhere}
.dr-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;overflow-wrap:anywhere}
.dr-details{margin-top:2px}
.dr-details>summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);padding:4px 0}
.dr-details>summary:hover{color:var(--dsw-alias-label-primary)}
.dr-report{margin:8px 0 0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:520px;overflow:auto}
.dr-empty{color:var(--dsw-alias-label-secondary);font-size:13px;padding:6px 0;overflow-wrap:anywhere}
.dr-empty-title{margin:0 0 6px;font-size:15px;font-weight:600}
.dr-empty-intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;overflow-wrap:anywhere}
.dr-examples{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.dr-example{text-align:left;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer;overflow-wrap:anywhere}
.dr-example:hover{border-color:var(--dsw-alias-brand-primary)}
.dr-error-card{display:flex;flex-direction:column;gap:6px;margin:0 0 12px;padding:12px 14px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.dr-error-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:600}
.dr-error-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dr-error-msg{font-size:13px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dr-error-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.dr-inline-error{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-state-error-primary);font-size:12px;margin:4px 0;overflow-wrap:anywhere}
.dr-running{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary)}
.dr-spinner{flex:0 0 auto;width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-brand-primary);animation:dr-spin .9s linear infinite}
.dr-history{max-height:min(72vh,760px);overflow:auto}
.dr-history-item{display:block;width:100%;text-align:left;background:0 0;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);padding:8px 2px;font:inherit;color:inherit;cursor:pointer;border-radius:4px}
.dr-history-item:last-child{border-bottom:0}
.dr-history-item:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dr-history-item:disabled{opacity:.6;cursor:default}
.dr-history-item.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
.dr-history-question{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dr-history-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px;font-variant-numeric:tabular-nums}
@keyframes dr-spin{to{transform:rotate(360deg)}}
@media (max-width:1000px){.dr-layout{grid-template-columns:minmax(0,1fr)}.dr-side{position:static}.dr-history{max-height:none}}
@media (prefers-reduced-motion:reduce){.dr-spinner{animation:none}}
`;

    const STYLE_TAG_ID = 'dsh-deep-research';

    /** 幂等地把样式注入 document.head；返回移除函数。 */
    function installStyles() {
      if (typeof document === 'undefined') return () => {};
      const selector = `style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`;
      const existing = document.querySelector(selector);
      if (existing !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.pluginCss = STYLE_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
      };
    }

    // ------------------------------------------------------------ 数据通道

    function timeoutError() {
      const error = new Error(`request timed out after ${REQUEST_TIMEOUT_MS} ms`);
      error.code = 'timeout';
      return error;
    }

    function abortError() {
      const error = new Error('request aborted');
      error.name = 'AbortError';
      error.code = 'aborted';
      return error;
    }

    function badResponseError(status) {
      const error = new Error(`HTTP ${status}`);
      error.code = 'bad-response';
      return error;
    }

    /**
     * 带 180 s 超时的 JSON 请求；返回信封里的 `value`。
     * 信封 `{ok:false}` 会抛带 `code` 的 Error；外部 signal 取消时抛 `AbortError`。
     */
    async function request(path, init, externalSignal) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
      const forwardAbort = () => controller.abort();
      if (externalSignal !== undefined) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener('abort', forwardAbort, { once: true });
      }
      const headers = init?.body === undefined ? undefined : { 'content-type': 'application/json' };
      try {
        let response;
        try {
          response = await fetch(`${API}${path}`, { ...init, headers, signal: controller.signal });
        } catch (cause) {
          if (timedOut) throw timeoutError();
          if (externalSignal?.aborted === true) throw abortError();
          const error = new Error(String(cause?.message ?? cause));
          error.code = 'network';
          throw error;
        }
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (payload === null || typeof payload !== 'object') {
          // 读响应体阶段也可能超时/被取消，这里同样按超时、取消处理。
          if (timedOut) throw timeoutError();
          if (externalSignal?.aborted === true) throw abortError();
          throw badResponseError(response.status);
        }
        if (payload.ok !== true) {
          const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
          error.code = payload?.error?.code ?? `http-${response.status}`;
          throw error;
        }
        return payload.value;
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener?.('abort', forwardAbort);
      }
    }

    const api = {
      listRuns: (signal) => request('/runs', undefined, signal),
      run: (body, signal) => request('/run', { method: 'POST', body: JSON.stringify(body) }, signal),
      getRun: (id, signal) => request(`/runs?id=${encodeURIComponent(id)}`, undefined, signal),
    };

    // -------------------------------------------------------------- 小工具

    const FETCH_STATUS_KEYS = {
      ok: 'source.fetch.ok',
      failed: 'source.fetch.failed',
      skipped: 'source.fetch.skipped',
      truncated: 'source.fetch.truncated',
    };

    const cls = (...parts) => parts.filter(Boolean).join(' ');

    const pad2 = (value) => String(value).padStart(2, '0');

    function asString(value) {
      if (typeof value === 'string') return value;
      if (value === null || value === undefined) return '';
      return String(value);
    }

    function safeArray(value) {
      return Array.isArray(value) ? value : [];
    }

    function formatCount(value) {
      const num = Number(value);
      if (!Number.isFinite(num)) return '0';
      return String(Math.round(num)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function formatStamp(value) {
      const text = asString(value);
      const time = Date.parse(text);
      if (!Number.isFinite(time)) return text === '' ? '—' : text;
      const date = new Date(time);
      const now = new Date();
      const datePart =
        date.getFullYear() === now.getFullYear()
          ? `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
          : `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
      return `${datePart} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    function formatDuration(value, t) {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms < 0) return '—';
      if (ms < 1000) return t('duration.ms', { n: Math.round(ms) });
      if (ms < 60_000) return t('duration.seconds', { n: (ms / 1000).toFixed(1) });
      const total = Math.floor(ms / 1000);
      return t('duration.minutes', { m: Math.floor(total / 60), s: pad2(total % 60) });
    }

    function depthLabel(value, t) {
      const key = asString(value);
      if (key === '') return '—';
      return DEPTHS.includes(key) ? t(`depth.${key}`) : key;
    }

    function fetchStatusView(value, t) {
      const status = asString(value) === '' ? 'skipped' : asString(value);
      const key = FETCH_STATUS_KEYS[status];
      return {
        label: key === undefined ? t('source.fetch.other', { status }) : t(key),
        tone:
          status === 'ok'
            ? 'is-ok'
            : status === 'failed'
              ? 'is-failed'
              : status === 'truncated'
                ? 'is-truncated'
                : 'is-skipped',
      };
    }

    /** 把内部错误对象翻成一句人可读的文案（已知传输错误走字典，其余用宿主 message）。 */
    function describeFailure(failure, t) {
      const code = asString(failure?.code);
      if (code === 'network') return t('error.network');
      if (code === 'timeout') return t('error.timeout');
      if (code === 'bad-response') return t('error.badResponse');
      if (code === 'not-found') return t('error.notFound');
      const message = asString(failure?.message);
      if (message !== '') return message;
      return t('error.unknown', { error: code === '' ? 'unknown' : code });
    }

    /** 只接受整数字符串；空串返回 null（不传该字段，交给宿主默认值）。 */
    function intOrNull(value, min, max) {
      const text = asString(value).trim();
      if (text === '') return null;
      const num = Number(text);
      if (!Number.isFinite(num)) return null;
      return Math.min(max, Math.max(min, Math.trunc(num)));
    }

    // ------------------------------------------------------------ 侧边栏字形

    function DeepResearchGlyph({ size = 18 }) {
      return h(
        'svg',
        {
          className: 'dr-glyph',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
        },
        h('circle', {
          cx: 10.5,
          cy: 10.5,
          r: 5.5,
          stroke: 'currentColor',
          strokeWidth: 1.6,
        }),
        h('path', {
          d: 'M14.8 14.8 20 20',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M8.2 7.7h4.6M8.2 10.3h3.1',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          opacity: 0.6,
        }),
      );
    }

    // -------------------------------------------------------------- 子组件

    function Kpi({ label, value }) {
      return h(
        'div',
        { className: 'dr-kpi' },
        h('div', { className: 'dr-kpi-value', title: String(value) }, String(value)),
        h('div', { className: 'dr-kpi-label' }, label),
      );
    }

    function Section({ title, note, empty, emptyText, children }) {
      return h(
        'section',
        { className: 'dr-card' },
        h(
          'div',
          { className: 'dr-card-head' },
          h('h2', { className: 'dr-card-title' }, title),
          note === null || note === undefined ? null : h('span', { className: 'dr-card-note' }, note),
        ),
        empty === true ? h('div', { className: 'dr-empty' }, emptyText) : children,
      );
    }

    function ResearchForm({ t, form, running, elapsedMs, onChange, onSubmit, textareaRef }) {
      return h(
        'form',
        { className: 'dr-card dr-form', onSubmit },
        h(
          'div',
          { className: 'dr-card-head' },
          h('h2', { className: 'dr-card-title' }, t('form.title')),
        ),
        h(
          'label',
          { className: 'dr-field' },
          h('span', { className: 'dr-label' }, t('form.question')),
          h('textarea', {
            ref: textareaRef,
            className: 'dr-textarea',
            rows: 3,
            maxLength: 300,
            required: true,
            spellCheck: false,
            placeholder: t('form.questionPlaceholder'),
            'aria-label': t('form.question'),
            value: form.question,
            disabled: running,
            onChange: onChange('question'),
          }),
        ),
        h(
          'div',
          { className: 'dr-row' },
          h(
            'label',
            { className: 'dr-field' },
            h('span', { className: 'dr-label' }, t('form.depth')),
            h(
              'select',
              {
                className: 'dr-select',
                'aria-label': t('form.depth'),
                value: form.depth,
                disabled: running,
                onChange: onChange('depth'),
              },
              ...DEPTHS.map((depth) =>
                h('option', { key: depth, value: depth }, t(`depth.${depth}`)),
              ),
            ),
          ),
          h(
            'label',
            { className: 'dr-field' },
            h('span', { className: 'dr-label' }, t('form.maxSources')),
            h('input', {
              className: 'dr-input',
              type: 'number',
              inputMode: 'numeric',
              min: 1,
              max: 30,
              step: 1,
              placeholder: t('form.optional'),
              'aria-label': t('form.maxSources'),
              value: form.maxSources,
              disabled: running,
              onChange: onChange('maxSources'),
            }),
          ),
          h(
            'label',
            { className: 'dr-field' },
            h('span', { className: 'dr-label' }, t('form.fetchTop')),
            h('input', {
              className: 'dr-input',
              type: 'number',
              inputMode: 'numeric',
              min: 0,
              max: 8,
              step: 1,
              placeholder: t('form.optional'),
              'aria-label': t('form.fetchTop'),
              value: form.fetchTop,
              disabled: running,
              onChange: onChange('fetchTop'),
            }),
          ),
        ),
        h(
          'div',
          { className: 'dr-form-foot' },
          h(
            'button',
            { type: 'submit', className: 'dr-primary', disabled: running || form.question.trim() === '' },
            running ? t('form.submitting') : t('form.submit'),
          ),
          running
            ? h(
                'span',
                { className: 'dr-timer is-live', role: 'status', 'aria-live': 'polite' },
                t('form.elapsed', { time: formatDuration(elapsedMs, t) }),
              )
            : h('span', { className: 'dr-hint' }, t('form.hint')),
        ),
      );
    }

    function EmptyState({ t, onPick }) {
      const examples = [t('empty.example1'), t('empty.example2'), t('empty.example3')];
      return h(
        'section',
        { className: 'dr-card' },
        h('h2', { className: 'dr-empty-title' }, t('empty.title')),
        h('p', { className: 'dr-empty-intro' }, t('empty.intro')),
        h(
          'div',
          { className: 'dr-examples' },
          h('span', { className: 'dr-label' }, t('empty.exampleLabel')),
          ...examples.map((text, index) =>
            h(
              'button',
              { key: `example-${index}`, type: 'button', className: 'dr-example', onClick: () => onPick(text) },
              text,
            ),
          ),
        ),
      );
    }

    function FailureCard({ t, failure, onRetry, retryDisabled }) {
      const code = asString(failure?.code) === '' ? 'unknown' : asString(failure?.code);
      return h(
        'section',
        { className: 'dr-error-card', role: 'alert' },
        h(
          'div',
          { className: 'dr-error-head' },
          h('span', {}, t('failure.title')),
          h('code', { className: 'dr-error-code' }, code),
        ),
        h('div', { className: 'dr-error-msg' }, describeFailure(failure, t)),
        h(
          'div',
          { className: 'dr-error-actions' },
          h(
            'button',
            { type: 'button', className: 'dr-primary', onClick: onRetry, disabled: retryDisabled === true },
            t('failure.retry'),
          ),
        ),
      );
    }

    function ResultSummary({ t, value }) {
      const question = asString(value?.question);
      const depth = asString(value?.depth);
      const generatedAt = asString(value?.generatedAt);
      const savedAt = asString(value?.savedAt);
      const stats = value?.stats ?? {};

      const meta = [];
      if (generatedAt !== '') {
        meta.push(h('span', { key: 'generated' }, t('result.generated', { time: formatStamp(generatedAt) })));
      }
      if (depth !== '') {
        meta.push(h('span', { key: 'depth' }, t('result.depth', { depth: depthLabel(depth, t) })));
      }
      if (savedAt !== '') {
        meta.push(h('span', { key: 'saved', className: 'dr-flag' }, t('result.saved', { time: formatStamp(savedAt) })));
      }

      const kpis = [
        { key: 'queries', label: t('stats.queries'), value: formatCount(safeArray(value?.queries).length) },
        { key: 'sources', label: t('stats.sources'), value: formatCount(safeArray(value?.sources).length) },
        { key: 'evidence', label: t('stats.evidence'), value: formatCount(safeArray(value?.evidence).length) },
        { key: 'elapsed', label: t('stats.elapsed'), value: formatDuration(stats?.elapsedMs, t) },
      ];

      return h(
        'section',
        { className: 'dr-card' },
        question === '' ? null : h('h2', { className: 'dr-result-question' }, question),
        meta.length === 0 ? null : h('div', { className: 'dr-meta' }, ...meta),
        h(
          'div',
          { className: 'dr-kpis' },
          ...kpis.map((item) => h(Kpi, { key: item.key, label: item.label, value: item.value })),
        ),
      );
    }

    function SourcesSection({ t, value }) {
      const sources = safeArray(value?.sources);
      const rows = sources.map((source, index) => {
        const id = asString(source?.id) === '' ? `S${index + 1}` : asString(source?.id);
        const url = asString(source?.url);
        const title = asString(source?.title) === '' ? url === '' ? t('source.untitled') : url : asString(source?.title);
        const domain = asString(source?.domain) === '' ? t('source.unknownDomain') : asString(source?.domain);
        const hits = safeArray(source?.queries).length;
        const status = fetchStatusView(source?.fetchStatus, t);

        const titleNode =
          url === ''
            ? h('span', { className: 'dr-source-title' }, title)
            : h(
                'a',
                {
                  className: 'dr-source-title',
                  href: url,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  title: url,
                  'aria-label': t('source.open', { title }),
                },
                title,
              );

        const meta = [h('span', { key: 'domain', className: 'dr-domain' }, domain)];
        meta.push(h('span', { key: 'fetch', className: cls('dr-flag', status.tone) }, status.label));
        if (hits > 0) meta.push(h('span', { key: 'hits' }, t('source.hits', { n: formatCount(hits) })));

        return h(
          'div',
          { key: `${id}-${index}`, className: 'dr-source' },
          h('span', { className: 'dr-source-badge' }, id),
          h(
            'div',
            { className: 'dr-source-main' },
            titleNode,
            h('div', { className: 'dr-source-meta' }, ...meta),
          ),
        );
      });

      return h(
        Section,
        {
          title: t('section.sources'),
          note: sources.length === 0 ? null : t('section.sources.note', { n: formatCount(sources.length) }),
          empty: sources.length === 0,
          emptyText: t('section.sources.empty'),
        },
        h('div', { className: 'dr-items' }, ...rows),
      );
    }

    function EvidenceSection({ t, value }) {
      const evidence = safeArray(value?.evidence);
      const rows = evidence.map((item, index) => {
        const sourceId = asString(item?.sourceId);
        const url = asString(item?.url);
        const title = asString(item?.title);
        const matched = safeArray(item?.matchedTerms).map((term) => asString(term)).filter((term) => term !== '');
        const passage = asString(item?.passage);

        const refNode =
          sourceId === ''
            ? null
            : url === ''
              ? h('span', { className: 'dr-evidence-ref' }, `[${sourceId}]`)
              : h(
                  'a',
                  {
                    className: 'dr-evidence-ref',
                    href: url,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    title: url,
                    'aria-label': t('source.open', { title: title === '' ? sourceId : title }),
                  },
                  `[${sourceId}]`,
                );

        const meta = [];
        if (refNode !== null) meta.push(h('span', { key: 'ref' }, refNode));
        if (title !== '') meta.push(h('span', { key: 'title' }, title));
        if (matched.length > 0) {
          meta.push(h('span', { key: 'matched' }, t('evidence.matched', { terms: matched.join(t('list.sep')) })));
        }

        return h(
          'div',
          { key: `evidence-${sourceId}-${index}`, className: 'dr-evidence' },
          h('blockquote', { className: 'dr-quote' }, passage === '' ? t('evidence.empty') : passage),
          meta.length === 0 ? null : h('div', { className: 'dr-evidence-meta' }, ...meta),
        );
      });

      return h(
        Section,
        {
          title: t('section.evidence'),
          note: evidence.length === 0 ? null : t('section.evidence.note', { n: formatCount(evidence.length) }),
          empty: evidence.length === 0,
          emptyText: t('section.evidence.empty'),
        },
        h('div', { className: 'dr-items' }, ...rows),
      );
    }

    function GapsSection({ t, value }) {
      const gaps = safeArray(value?.gaps).map((gap) => asString(gap)).filter((gap) => gap !== '');
      return h(
        Section,
        {
          title: t('section.gaps'),
          empty: gaps.length === 0,
          emptyText: t('section.gaps.empty'),
        },
        h(
          'ul',
          { className: 'dr-list' },
          ...gaps.map((gap, index) => h('li', { key: `gap-${index}` }, gap)),
        ),
      );
    }

    function WarningsSection({ t, value }) {
      const warnings = safeArray(value?.warnings).map((warning) => asString(warning)).filter((warning) => warning !== '');
      if (warnings.length === 0) return null;
      return h(
        'section',
        { className: 'dr-card' },
        h(
          'div',
          { className: 'dr-card-head' },
          h('h2', { className: 'dr-card-title' }, t('section.warnings')),
        ),
        h(
          'ul',
          { className: 'dr-list' },
          ...warnings.map((warning, index) => h('li', { key: `warning-${index}`, className: 'dr-warn' }, warning)),
        ),
      );
    }

    function ReportSection({ t, value }) {
      const report = asString(value?.reportMarkdown);
      return h(
        'section',
        { className: 'dr-card' },
        h(
          'div',
          { className: 'dr-card-head' },
          h('h2', { className: 'dr-card-title' }, t('section.report')),
          h('span', { className: 'dr-card-note' }, t('section.report.note', { n: formatCount(report.length) })),
        ),
        h(
          'details',
          { className: 'dr-details' },
          h('summary', {}, t('section.report.toggle')),
          h('pre', { className: 'dr-report' }, report === '' ? t('report.empty') : report),
        ),
      );
    }

    function ResultView({ t, value }) {
      return h(
        'div',
        { className: 'dr-result' },
        h(ResultSummary, { t, value }),
        h(WarningsSection, { t, value }),
        h(SourcesSection, { t, value }),
        h(EvidenceSection, { t, value }),
        h(GapsSection, { t, value }),
        h(ReportSection, { t, value }),
      );
    }

    function HistoryPanel({
      t,
      runs,
      loading,
      error,
      recordError,
      selectedId,
      loadingId,
      busy,
      onRefresh,
      onOpen,
      onRetryRecord,
    }) {
      const rows = safeArray(runs).slice(0, HISTORY_LIMIT);

      let content;
      if (runs === null && loading) {
        content = h('div', { className: 'dr-empty' }, t('state.loading'));
      } else if (rows.length === 0) {
        content = h('div', { className: 'dr-empty' }, t('history.empty'));
      } else {
        content = h(
          'div',
          {},
          ...rows.map((run, index) => {
            const id = asString(run?.id);
            const question = asString(run?.question) === '' ? t('history.untitled') : asString(run?.question);
            const active = id !== '' && id === selectedId;
            const busy = id !== '' && id === loadingId;
            const meta = [
              h('span', { key: 'time' }, formatStamp(run?.savedAt)),
              h('span', { key: 'sources' }, t('history.metaSources', { n: formatCount(run?.sourceCount ?? 0) })),
              h('span', { key: 'elapsed' }, t('history.metaElapsed', { time: formatDuration(run?.elapsedMs, t) })),
            ];
            if (DEPTHS.includes(asString(run?.depth))) {
              meta.push(h('span', { key: 'depth', className: 'dr-flag' }, depthLabel(run?.depth, t)));
            }
            if (busy) meta.push(h('span', { key: 'busy' }, t('history.loading')));

            return h(
              'button',
              {
                key: id === '' ? `history-${index}` : id,
                type: 'button',
                className: cls('dr-history-item', active && 'is-active'),
                disabled: busy || id === '',
                title: t('history.loadRecord', { question }),
                'aria-label': t('history.loadRecord', { question }),
                onClick: () => onOpen(id),
              },
              h('span', { className: 'dr-history-question' }, question),
              h('div', { className: 'dr-history-meta' }, ...meta),
            );
          }),
        );
      }

      return h(
        'aside',
        { className: 'dr-side' },
        h(
          'section',
          { className: 'dr-card dr-history' },
          h(
            'div',
            { className: 'dr-card-head' },
            h('h2', { className: 'dr-card-title' }, t('history.title')),
            rows.length === 0 ? null : h('span', { className: 'dr-card-note' }, t('history.note', { n: formatCount(rows.length) })),
          ),
          error === null
            ? null
            : h(
                'div',
                { className: 'dr-inline-error', role: 'alert' },
                h('span', {}, t('history.loadFailed', { error: describeFailure(error, t) })),
                h('button', { type: 'button', className: 'dr-ghost', onClick: onRefresh }, t('history.retry')),
              ),
          content,
          recordError === null
            ? null
            : h(
                'div',
                { className: 'dr-inline-error', role: 'alert' },
                h('span', {}, t('history.recordFailed', { error: describeFailure(recordError, t) })),
                h(
                  'button',
                  { type: 'button', className: 'dr-ghost', onClick: () => onRetryRecord(asString(recordError?.id)) },
                  t('history.retry'),
                ),
              ),
        ),
      );
    }

    // -------------------------------------------------------------- 主面板

    function DeepResearchPanel({ t }) {
      const tr = typeof t === 'function' ? t : (key) => key;

      const [form, setForm] = React.useState({ question: '', depth: 'standard', maxSources: '', fetchTop: '' });
      const [runs, setRuns] = React.useState(null);
      const [historyLoading, setHistoryLoading] = React.useState(true);
      const [historyError, setHistoryError] = React.useState(null);
      const [recordError, setRecordError] = React.useState(null);
      const [loadingRecordId, setLoadingRecordId] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [failure, setFailure] = React.useState(null);
      const [selectedId, setSelectedId] = React.useState(null);
      const [runningSince, setRunningSince] = React.useState(null);
      const [elapsedMs, setElapsedMs] = React.useState(0);

      const textareaRef = React.useRef(null);
      const aliveRef = React.useRef(true);
      const runAbortRef = React.useRef(null);
      const historyAbortRef = React.useRef(null);
      const recordAbortRef = React.useRef(null);

      React.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
          if (runAbortRef.current !== null) runAbortRef.current.abort();
          if (historyAbortRef.current !== null) historyAbortRef.current.abort();
          if (recordAbortRef.current !== null) recordAbortRef.current.abort();
        };
      }, []);

      const loadHistory = React.useCallback(async (options) => {
        const silent = options?.silent === true;
        if (historyAbortRef.current !== null) historyAbortRef.current.abort();
        const controller = new AbortController();
        historyAbortRef.current = controller;
        if (!silent) setHistoryLoading(true);
        try {
          const value = await api.listRuns(controller.signal);
          if (!aliveRef.current || controller.signal.aborted) return;
          setRuns(safeArray(value?.runs));
          setHistoryError(null);
        } catch (cause) {
          if (!aliveRef.current || controller.signal.aborted || cause?.code === 'aborted') return;
          setHistoryError({ code: asString(cause?.code) || 'unknown', message: asString(cause?.message) });
        } finally {
          if (aliveRef.current && historyAbortRef.current === controller) {
            historyAbortRef.current = null;
            setHistoryLoading(false);
          }
        }
      }, []);

      React.useEffect(() => {
        loadHistory();
      }, [loadHistory]);

      React.useEffect(() => {
        if (runningSince === null) return undefined;
        const tick = () => setElapsedMs(Date.now() - runningSince);
        tick();
        const timer = setInterval(tick, 500);
        return () => clearInterval(timer);
      }, [runningSince]);

      const openRecord = React.useCallback(async (rawId) => {
        const id = asString(rawId);
        if (id === '') return;
        if (recordAbortRef.current !== null) recordAbortRef.current.abort();
        const controller = new AbortController();
        recordAbortRef.current = controller;
        setLoadingRecordId(id);
        setRecordError(null);
        try {
          const record = await api.getRun(id, controller.signal);
          if (!aliveRef.current || controller.signal.aborted) return;
          if (record === null || typeof record !== 'object') {
            setRecordError({ id, code: 'bad-response', message: '' });
            return;
          }
          setResult(record);
          setFailure(null);
          setSelectedId(asString(record.id) === '' ? id : asString(record.id));
          const recordQuestion = asString(record.question);
          const recordDepth = asString(record.depth);
          setForm((prev) => ({
            ...prev,
            question: recordQuestion === '' ? prev.question : recordQuestion,
            depth: DEPTHS.includes(recordDepth) ? recordDepth : prev.depth,
          }));
        } catch (cause) {
          if (!aliveRef.current || controller.signal.aborted || cause?.code === 'aborted') return;
          setRecordError({ id, code: asString(cause?.code) || 'unknown', message: asString(cause?.message) });
        } finally {
          if (aliveRef.current && recordAbortRef.current === controller) {
            recordAbortRef.current = null;
            setLoadingRecordId(null);
          }
        }
      }, []);

      const startResearch = async (event) => {
        if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault();
        const question = form.question.trim();
        if (question === '' || runningSince !== null) return;

        const payload = { question, depth: DEPTHS.includes(form.depth) ? form.depth : 'standard' };
        const maxSources = intOrNull(form.maxSources, 1, 30);
        const fetchTop = intOrNull(form.fetchTop, 0, 8);
        if (maxSources !== null) payload.max_sources = maxSources;
        if (fetchTop !== null) payload.fetch_top = fetchTop;

        if (runAbortRef.current !== null) runAbortRef.current.abort();
        const controller = new AbortController();
        runAbortRef.current = controller;
        setFailure(null);
        setResult(null);
        setSelectedId(null);
        setRecordError(null);
        setRunningSince(Date.now());
        setElapsedMs(0);

        try {
          const value = await api.run(payload, controller.signal);
          if (!aliveRef.current || controller.signal.aborted) return;
          // POST /run 失败时仍是 HTTP 200，必须按 value.ok 渲染失败态。
          if (value === null || typeof value !== 'object' || value.ok !== true) {
            setFailure({
              code: asString(value?.code) === '' ? 'internal' : asString(value?.code),
              message: asString(value?.message),
            });
            return;
          }
          setResult(value);
          await loadHistory({ silent: true });
        } catch (cause) {
          if (!aliveRef.current || controller.signal.aborted || cause?.code === 'aborted') return;
          setFailure({ code: asString(cause?.code) || 'unknown', message: asString(cause?.message) });
        } finally {
          if (aliveRef.current) setRunningSince(null);
          if (runAbortRef.current === controller) runAbortRef.current = null;
        }
      };

      const changeField = (field) => (event) => {
        const value = event?.target?.value;
        setForm((prev) => ({ ...prev, [field]: typeof value === 'string' ? value : '' }));
      };

      const pickExample = (text) => {
        setForm((prev) => ({ ...prev, question: text }));
        textareaRef.current?.focus();
      };

      const running = runningSince !== null;
      const retryDisabled = form.question.trim() === '' || running;

      const runningCard = running
        ? h(
            'section',
            { className: 'dr-card dr-running', role: 'status', 'aria-live': 'polite' },
            h('span', { className: 'dr-spinner', 'aria-hidden': true }),
            h('span', {}, tr('state.running')),
            h('span', { className: 'dr-timer is-live' }, tr('form.elapsed', { time: formatDuration(elapsedMs, tr) })),
          )
        : null;

      let resultArea;
      if (running) {
        resultArea = runningCard;
      } else if (failure !== null) {
        resultArea = h(FailureCard, { t: tr, failure, onRetry: startResearch, retryDisabled });
      } else if (result !== null) {
        resultArea = h(ResultView, { t: tr, value: result });
      } else {
        resultArea = h(EmptyState, { t: tr, onPick: pickExample });
      }

      return h(
        'div',
        { className: 'dr-root' },
        h(
          'header',
          { className: 'dr-header' },
          h(
            'div',
            { className: 'dr-header-main' },
            h(DeepResearchGlyph, { size: 20 }),
            h('h1', { className: 'dr-title' }, tr('panel.title')),
          ),
          h('span', { className: 'dr-subtitle', title: tr('panel.subtitle') }, tr('panel.subtitle')),
          h('div', { className: 'dr-spacer', 'aria-hidden': true }),
          h(
            'button',
            {
              type: 'button',
              className: 'dr-ghost',
              disabled: historyLoading || running,
              onClick: () => loadHistory(),
            },
            historyLoading ? tr('panel.refreshing') : tr('panel.refresh'),
          ),
        ),
        h(
          'div',
          { className: 'dr-body' },
          h(
            'div',
            { className: 'dr-layout' },
            h(
              'main',
              { className: 'dr-main' },
              h(ResearchForm, {
                t: tr,
                form,
                running,
                elapsedMs,
                onChange: changeField,
                onSubmit: startResearch,
                textareaRef,
              }),
              resultArea,
            ),
            h(HistoryPanel, {
              t: tr,
              runs,
              loading: historyLoading,
              error: historyError,
              recordError,
              selectedId,
              loadingId: loadingRecordId,
              busy: running || loadingRecordId !== null,
              onRefresh: () => loadHistory(),
              onOpen: openRecord,
              onRetryRecord: openRecord,
            }),
          ),
        ),
      );
    }

    // ------------------------------------------------------------ 插件装配

    return {
      // 客户端**服务名**依赖（与 package.json 的 dsh.client.inject 不同，后者是包 id 排序）。
      inject: ['slots', 'locale'],

      apply(ctx) {
        ctx.effect(installStyles, 'dsh-deep-research: styles');
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-deep-research: dictionaries');
        const t = ctx.locale.bind(NS);

        // 侧边栏入口：id 必须与下面 main 的 key 相同，shell 才能把点击接到面板上。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'deep-research', order: 36, label: () => t('entry.label') },
            DeepResearchGlyph,
          ),
        );

        // 中央主面板：root 作用域的 keyed slot，按侧边栏条目 id 分发。
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'deep-research', locale: NS }, DeepResearchPanel),
        );
      },
    };
  },
});
