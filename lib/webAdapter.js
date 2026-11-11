/**
 * dsh-deep-research —— 宿主 web 缝隙适配层（宿主优先 + 账号兜底）。
 *
 * 对研究流水线和路由层来说，这里产出的对象与宿主 `ctx.web` 同形（`search`/`fetch`），
 * 但 search 多了一层容错：
 *
 *  1. 宿主可用 → 直接用宿主结果（尊重宿主 provider 配置，如自建搜索后端）；
 *  2. 宿主 search 抛错（如 DEEPSEEK_API_KEY 失效 401、无可用 provider、多 provider
 *     歧义）→ 落到账号兜底搜索（lib/deepseekSearch.js，用已登录账号 token 直连
 *     DeepSeek Search API）；
 *  3. 兜底也不可用/也失败 → 抛回宿主的原始错误——保留真实根因，不伪造成功。
 *
 * `fetch` 不做兜底：宿主的本地 HTTP 抓取器无需任何凭证，永远不会因鉴权失败。
 *
 * 本模块不依赖 Cordis，可单独测试。
 *
 * @module dsh-deep-research/webAdapter
 */

import { createAccountSearch } from './deepseekSearch.js';

/**
 * 组装适配器。
 *
 * @param {object} [options]
 * @param {() => object | undefined} [options.getWeb] 返回宿主 `ctx.web`（调用时解析）。
 * @param {() => object | undefined} [options.getAccount] 返回宿主 `deepseekAccount` 服务。
 * @param {object} [options.config] 已归一化插件配置。
 * @param {(level: 'info'|'warn', message: string, detail?: unknown) => void} [options.logger]
 * @param {typeof fetch} [options.fetchImpl] fetch 注入点（测试用），透传给兜底搜索。
 * @returns {{ search: (query: string, maxResults: number, signal?: AbortSignal) => Promise<object>,
 *             fetch: (url: string, signal?: AbortSignal) => Promise<any> }}
 */
export function createWebAdapter({ getWeb, getAccount, config, logger, fetchImpl } = {}) {
  const fallback = createAccountSearch({ getAccount, config, logger, fetchImpl });

  return {
    /**
     * 搜索。兼容两种调用约定：
     *  - 宿主契约（tools.js 侧）：`search({ query, maxResults }, signal)`；
     *  - 位置参数（本插件内部/测试）：`search(query, maxResults?, signal?)`。
     */
    async search(requestOrQuery, maxResultsOrSignal, maybeSignal) {
      const isString = typeof requestOrQuery === 'string';
      const query = isString ? requestOrQuery : String(requestOrQuery?.query ?? '');
      const maxResults = isString
        ? maxResultsOrSignal
        : Number.isFinite(requestOrQuery?.maxResults)
          ? requestOrQuery.maxResults
          : undefined;
      const signal = isString ? maybeSignal : maxResultsOrSignal;

      const host = getWeb?.();
      if (host !== null && host !== undefined && typeof host.search === 'function') {
        try {
          return await host.search({ query, maxResults }, signal);
        } catch (error) {
          if (signal?.aborted === true || error?.name === 'AbortError') throw error;
          if (config?.searchFallback === false) {
            logger?.('warn', `宿主搜索失败，兜底已被配置禁用（searchFallback=false）：${messageOf(error)}`);
            throw error;
          }
          logger?.('warn', `宿主搜索失败，改用账号兜底搜索：${messageOf(error)}`);
        }
      } else if (config?.searchFallback === false) {
        throw new Error('当前 profile 没有可用的 ctx.web 服务（或没有选中任何 search provider），且账号兜底已被禁用（searchFallback=false）。');
      }
      // 宿主缺失或失败 → 兜底（内部抛出的错误即最终失败原因）。
      return await fallback.search(query, maxResults, signal);
    },

    /**
     * 抓正文。兼容两种调用约定：
     *  - 宿主契约（tools.js 侧）：`fetch({ url }, signal)`；
     *  - 位置参数：`fetch(url, signal?)`。
     */
    async fetch(requestOrUrl, signal) {
      const url =
        typeof requestOrUrl === 'string'
          ? requestOrUrl
          : typeof requestOrUrl?.url === 'string'
            ? requestOrUrl.url
            : '';
      if (url === '') {
        throw new Error('web fetch 缺少 url：请求必须是字符串 url 或 { url: string }（防 [object Object] 误传）。');
      }
      const host = getWeb?.();
      if (host === null || host === undefined || typeof host.fetch !== 'function') {
        throw new Error('当前 profile 没有可用的 ctx.web fetch 服务。');
      }
      return await host.fetch({ url }, signal);
    },
  };
}

function messageOf(error) {
  return typeof error?.message === 'string' && error.message !== '' ? error.message : String(error ?? '未知错误');
}
