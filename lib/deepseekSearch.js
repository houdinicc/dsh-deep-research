/**
 * dsh-deep-research —— 账号兜底搜索（DeepSeek Search API）。
 *
 * 宿主 `ctx.web.search` 的唯一内置 provider（web-search-deepseek）在「会话路由不是
 * deepseek-account」时只认 `DEEPSEEK_API_KEY`；key 一旦失效（401），深度研究的三条
 * 查询会全军覆没（all-searches-failed）。而 dsh 已登录的账号 token 对同一端点
 * `POST {base}/messages` 实测可用——宿主 provider 只是把它门控在会话路由上了。
 *
 * 本模块在插件内直连同一端点，用 `deepseekAccount` 服务解析账号 token 发起搜索，
 * 作为宿主搜索失败后的兜底。线上协议（请求体、响应解析、去重、snippet 关联）与
 * 宿主 `dsh-web-search-deepseek` 的实现逐字段对齐：
 *  - 请求：`tools:[{type:'web_search_20250305', name:'web_search', max_uses}]`；
 *  - 响应：`content[]` 里的 `web_search_tool_result` 块 → `web_search_result` 条目，
 *    用 `text` 块的 `citations[].cited_text` 关联 snippet，按 url 去重；
 *  - 鉴权：只走 `x-dsh-auth-token`（账号），不读 DEEPSEEK_API_KEY——那是已验证
 *    失败的路径，再试一遍只会重复 401。
 *
 * 失败一律抛带 `code` 的 Error（研究流水线的 runSearch 按 `error.code`/`error.message`
 * 记录失败原因），不抛裸字符串。
 *
 * 本模块不依赖 Cordis，可单独测试。
 *
 * @module dsh-deep-research/deepseekSearch
 */

/** 账号搜索的缺省端点（与宿主 web-search-deepseek 的缺省 baseURL 一致）。 */
export const DEFAULT_SEARCH_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
export const DEFAULT_SEARCH_MODEL = 'deepseek-chat';
export const DEFAULT_SEARCH_MAX_TOKENS = 2048;
export const DEFAULT_SEARCH_MAX_USES = 5;

const ANTHROPIC_VERSION = '2023-06-01';

/** 带稳定 code 的搜索错误；研究流水线把它记进 per-query 失败原因。 */
export class SearchProviderError extends Error {
  constructor(code, message, options) {
    super(message);
    this.name = 'SearchProviderError';
    this.code = code;
    if (options !== undefined) {
      // Error cause（Node 16.9+）：保留底层异常，便于宿主日志深挖。
      this.cause = options.cause;
    }
  }
}

/**
 * 组装账号兜底搜索器。
 *
 * @param {object} [options]
 * @param {() => object | undefined} [options.getAccount] 返回宿主 `deepseekAccount`
 *   服务（`resolveToken(endpoint) → Promise<string|undefined>`）；缺省返回 undefined。
 * @param {object} [options.config] 已归一化插件配置（只用 searchBaseUrl/Model/Tokens/Uses 字段）。
 * @param {(level: 'info'|'warn', message: string, detail?: unknown) => void} [options.logger]
 * @param {typeof fetch} [options.fetchImpl] fetch 注入点，便于测试；缺省全局 fetch。
 * @returns {{ search: (query: string, maxResults: number, signal?: AbortSignal) => Promise<object> }}
 */
