import assert from 'node:assert/strict';
import test from 'node:test';

import { createTools, resolveConfig } from '../lib/tools.js';

/**
 * 一个最小的 fake `ctx.web`：只实现工具层会用到的 search / fetch。
 * 不联网、不依赖研究流水线内部实现。
 */
function createFakeWeb(options = {}) {
  const calls = [];
  const sources = options.sources ?? [
    {
      url: 'https://example.com/a',
      title: 'Example A',
      snippet: 'Deep research evidence about the topic.',
      publishedAt: '2026-10-01',
    },
  ];
  let searchError = options.searchError;
  return {
    calls,
    async search(request, signal) {
      calls.push({ kind: 'search', ...request });
      if (signal?.aborted) {
        const error = new Error('aborted by caller');
        error.name = 'AbortError';
        throw error;
      }
      if (searchError) throw searchError;
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
          content: '# Page\n\nThis paragraph contains enough material about the research topic and its evidence.',
        },
        truncated: false,
      };
    },
  };
}

const QUICK_CONFIG = {
  defaultDepth: 'quick',
  maxQueries: 2,
  maxSources: 3,
  fetchTop: 0,
  fetchCharBudget: 0,
};

function firstTool(options) {
  const tools = createTools(options);
  assert.equal(tools.length, 1);
  return tools[0];
}

test('resolveConfig：缺省值、非法值回落、数值夹取', () => {
  const defaults = resolveConfig(undefined);
  assert.equal(defaults.enableTools, true);
  assert.equal(defaults.defaultDepth, 'standard');
  assert.equal(defaults.maxQueries, 5);
  assert.equal(defaults.maxSources, 12);
  assert.equal(defaults.fetchTop, 4);
  assert.equal(defaults.toolTimeoutMs, 120000);

  const clamped = resolveConfig({
    defaultDepth: 'ultra',
    maxQueries: 99,
    maxSources: -3,
    fetchTop: 100,
    fetchCharBudget: 99999999,
    searchTimeoutMs: 1,
    enableTools: false,
  });
  assert.equal(clamped.defaultDepth, 'standard');
  assert.equal(clamped.maxQueries, 10);
  assert.equal(clamped.maxSources, 1);
  assert.equal(clamped.fetchTop, 8);
  assert.equal(clamped.fetchCharBudget, 200000);
  assert.equal(clamped.searchTimeoutMs, 1000);
  assert.equal(clamped.enableTools, false);

  assert.equal(resolveConfig({ defaultDepth: 'deep' }).defaultDepth, 'deep');
});

test('createTools：工具名、schema、output 与超时契约', () => {
  const tool = firstTool({ config: { ...QUICK_CONFIG, toolTimeoutMs: 90000 } });
  assert.equal(tool.name, 'deep_research');
  assert.equal(typeof tool.description, 'string');
  assert.ok(tool.description.length > 40);
  assert.equal(tool.timeoutMs, 90000);
  assert.equal(tool.isConcurrencySafe(), true);

  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['question']);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.question.type, 'string');
  assert.deepEqual(tool.parameters.properties.depth.enum, ['quick', 'standard', 'deep']);

  assert.equal(tool.output.schema.type, 'object');
  assert.equal(tool.output.schema.properties.ok.type, 'boolean');
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(typeof tool.execute, 'function');
});

test('execute：成功路径返回结构化结果并渲染证据报告', async () => {
  const web = createFakeWeb();
  const tool = firstTool({ config: QUICK_CONFIG, web: () => web });

  const value = await tool.execute({ question: '深度研究插件怎么做？' }, { signal: new AbortController().signal });

  assert.equal(value.ok, true);
  assert.equal(value.question, '深度研究插件怎么做？');
  assert.equal(typeof value.generatedAt, 'string');
  assert.equal(value.depth, 'quick');
  assert.ok(Array.isArray(value.queries));
  assert.ok(Array.isArray(value.sources));
  assert.ok(Array.isArray(value.evidence));
  assert.ok(Array.isArray(value.coverage));
  assert.ok(Array.isArray(value.gaps));
  assert.ok(Array.isArray(value.warnings));
  assert.equal(typeof value.stats, 'object');
  assert.equal(typeof value.reportMarkdown, 'string');
  assert.ok(value.reportMarkdown.length > 0);
  assert.ok(value.sources.length >= 1);
  assert.ok(value.sources.length <= QUICK_CONFIG.maxSources);

  // 只走 search，不抓正文（fetchTop=0）。
  assert.ok(web.calls.every((call) => call.kind === 'search'));

  const rendered = tool.output.render({ question: 'x' }, value);
  assert.ok(Array.isArray(rendered));
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /深度研究完成/);
  assert.match(rendered[0].text, /untrusted/);
});

test('execute：空问题与缺省 question 都返回 invalid-input', async () => {
  const web = createFakeWeb();
  const tool = firstTool({ config: QUICK_CONFIG, web: () => web });

  for (const args of [{}, { question: '   ' }, { question: 42 }]) {
    const value = await tool.execute(args, { signal: new AbortController().signal });
    assert.equal(value.ok, false);
    assert.equal(value.code, 'invalid-input');
    assert.equal(typeof value.message, 'string');
  }
  assert.equal(web.calls.length, 0);
});

test('execute：ctx.web 缺失返回 web-unavailable 信封', async () => {
  const tool = firstTool({ config: QUICK_CONFIG, web: () => undefined });
  const value = await tool.execute({ question: 'test' }, { signal: new AbortController().signal });
  assert.equal(value.ok, false);
  assert.equal(value.code, 'web-unavailable');

  const noFetchWeb = { search: async () => ({ sources: [], truncated: false }) };
  const toolWithoutFetch = firstTool({ config: QUICK_CONFIG, web: () => noFetchWeb });
  const missingFetch = await toolWithoutFetch.execute({ question: 'test' }, {});
  assert.equal(missingFetch.ok, false);
  assert.equal(missingFetch.code, 'web-unavailable');
});

test('execute：已取消的 signal 返回 aborted 信封', async () => {
  const web = createFakeWeb();
  const tool = firstTool({ config: QUICK_CONFIG, web: () => web });
  const controller = new AbortController();
  controller.abort();

  const value = await tool.execute({ question: '会被取消的研究' }, { signal: controller.signal });
  assert.equal(value.ok, false);
  assert.equal(value.code, 'aborted');
});

test('execute：模型传入的上限不会突破插件配置上限', async () => {
  const web = createFakeWeb({
    sources: Array.from({ length: 40 }, (_, index) => ({
      url: `https://example.com/item-${index}`,
      title: `Item ${index}`,
      snippet: `snippet ${index}`,
    })),
  });
  const tool = firstTool({ config: { ...QUICK_CONFIG, maxSources: 3, maxQueries: 1 }, web: () => web });

  const value = await tool.execute(
    { question: '上限测试', max_sources: 30, fetch_top: 8, depth: 'quick' },
    { signal: new AbortController().signal },
  );
  assert.equal(value.ok, true);
  assert.ok(value.sources.length <= 3);
  assert.ok(web.calls.every((call) => call.kind === 'search'));
});

test('render：失败信封渲染为可读错误文本', () => {
  const tool = firstTool({ config: QUICK_CONFIG });
  const rendered = tool.output.render({}, { ok: false, code: 'no-results', message: '没有检索到来源' });
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /no-results/);
  assert.match(rendered[0].text, /没有检索到来源/);
});
