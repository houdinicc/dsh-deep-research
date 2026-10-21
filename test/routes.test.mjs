import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRoutes, isLoopbackRequest } from '../lib/routes.js';
import { createStore } from '../lib/store.js';

const RUNS_PATH = '/api/dsh-deep-research/runs';
const RUN_PATH = '/api/dsh-deep-research/run';

const QUICK_CONFIG = {
  defaultDepth: 'quick',
  maxQueries: 1,
  maxSources: 2,
  fetchTop: 0,
  fetchCharBudget: 0,
  searchTimeoutMs: 5000,
  fetchTimeoutMs: 5000,
};

/** 最小 fake ctx.web：只实现研究流水线会用到的 search / fetch，不联网。 */
function createFakeWeb(options = {}) {
  const calls = [];
  const sources = options.sources ?? [
    {
      url: 'https://example.com/a',
      title: 'Deep research evidence A',
      snippet: 'A paragraph about deep research evidence and its test coverage.',
      publishedAt: '2026-10-01',
    },
    {
      url: 'https://example.com/b',
      title: 'Deep research evidence B',
      snippet: 'Another paragraph about deep research evidence for the test.',
      publishedAt: '2026-10-02',
    },
  ];
  return {
    calls,
    async search(request, signal) {
      calls.push({ kind: 'search', ...request });
      if (signal?.aborted) {
        const error = new Error('aborted by caller');
        error.name = 'AbortError';
        throw error;
      }
      return { sources: sources.map((source) => ({ ...source })), truncated: false };
    },
    async fetch(request, signal) {
      calls.push({ kind: 'fetch', ...request });
      if (signal?.aborted) {
        const error = new Error('aborted by caller');
        error.name = 'AbortError';
        throw error;
      }
      return {
        url: request.url,
        statusCode: 200,
        body: {
          kind: 'text',
          content: 'Deep research evidence test page. This paragraph has enough material about deep research evidence.',
        },
        truncated: false,
      };
    },
  };
}

/** 每个用例独立的临时数据目录，绝不碰真实 ~/.dsh。 */
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-deep-research-routes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore({ dir, maxRuns: options.maxRuns ?? 20 });
  const web = options.web ?? (() => createFakeWeb());
  const routes = createRoutes({
    config: { ...QUICK_CONFIG, ...(options.config ?? {}) },
    store,
    web,
    now: options.now ?? (() => new Date('2026-10-21T12:00:00.000Z')),
  });
  return { dir, store, web, routes };
}

function makeReq({ method = 'GET', url = RUNS_PATH, headers = {}, remoteAddress = '127.0.0.1', body } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:52801', ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined && body !== null) yield Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    },
  };
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      res.headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return res.headers[String(name).toLowerCase()];
    },
    end(chunk) {
      if (chunk !== undefined) res.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    },
  };
  return res;
}

function routeFor(routes, routePath) {
  const route = routes.find((item) => item.path === routePath);
  assert.ok(route, `缺少路由 ${routePath}`);
  return route;
}

/** 直接调用 handler，不启动 HTTP server。 */
async function invoke(routes, routePath, req) {
  const res = makeRes();
  await routeFor(routes, routePath).handler(req, res);
  return { status: res.statusCode, headers: res.headers, json: JSON.parse(res.body), res };
}

// ---------------------------------------------------------------------------

test('WebRoute 形状：只注册 exact 绝对路径，/(kind,path) 不重复', () => {
  const routes = createRoutes({ config: QUICK_CONFIG, store: createStore({ dir: path.join(os.tmpdir(), 'x') }) });

  assert.equal(routes.length, 2);
  assert.deepEqual(
    routes.map((route) => route.path).sort(),
    [RUN_PATH, RUNS_PATH].sort(),
  );
  for (const route of routes) {
    assert.equal(route.kind, 'exact');
    assert.equal(route.path.startsWith('/api/dsh-deep-research/'), true);
    assert.equal(typeof route.handler, 'function');
  }
  const keys = new Set(routes.map((route) => `${route.kind}\u0000${route.path}`));
  assert.equal(keys.size, routes.length);
});

