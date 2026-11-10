import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccountSearch, mapResponse } from '../lib/deepseekSearch.js';
import { createWebAdapter } from '../lib/webAdapter.js';

// ---------------------------------------------------------------- 测试基建

/** 带调用记录的账号服务 mock。 */
function fakeAccount(token) {
  const calls = [];
  return {
    calls,
    async resolveToken(endpoint) {
      calls.push(endpoint);
      return token;
    },
  };
}

/** 构造 Anthropic Messages 风格搜索响应 JSON 文本。 */
function searchBody(urls, withCitations) {
  const content = [];
  if (withCitations) {
    content.push({
      type: 'text',
      text: 'found',
      citations: urls.map((url, index) => ({ url, cited_text: `excerpt ${index} of ${url}` })),
    });
  }
  content.push({
    type: 'web_search_tool_result',
    tool_use_id: 'call_x',
    content: urls.map((url) => ({
      type: 'web_search_result',
      url,
      title: `Title ${url}`,
      page_age: '2026-11-01',
    })),
  });
  return JSON.stringify({ content });
}

/** 恒定响应的 fetch mock。 */
function fetchRespond(body, status) {
  return async () => ({
    ok: (status ?? 200) >= 200 && (status ?? 200) < 300,
    status: status ?? 200,
    text: async () => body,
  });
}

// ------------------------------------------------------------ deepseekSearch

test('账号搜索：请求带 x-dsh-auth-token 并解析来源', async () => {
  let seen;
  const doFetch = async (url, init) => {
    seen = { url, init };
    return {
      ok: true,
      status: 200,
      text: async () => searchBody(['https://a/1', 'https://a/2'], true),
    };
  };
  const account = fakeAccount('tok-abc');
  const search = createAccountSearch({ getAccount: () => account, config: {}, fetchImpl: doFetch });
  const result = await search.search('向量数据库', 10);
  assert.equal(seen.url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['x-dsh-auth-token'], 'tok-abc');
  assert.deepEqual(account.calls, ['https://api.deepseek.com/anthropic/v1/messages']);
  assert.deepEqual(result.sources.map((source) => source.url), ['https://a/1', 'https://a/2']);
  assert.equal(result.sources[0].snippet, 'excerpt 0 of https://a/1');
  assert.equal(result.truncated, false);
});

test('账号搜索：maxResults 本地截断', async () => {
  const search = createAccountSearch({
    getAccount: () => fakeAccount('t'),
    config: {},
    fetchImpl: fetchRespond(searchBody(['https://a/1', 'https://a/2', 'https://a/3'], false)),
  });
  const result = await search.search('q', 2);
  assert.equal(result.sources.length, 2);
});

test('账号搜索：无账号服务 → WEB_PROVIDER_CREDENTIAL_MISSING', async () => {
  const search = createAccountSearch({ getAccount: () => undefined, fetchImpl: fetchRespond('{}') });
  await assert.rejects(() => search.search('q', 5), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING');
    return true;
  });
});

test('账号搜索：resolveToken 抛错 → WEB_PROVIDER_ERROR 且带 cause', async () => {
  const boom = new Error('credential store locked');
  const search = createAccountSearch({
    getAccount: () => ({
      async resolveToken() {
        throw boom;
      },
    }),
    fetchImpl: fetchRespond('{}'),
  });
  await assert.rejects(() => search.search('q', 5), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR');
    assert.equal(error.cause, boom);
    return true;
  });
});

test('账号搜索：token 为空 → WEB_PROVIDER_CREDENTIAL_MISSING', async () => {
  const search = createAccountSearch({
    getAccount: () => fakeAccount(''),
    fetchImpl: fetchRespond('{}'),
  });
  await assert.rejects(() => search.search('q', 5), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING');
    return true;
  });
});

test('账号搜索：HTTP 401 → WEB_PROVIDER_ERROR 且带状态与响应摘录', async () => {
  const search = createAccountSearch({
    getAccount: () => fakeAccount('t'),
    config: {},
    fetchImpl: fetchRespond('{"error":"Authentication Fails (governor)"}', 401),
  });
  await assert.rejects(() => search.search('q', 5), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR');
    assert.match(error.message, /HTTP 401/);
    assert.match(error.message, /governor/);
    return true;
  });
});

test('账号搜索：传输层异常 → WEB_PROVIDER_ERROR 且保留 cause', async () => {
  const boom = new Error('ECONNREFUSED');
  const search = createAccountSearch({
    getAccount: () => fakeAccount('t'),
    config: {},
    fetchImpl: async () => {
      throw boom;
    },
  });
  await assert.rejects(() => search.search('q', 5), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR');
    assert.equal(error.cause, boom);
    return true;
  });
});

test('账号搜索：响应非 JSON → WEB_PROVIDER_ERROR', async () => {
  const search = createAccountSearch({
    getAccount: () => fakeAccount('t'),
    config: {},
    fetchImpl: fetchRespond('<html>not json</html>'),
  });
  await assert.rejects(() => search.search('q', 5), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR');
    assert.match(error.message, /JSON/);
    return true;
  });
});

test('账号搜索：已取消 signal 立即抛 AbortError 且不发请求', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const search = createAccountSearch({
    getAccount: () => fakeAccount('t'),
    config: {},
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, text: async () => '{}' };
    },
  });
  await assert.rejects(() => search.search('q', 5, controller.signal), (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
  assert.equal(called, false);
});

test('mapResponse：无结果块 → WEB_PROVIDER_ERROR', () => {
  assert.throws(
    () => mapResponse({ content: [{ type: 'text', text: 'no search' }] }),
    (error) => error.code === 'WEB_PROVIDER_ERROR',
  );
});