export function createAccountSearch({ getAccount, config, logger, fetchImpl } = {}) {
  const resolveAccount =
    typeof getAccount === 'function' ? getAccount : () => undefined;
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  const options = config !== null && typeof config === 'object' ? config : {};

  function baseURL() {
    const value = typeof options.searchBaseUrl === 'string' ? options.searchBaseUrl.trim() : '';
    return value !== '' ? value.replace(/\/+$/, '') : DEFAULT_SEARCH_BASE_URL;
  }

  return {
    /**
     * 执行一次账号搜索。取消安全：信号已取消立即抛 AbortError；传输层错误包进
     * SearchProviderError 并保留底层 cause。
     *
     * @param {string} query 检索词。
     * @param {number} maxResults 结果上限（仅本地截断）。
     * @param {AbortSignal} [signal]
     * @returns {Promise<{ sources: Array<object>, truncated: boolean }>}
     */
    async search(query, maxResults, signal) {
      if (signal?.aborted) throw abortError(signal);
      const endpoint = `${baseURL()}/messages`;
      const account = resolveAccount();
      if (!account || typeof account.resolveToken !== 'function') {
        throw new SearchProviderError(
          'WEB_PROVIDER_CREDENTIAL_MISSING',
          '账号兜底搜索不可用：宿主没有 deepseekAccount 服务（未登录 DeepSeek 账号）',
        );
      }

      let token;
      try {
        token = await account.resolveToken(endpoint);
      } catch (error) {
        throw new SearchProviderError(
          'WEB_PROVIDER_ERROR',
          `账号兜底搜索：解析账号 token 失败：${messageOf(error)}`,
          { cause: error },
        );
      }
      if (typeof token !== 'string' || token.length === 0) {
        throw new SearchProviderError(
          'WEB_PROVIDER_CREDENTIAL_MISSING',
          '账号兜底搜索：deepseekAccount 未返回 token（可能未登录）',
        );
      }

      const body = {
        model: typeof options.searchModel === 'string' && options.searchModel.trim() !== ''
          ? options.searchModel.trim()
          : DEFAULT_SEARCH_MODEL,
        max_tokens:
          Number.isFinite(options.searchMaxTokens) && options.searchMaxTokens >= 1
            ? Math.trunc(options.searchMaxTokens)
            : DEFAULT_SEARCH_MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }],
          },
        ],
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses:
              Number.isFinite(options.searchMaxUses) && options.searchMaxUses >= 1
                ? Math.trunc(options.searchMaxUses)
                : DEFAULT_SEARCH_MAX_USES,
          },
        ],
        thinking: { type: 'disabled' },
      };

      let response;
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': ANTHROPIC_VERSION,
            'x-dsh-auth-token': token,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal?.aborted || isAbort(error)) throw abortError(signal);
        throw new SearchProviderError(
          'WEB_PROVIDER_ERROR',
          `账号兜底搜索：请求 ${endpoint} 失败：${messageOf(error)}`,
          { cause: error },
        );
      }

      const text = await response.text().catch(() => '');
      if (!response.ok) {
        throw new SearchProviderError(
          'WEB_PROVIDER_ERROR',
          `账号兜底搜索：端点返回 HTTP ${response.status}${text !== '' ? `：${clip(text, 300)}` : ''}`,
        );
      }

      let payload;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new SearchProviderError(
          'WEB_PROVIDER_ERROR',
          `账号兜底搜索：响应不是合法 JSON：${clip(text, 120)}`,
          { cause: error },
        );
      }

      const mapped = mapResponse(payload);
      const limit = Number.isFinite(maxResults) && maxResults >= 1 ? Math.trunc(maxResults) : 0;
      const sources = limit > 0 ? mapped.sources.slice(0, limit) : mapped.sources;
      if (mapped.sources.length > sources.length) {
        logger?.('info', `账号兜底搜索：结果按上限截断（${mapped.sources.length}→${sources.length}）`);
      }
      return { sources, truncated: false };
    },
  };
}

/**
 * 把 Anthropic Messages 响应映射成规范化搜索结果（与宿主 mapAnthropicResponse 对齐）。
 *
 * @param {object} response 已解析的响应体。
 * @returns {{ sources: Array<{url: string, title?: string, snippet?: string, publishedAt?: string}>, truncated: boolean }}
 * @throws {SearchProviderError} 没有任何 web_search_tool_result 块时。
 */
export function mapResponse(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result');
  if (resultBlocks.length === 0) {
    // 端点 200 但没跑原生搜索：带响应体摘录（可能是 error 信封、纯文本回答、
    // 或 stop_reason 里的拒绝原因），排障不用再抓包。
    const excerpt =
      response?.error !== undefined
        ? `error=${clip(JSON.stringify(response.error), 240)}`
        : `content_types=[${blocks.map((block) => block?.type).join(',')}] stop_reason=${JSON.stringify(response?.stop_reason ?? null)} body=${clip(JSON.stringify(response), 240)}`;
    throw new SearchProviderError(
      'WEB_PROVIDER_ERROR',
      `账号兜底搜索：响应没有 web_search_tool_result 块（请求可能没有触发原生搜索）：${excerpt}`,
    );
  }
  const snippets = citationSnippets(blocks);
  const seen = new Set();
  const sources = [];
  for (const block of resultBlocks) {
    const items = Array.isArray(block?.content) ? block.content : [];
    for (const item of items) {
      if (item?.type !== 'web_search_result') continue;
      const url = typeof item.url === 'string' ? item.url : '';
      if (url === '' || seen.has(url)) continue;
      seen.add(url);
      const source = { url };
      if (typeof item.title === 'string' && item.title !== '') source.title = item.title;
      const snippet = snippets.get(url);
      if (snippet !== undefined) source.snippet = snippet;
      if (typeof item.page_age === 'string' && item.page_age !== '') source.publishedAt = item.page_age;
      sources.push(source);
    }
  }
  return { sources, truncated: false };
}

/** `text` 块的 citations（url → cited_text 首见优先），与宿主 citationSnippets 对齐。 */
function citationSnippets(blocks) {
  const map = new Map();
  for (const block of blocks) {
    if (block?.type !== 'text') continue;
    const cites = Array.isArray(block?.citations) ? block.citations : [];
    for (const cite of cites) {
      const url = typeof cite?.url === 'string' ? cite.url : '';
      const cited = typeof cite?.cited_text === 'string' ? cite.cited_text : '';
      if (url !== '' && cited !== '' && !map.has(url)) map.set(url, cited);
    }
    }
  return map;
}

/** 取消错误：宿主/流水线按 `name === 'AbortError'` 识别。 */
function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isAbort(error) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function messageOf(error) {
  const text = typeof error?.message === 'string' ? error.message : String(error ?? '未知错误');
  return clip(text, 200);
}

function clip(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