test('isLoopbackRequest：回环来源 + 回环 Host + 非 cross-site 才放行', () => {
  assert.equal(isLoopbackRequest(makeReq()), true);
  assert.equal(isLoopbackRequest(makeReq({ remoteAddress: '::1' })), true);
  assert.equal(isLoopbackRequest(makeReq({ remoteAddress: '::ffff:127.0.0.1' })), true);
  assert.equal(isLoopbackRequest(makeReq({ remoteAddress: '10.0.0.5' })), false);
  assert.equal(isLoopbackRequest(makeReq({ headers: { host: 'evil.example.com' } })), false);
  assert.equal(isLoopbackRequest(makeReq({ headers: { host: '' } })), false);
  assert.equal(isLoopbackRequest(makeReq({ headers: { 'sec-fetch-site': 'cross-site' } })), false);
});

test('回环围栏：非回环请求一律 403，不触发任何研究', async (t) => {
  const web = createFakeWeb();
  const { routes } = setup(t, { web: () => web });

  for (const req of [
    makeReq({ remoteAddress: '192.168.1.20' }),
    makeReq({ remoteAddress: '127.0.0.1', headers: { host: 'example.com' } }),
    makeReq({ remoteAddress: '::1', headers: { 'sec-fetch-site': 'cross-site' } }),
  ]) {
    const { status, json } = await invoke(routes, RUNS_PATH, req);
    assert.equal(status, 403);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'forbidden');
  }
  assert.equal(web.calls.length, 0);
});

test('GET /runs：空库返回 { ok:true, value:{ runs: [] } } 与 JSON 头', async (t) => {
  const { routes } = setup(t);

  const { status, headers, json } = await invoke(routes, RUNS_PATH, makeReq());

  assert.equal(status, 200);
  assert.match(headers['content-type'], /^application\/json/);
  assert.equal(headers['cache-control'], 'no-store');
  assert.deepEqual(json, { ok: true, value: { runs: [] } });
});

test('GET /runs?id=<未知>：404 not-found', async (t) => {
  const { routes } = setup(t);

  const { status, json } = await invoke(
    routes,
    RUNS_PATH,
    makeReq({ url: `${RUNS_PATH}?id=r-nope-000000` }),
  );

  assert.equal(status, 404);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'not-found');
  assert.equal(typeof json.error.message, 'string');
});

test('POST /run：成功研究 → 200 {ok:true}，落库并可从历史取回完整记录', async (t) => {
  const web = createFakeWeb();
  const { routes, store } = setup(t, { web: () => web });

  const body = JSON.stringify({
    question: 'deep research evidence test',
    depth: 'quick',
    max_sources: 2,
    fetch_top: 0,
  });
  const post = await invoke(routes, RUN_PATH, makeReq({ method: 'POST', url: RUN_PATH, body }));

  assert.equal(post.status, 200);
  assert.equal(post.json.ok, true);
  const result = post.json.value;
  assert.equal(result.ok, true);
  assert.equal(result.question, 'deep research evidence test');
  assert.equal(result.depth, 'quick');
  assert.ok(result.sources.length >= 1 && result.sources.length <= 2);
  assert.equal(typeof result.reportMarkdown, 'string');
  assert.ok(result.reportMarkdown.length > 0);
  assert.ok(web.calls.length >= 1);
  assert.ok(web.calls.every((call) => call.kind === 'search'));

  // 只存成功结果，且摘要字段从结果派生。
  const summaries = store.list();
  assert.equal(summaries.length, 1);
  const [summary] = summaries;
  assert.equal(summary.question, 'deep research evidence test');
  assert.equal(summary.depth, 'quick');
  assert.equal(summary.sourceCount, result.sources.length);
  assert.equal(summary.evidenceCount, result.evidence.length);
  assert.equal(summary.elapsedMs, result.stats.elapsedMs);

  // GET /runs 列表命中该记录。
  const list = await invoke(routes, RUNS_PATH, makeReq());
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.value.runs, summaries);

  // GET /runs?id= 取回完整记录。
  const detail = await invoke(
    routes,
    RUNS_PATH,
    makeReq({ url: `${RUNS_PATH}?id=${encodeURIComponent(summary.id)}` }),
  );
  assert.equal(detail.status, 200);
  assert.equal(detail.json.ok, true);
  assert.equal(detail.json.value.id, summary.id);
  assert.equal(detail.json.value.reportMarkdown, result.reportMarkdown);
  assert.deepEqual(detail.json.value.sources, result.sources);
});