test('mapResponse：按 url 去重', () => {
  const { sources, truncated } = mapResponse(JSON.parse(searchBody(['https://a/1', 'https://a/1'], false)));
  assert.equal(truncated, false);
  assert.deepEqual(sources.map((source) => source.url), ['https://a/1']);
});

test('mapResponse：citations 关联 snippet；page_age 映射 publishedAt', () => {
  const { sources } = mapResponse(JSON.parse(searchBody(['https://a/1'], true)));
  assert.equal(sources[0].snippet, 'excerpt 0 of https://a/1');
  assert.equal(sources[0].publishedAt, '2026-11-01');
});

// --------------------------------------------------------------- webAdapter

test('适配器：宿主正常 → 直接用宿主结果，不触发兜底', async () => {
  const seen = [];
  const host = {
    search: async (request, signal) => {
      seen.push({ kind: 'search', request });
      return { sources: [{ url: 'https://host/1' }], truncated: false };
    },
    fetch: async (request) => {
      seen.push({ kind: 'fetch', request });
      return { url: request.url, statusCode: 200 };
    },
  };
  const adapter = createWebAdapter({
    getWeb: () => host,
    getAccount: () => fakeAccount('t'),
    config: {},
    logger: () => {},
  });
  // 宿主契约（tools.js 侧）：对象首参。
  const result = await adapter.search({ query: '向量数据库', maxResults: 5 }, undefined);
  assert.deepEqual(result.sources.map((source) => source.url), ['https://host/1']);
  // 位置参数约定（插件内部/测试）。
  const result2 = await adapter.search('q', 5);
  assert.ok(result2.sources.length >= 1);
  const fetched = await adapter.fetch({ url: 'https://host/1' });
  assert.equal(fetched.statusCode, 200);
  const fetched2 = await adapter.fetch('https://host/1');
  assert.equal(fetched2.statusCode, 200);
  const searchReqs = seen.filter((item) => item.kind === 'search');
  assert.deepEqual(searchReqs[0].request, { query: '向量数据库', maxResults: 5 });
  assert.deepEqual(searchReqs[1].request, { query: 'q', maxResults: 5 });
  const fetchReq = seen.find((item) => item.kind === 'fetch');
  assert.deepEqual(fetchReq.request, { url: 'https://host/1' });
});

test('适配器：空 url 的 fetch 请求明确报错（防 [object Object] 回归）', async () => {
  const host = { search: async () => ({}), fetch: async () => ({}) };
  const adapter = createWebAdapter({ getWeb: () => host, config: {} });
  await assert.rejects(() => adapter.fetch({}), /缺少 url/);
  await assert.rejects(() => adapter.fetch({ url: {} }), /缺少 url/);
});

test('适配器：宿主失败 → 落账号兜底，成功返回且 warn 日志可观测', async () => {
  const host = {
    search: async () => {
      throw new Error('401 invalid key');
    },
    fetch: async () => ({}),
  };
  const logged = [];
  const adapter = createWebAdapter({
    getWeb: () => host,
    getAccount: () => fakeAccount('tok-x'),
    config: {},
    logger: (level, message) => logged.push(`${level}: ${message}`),
    fetchImpl: fetchRespond(searchBody(['https://fallback/1', 'https://fallback/2'], false)),
  });
  const result = await adapter.search('向量', 5);
  assert.deepEqual(result.sources.map((source) => source.url), ['https://fallback/1', 'https://fallback/2']);
  assert.ok(logged.some((line) => line.includes('改用账号兜底')));
});

test('适配器：searchFallback=false → 宿主失败原样抛出', async () => {
  const hostError = new Error('401 invalid key');
  const host = {
    search: async () => {
      throw hostError;
    },
    fetch: async () => ({}),
  };
  const adapter = createWebAdapter({
    getWeb: () => host,
    getAccount: () => fakeAccount('t'),
    config: { searchFallback: false },
    logger: () => {},
  });
  await assert.rejects(
    () => adapter.search('q', 5),
    (error) => error === hostError,
  );
});

test('适配器：searchFallback=false 且宿主缺失 → 明确报错', async () => {
  const adapter = createWebAdapter({
    getWeb: () => undefined,
    config: { searchFallback: false },
  });
  await assert.rejects(() => adapter.search('q', 5), /没有可用的 ctx\.web 服务/);
});

test('适配器：宿主缺失但有账号 → 兜底成功', async () => {
  const adapter = createWebAdapter({
    getWeb: () => undefined,
    getAccount: () => fakeAccount('t'),
    config: {},
    fetchImpl: fetchRespond(searchBody(['https://fallback/1'], false)),
  });
  const result = await adapter.search('q', 5);
  assert.ok(Array.isArray(result.sources));
});

test('适配器：宿主缺失且无账号 → 兜底凭证错误浮出', async () => {
  const adapter = createWebAdapter({
    getWeb: () => undefined,
    getAccount: () => undefined,
    config: {},
  });
  await assert.rejects(() => adapter.search('q', 5), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING');
    return true;
  });
});

test('适配器：宿主 abort 直接透传（不落兜底）', async () => {
  const abort = new DOMException('aborted', 'AbortError');
  const host = {
    search: async () => {
      throw abort;
    },
    fetch: async () => ({}),
  };
  const adapter = createWebAdapter({
    getWeb: () => host,
    getAccount: () => fakeAccount('t'),
    config: {},
    logger: () => {},
  });
  await assert.rejects(
    () => adapter.search('q', 5),
    (error) => error === abort,
  );
});
