import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../lib/index.js';

// ------------------------------------------------------------- cordis ctx mock

/**
 * 最小 cordis ctx mock：inject 立即执行回调；effect 立即执行并回收 disposer。
 * 语义对齐 dsh 宿主（同步 effect、get 沿作用域解析）。
 */
function createMockScope({ web, account }) {
  const disposers = [];
  const registered = [];
  return {
    disposers,
    registered,
    services: { web, deepseekAccount: account },
    logger: {
      info() {},
      warn() {},
    },
    get(name) {
      return this.services[name];
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => dispose?.();
    },
    inject(names, callback) {
      callback(this);
    },
  };
}

function createMockCtx({ web, account }) {
  const scopes = [];
  const toolsRegistered = [];
  const routesRegistered = [];
  const ctx = {
    scopes,
    logger: { info() {}, warn() {} },
    inject(names, callback) {
      const scope = createMockScope({ web, account });
      if (names.includes('tools')) {
        scope.tools = {
          register(definition) {
            toolsRegistered.push(definition);
            return () => {};
          },
        };
      } else if (names.includes('webServer')) {
        scope.webServer = {
          register(route) {
            routesRegistered.push(route);
            return () => {};
          },
        };
      }
      scopes.push({ names, scope });
      callback(scope);
    },
  };
  ctx.toolsRegistered = toolsRegistered;
  ctx.routesRegistered = routesRegistered;
  return ctx;
}

// ------------------------------------------------------------------- 测试

test('apply 接线：web 契约是「返回服务的函数」，路由与工具共用', async () => {
  const hostWeb = {
    search: async () => ({ sources: [{ url: 'https://host/1' }], truncated: false }),
    fetch: async () => ({}),
  };
  const ctx = createMockCtx({ web: hostWeb, account: undefined });
  apply(ctx, {});
  assert.equal(ctx.routesRegistered.length, 2, '注册 2 条 Web 路由');
  assert.equal(ctx.toolsRegistered.length, 1, '注册 1 个 Agent 工具');
  assert.equal(ctx.toolsRegistered[0].name, 'deep_research');
});

test('apply 全链路：宿主搜索失败时路由走账号兜底并成功', async () => {
  const failingHost = {
    search: async () => {
      throw new Error('401 invalid api key');
    },
    fetch: async () => ({}),
  };
  const account = {
    async resolveToken() {
      return 'tok-account';
    },
  };
  const fallbackBody = JSON.stringify({
    content: [
      {
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url: 'https://fallback/1', title: 'F1' }],
      },
    ],
  });
  const ctx = createMockCtx({ web: failingHost, account });
  // fetch 注入：替换全局 fetch，兜底搜索不发真网。
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => fallbackBody });
  try {
    apply(ctx, {});
    const runRoute = ctx.routesRegistered.find((route) => route.path === '/api/dsh-deep-research/run');
    assert.ok(runRoute, 'run 路由已注册');

    const chunks = [Buffer.from(JSON.stringify({ question: '兜底链路验证', depth: 'quick' }))];
    const req = {
      method: 'POST',
      url: '/api/dsh-deep-research/run',
      headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
      socket: { remoteAddress: '127.0.0.1' },
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) yield chunk;
      },
    };
    let body;
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(text) {
        body = text;
      },
    };
    await runRoute.handler(req, res);
    assert.equal(res.statusCode, 200);
    const envelope = JSON.parse(body);
    assert.equal(envelope.ok, true, 'HTTP 信封 ok');
    assert.equal(envelope.value.ok, true, '研究成功');
    assert.ok(envelope.value.sources.some((source) => source.url === 'https://fallback/1'), '来源来自账号兜底');
  } finally {
    globalThis.fetch = realFetch;
  }
});