test('POST /run：研究失败（web 不可用）仍 200 且不落库', async (t) => {
  const { routes, store } = setup(t, { web: () => undefined });

  const { status, json } = await invoke(
    routes,
    RUN_PATH,
    makeReq({ method: 'POST', url: RUN_PATH, body: JSON.stringify({ question: 'test question' }) }),
  );

  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.value.ok, false);
  assert.equal(json.value.code, 'web-unavailable');
  assert.equal(typeof json.value.message, 'string');
  assert.deepEqual(store.list(), []);
});

test('POST /run：参数非法（空问题）仍 200 失败信封，且不落库', async (t) => {
  const web = createFakeWeb();
  const { routes, store } = setup(t, { web: () => web });

  for (const payload of [{ question: '   ' }, {}]) {
    const { status, json } = await invoke(
      routes,
      RUN_PATH,
      makeReq({ method: 'POST', url: RUN_PATH, body: JSON.stringify(payload) }),
    );
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.value.ok, false);
    assert.equal(json.value.code, 'invalid-input');
  }
  assert.equal(store.list().length, 0);
  assert.equal(web.calls.length, 0);
});

test('POST /run：非法 body / 超限 body → 400 invalid-body，不落库', async (t) => {
  const { routes, store } = setup(t);

  const bodies = [
    '', // 空 body
    '{ 不是 JSON', // 非法 JSON
    '[]', // 不是对象
    'null',
    '"字符串"',
    JSON.stringify({ question: 'x'.repeat(17 * 1024) }), // > 16 KiB
  ];

  for (const body of bodies) {
    const { status, json } = await invoke(routes, RUN_PATH, makeReq({ method: 'POST', url: RUN_PATH, body }));
    assert.equal(status, 400, `body=${body.slice(0, 20)}`);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'invalid-body');
  }
  assert.deepEqual(store.list(), []);
});

test('未知方法/未知路径：统一 404 not-found', async (t) => {
  const { routes } = setup(t);

  const wrongMethodOnRuns = await invoke(routes, RUNS_PATH, makeReq({ method: 'POST', url: RUNS_PATH }));
  assert.equal(wrongMethodOnRuns.status, 404);
  assert.equal(wrongMethodOnRuns.json.error.code, 'not-found');

  const wrongMethodOnRun = await invoke(routes, RUN_PATH, makeReq({ method: 'GET', url: RUN_PATH }));
  assert.equal(wrongMethodOnRun.status, 404);
  assert.equal(wrongMethodOnRun.json.error.code, 'not-found');
});

test('store.save 失败时 POST /run 归一为 500 internal（资源错误不静默）', async (t) => {
  const { routes } = setup(t);
  // 用一个 save 必炸的 store 替换：验证异常被统一成 internal 信封。
  const brokenStore = {
    list: () => [],
    get: () => null,
    save: () => {
      throw new Error('disk full');
    },
  };
  const brokenRoutes = createRoutes({
    config: QUICK_CONFIG,
    store: brokenStore,
    web: () => createFakeWeb(),
    now: () => new Date('2026-10-21T12:00:00.000Z'),
  });

  const { status, json } = await invoke(
    brokenRoutes,
    RUN_PATH,
    makeReq({ method: 'POST', url: RUN_PATH, body: JSON.stringify({ question: 'test question' }) }),
  );
  assert.equal(status, 500);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'internal');
  assert.match(json.error.message, /disk full/);
});
