/**
 * dsh-deep-research 核心流水线离线单测（SPEC §7）。
 *
 * 全部测试注入 fake search / fetchPage，绝不联网、不读文件、不依赖宿主 ctx。
 * 运行：node --test test/research.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEPTH_PRESETS,
  MAX_EVIDENCE,
  MAX_PASSAGE_CHARS,
  MAX_PROVIDER_MESSAGE_CHARS,
  MAX_REPORT_CHARS,
  buildFollowupQueries,
  buildReport,
  extractPassages,
  htmlToText,
  mergeSearchResults,
  normalizeUrl,
  planQueries,
  resolveLimits,
  runResearch,
  selectFetchTargets,
} from '../lib/research.js';

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/**
 * 构造 fake search。
 * handlers: 查询串 → 结果对象 / 函数（返回结果对象）/ Error（执行时抛出）。
 * fallback: 未命中 handlers 时的默认行为，默认返回空结果。
 */
function makeSearch(handlers = {}, fallback = null) {
  const calls = [];
  const search = async (query, maxResults, signal) => {
    calls.push({ query, maxResults, signal });
    const handler = Object.prototype.hasOwnProperty.call(handlers, query)
      ? handlers[query]
      : fallback;
    if (typeof handler === 'function') {
      const value = await handler(query, maxResults, signal);
      if (Array.isArray(value)) return { sources: value, truncated: false };
      return value;
    }
    if (handler instanceof Error) throw handler;
    if (handler === undefined || handler === null) {
      return { sources: [], truncated: false };
    }
    if (Array.isArray(handler)) return { sources: handler, truncated: false };
    return handler;
  };
  search.calls = calls;
  return search;
}

/** 构造 fake fetchPage：handlers 为 URL → 结果对象 / 函数 / Error。 */
function makeFetch(handlers = {}) {
  const calls = [];
  const fetchPage = async (url, signal) => {
    calls.push({ url, signal });
    const handler = handlers[url];
    if (typeof handler === 'function') return handler(url, signal);
    if (handler instanceof Error) throw handler;
    if (handler === undefined) throw new Error(`测试未预期的抓取：${url}`);
    return handler;
  };
  fetchPage.calls = calls;
  return fetchPage;
}

/** 文本抓取结果。 */
function page(content, extra = {}) {
  return {
    url: '',
    statusCode: 200,
    body: { kind: 'text', content },
    truncated: false,
    ...extra,
  };
}

/** HTML 抓取结果。 */
function htmlPage(html, extra = {}) {
  return {
    url: '',
    statusCode: 200,
    body: { kind: 'html', content: html },
    truncated: false,
    ...extra,
  };
}

/** 证据断言：报告结构完整性（SPEC §4.2 字段固定）。 */
function assertResearchResultShape(result) {
  assert.equal(result.ok, true);
  assert.equal(typeof result.question, 'string');
  assert.equal(typeof result.generatedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(result.generatedAt)));
  assert.equal(typeof result.depth, 'string');

  assert.ok(Array.isArray(result.queries));
  for (const entry of result.queries) {
    assert.equal(typeof entry.query, 'string');
    assert.ok(entry.round === 1 || entry.round === 2);
    assert.ok(['ok', 'failed', 'empty'].includes(entry.status));
    assert.equal(typeof entry.sourceCount, 'number');
    assert.ok(entry.sourceCount >= 0);
    if ('errorCode' in entry) assert.equal(typeof entry.errorCode, 'string');
    if ('error' in entry) assert.equal(typeof entry.error, 'string');
  }

  assert.ok(Array.isArray(result.sources));
  result.sources.forEach((source, index) => {
    assert.match(source.id, /^S\d+$/);
    assert.equal(source.id, `S${index + 1}`);
    assert.equal(typeof source.url, 'string');
    assert.equal(typeof source.domain, 'string');
    assert.ok(Array.isArray(source.queries));
    for (const query of source.queries) assert.equal(typeof query, 'string');
    assert.equal(typeof source.score, 'number');
    assert.equal(typeof source.fetched, 'boolean');
    assert.ok(
      ['ok', 'failed', 'skipped', 'truncated'].includes(source.fetchStatus),
    );
    assert.equal(typeof source.contentChars, 'number');
    if ('title' in source) assert.equal(typeof source.title, 'string');
    if ('snippet' in source) assert.equal(typeof source.snippet, 'string');
    if ('publishedAt' in source) {
      assert.equal(typeof source.publishedAt, 'string');
    }
  });
  for (let index = 1; index < result.sources.length; index += 1) {
    assert.ok(
      result.sources[index - 1].score >= result.sources[index].score,
      '来源必须按 score 降序',
    );
  }

  assert.ok(Array.isArray(result.evidence));
  assert.ok(result.evidence.length <= MAX_EVIDENCE);
  const sourceIds = new Set(result.sources.map((source) => source.id));
  for (const item of result.evidence) {
    assert.equal(typeof item.sourceId, 'string');
    assert.ok(sourceIds.has(item.sourceId), 'evidence.sourceId 必须指向已存在来源');
    assert.equal(typeof item.url, 'string');
    assert.equal(typeof item.passage, 'string');
    assert.ok(item.passage.length > 0);
    assert.ok(item.passage.length <= MAX_PASSAGE_CHARS);
    assert.ok(Array.isArray(item.matchedTerms));
    for (const term of item.matchedTerms) assert.equal(typeof term, 'string');
    assert.equal(typeof item.score, 'number');
  }

  assert.ok(Array.isArray(result.coverage));
  for (const entry of result.coverage) {
    assert.equal(typeof entry.query, 'string');
    assert.equal(typeof entry.sources, 'number');
    assert.equal(typeof entry.evidence, 'number');
  }

  assert.ok(Array.isArray(result.gaps));
  for (const gap of result.gaps) assert.equal(typeof gap, 'string');
  assert.ok(Array.isArray(result.warnings));
  for (const warning of result.warnings) assert.equal(typeof warning, 'string');

  assert.ok(result.stats && typeof result.stats === 'object');
  for (const key of ['searches', 'fetches', 'contentChars', 'elapsedMs']) {
    assert.equal(typeof result.stats[key], 'number');
    assert.ok(result.stats[key] >= 0);
  }

  assert.equal(typeof result.reportMarkdown, 'string');
  assert.ok(result.reportMarkdown.includes('# 深度研究证据报告'));
}

// ---------------------------------------------------------------------------
// §4.3 depth 预设与手动覆盖
// ---------------------------------------------------------------------------

describe('§4.3 depth 预设与手动覆盖', () => {
  test('quick / standard / deep 预设数值与 SPEC §4.3 表一致', () => {
    assert.deepEqual(DEPTH_PRESETS.quick, {
      rounds: 1,
      maxQueries: 3,
      maxSources: 8,
      fetchTop: 0,
      fetchCharBudget: 0,
    });
    assert.deepEqual(DEPTH_PRESETS.standard, {
      rounds: 2,
      maxQueries: 5,
      maxSources: 12,
      fetchTop: 4,
      fetchCharBudget: 60000,
    });
    assert.deepEqual(DEPTH_PRESETS.deep, {
      rounds: 2,
      maxQueries: 8,
      maxSources: 20,
      fetchTop: 6,
      fetchCharBudget: 120000,
    });

    assert.deepEqual(planQueries('问题', { depth: 'quick' }).limits, {
      depth: 'quick',
      rounds: 1,
      maxQueries: 3,
      maxSources: 8,
      fetchTop: 0,
      fetchCharBudget: 0,
    });
    assert.deepEqual(planQueries('问题', { depth: 'standard' }).limits, {
      depth: 'standard',
      rounds: 2,
      maxQueries: 5,
      maxSources: 12,
      fetchTop: 4,
      fetchCharBudget: 60000,
    });
    assert.deepEqual(planQueries('问题', { depth: 'deep' }).limits, {
      depth: 'deep',
      rounds: 2,
      maxQueries: 8,
      maxSources: 20,
      fetchTop: 6,
      fetchCharBudget: 120000,
    });
    // 未指定 depth 时默认 standard。
    assert.equal(planQueries('问题').limits.depth, 'standard');
  });

  test('手动覆盖逐项生效', () => {
    const limits = resolveLimits({
      depth: 'quick',
      maxQueries: 2,
      maxSources: 3,
      fetchTop: 1,
      fetchCharBudget: 100,
    });
    assert.deepEqual(limits, {
      depth: 'quick',
      rounds: 1,
      maxQueries: 2,
      maxSources: 3,
      fetchTop: 1,
      fetchCharBudget: 100,
    });

    const planned = planQueries('测试', {
      depth: 'standard',
      maxQueries: 2,
      maxSources: 5,
      fetchTop: 1,
      fetchCharBudget: 500,
    });
    assert.equal(planned.queries.length, 2);
    assert.equal(planned.limits.maxSources, 5);
    assert.equal(planned.limits.fetchTop, 1);
    assert.equal(planned.limits.fetchCharBudget, 500);
  });

  test('runResearch 默认 depth=standard，depth 回到输出', async () => {
    const search = makeSearch({}, () => [
      { url: 'https://one.example/a', title: 'A' },
    ]);
    const result = await runResearch(
      { question: 'depth 回显测试' },
      { search, fetchPage: makeFetch({}) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.depth, 'standard');
  });
});

// ---------------------------------------------------------------------------
// §5.1 查询规划
// ---------------------------------------------------------------------------

describe('§5.1 查询规划', () => {
  test('CJK 问题自动扩展为「最新进展 / 数据 引用」', () => {
    const planned = planQueries('光伏发电', { depth: 'standard' });
    assert.equal(planned.core, '光伏发电');
    assert.deepEqual(planned.queries, [
      '光伏发电',
      '光伏发电 最新进展',
      '光伏发电 数据 引用',
    ]);
  });

  test('纯拉丁问题自动扩展为「latest analysis / data evidence」', () => {
    const planned = planQueries('quantum computing', { depth: 'standard' });
    assert.deepEqual(planned.queries, [
      'quantum computing',
      'quantum computing latest analysis',
      'quantum computing data evidence',
    ]);
  });

  test('quick 档不自动扩展', () => {
    assert.deepEqual(planQueries('光伏发电', { depth: 'quick' }).queries, [
      '光伏发电',
    ]);
  });

  test('subquestions 优先于自动扩展，总数受 maxQueries 约束', () => {
    const planned = planQueries('光伏', {
      depth: 'standard',
      subquestions: ['光伏 储能', '光伏 政策'],
    });
    assert.deepEqual(planned.queries, [
      '光伏',
      '光伏 储能',
      '光伏 政策',
      '光伏 最新进展',
      '光伏 数据 引用',
    ]);

    // maxQueries=4 时自动扩展被截掉一条，subquestions 仍在。
    const capped = planQueries('光伏', {
      depth: 'standard',
      maxQueries: 4,
      subquestions: ['光伏 储能', '光伏 政策'],
    });
    assert.deepEqual(capped.queries, [
      '光伏',
      '光伏 储能',
      '光伏 政策',
      '光伏 最新进展',
    ]);

    // maxQueries=1 时只剩 core。
    assert.deepEqual(
      planQueries('核心', {
        depth: 'standard',
        maxQueries: 1,
        subquestions: ['子问题'],
      }).queries,
      ['核心'],
    );
  });

  test('超过 128 字符按 128 截断，不产生空串', () => {
    const longQuestion = 'a'.repeat(200);
    const planned = planQueries(longQuestion, { depth: 'quick' });
    assert.equal(planned.queries.length, 1);
    assert.equal(planned.queries[0].length, 128);

    const withLongSubquestion = planQueries('核心', {
      depth: 'quick',
      subquestions: ['b'.repeat(200)],
    });
    assert.equal(withLongSubquestion.queries.length, 2);
    for (const query of withLongSubquestion.queries) {
      assert.ok(query.length > 0 && query.length <= 128);
    }
  });

  test('精确重复只保留第一次出现；大小写不融合', () => {
    const planned = planQueries('dup', {
      depth: 'standard',
      subquestions: ['dup'],
    });
    assert.deepEqual(planned.queries, [
      'dup',
      'dup latest analysis',
      'dup data evidence',
    ]);

    const caseSensitive = planQueries('Foo', {
      depth: 'quick',
      subquestions: ['foo'],
    });
    assert.deepEqual(caseSensitive.queries, ['Foo', 'foo']);
  });

  test('问题去首尾空白并折叠内部连续空白', () => {
    const planned = planQueries('  人工   智能  ', { depth: 'quick' });
    assert.equal(planned.core, '人工 智能');
    assert.deepEqual(planned.queries, ['人工 智能']);
  });

  test('空问题不产生查询', () => {
    assert.deepEqual(planQueries('   ', { depth: 'standard' }).queries, []);
  });
});

// ---------------------------------------------------------------------------
// §5.2 URL 归一化与轮转合并
// ---------------------------------------------------------------------------

describe('§5.2 URL 归一化', () => {
  test('小写 scheme/host、去 fragment、去 utm_*、保留其它参数', () => {
    assert.equal(
      normalizeUrl(
        'HTTPS://Example.COM/Path/?utm_source=x&utm_medium=y&keep=1#frag',
      ),
      'https://example.com/Path/?keep=1',
    );
  });

  test('空路径与根路径等价', () => {
    assert.equal(normalizeUrl('https://example.com'), 'https://example.com/');
    assert.equal(
      normalizeUrl('https://example.com/'),
      normalizeUrl('https://example.com'),
    );
  });

  test('去 fbclid / gclid，其余查询参数保留', () => {
    const normalized = normalizeUrl(
      'https://example.com/a?fbclid=1&gclid=2&q=hello%20world',
    );
    assert.ok(!normalized.includes('fbclid'));
    assert.ok(!normalized.includes('gclid'));
    const parsed = new URL(normalized);
    assert.equal(parsed.searchParams.get('q'), 'hello world');
  });

  test('默认端口归一、非法输入不抛异常', () => {
    assert.equal(
      normalizeUrl('https://Example.com:443/x'),
      'https://example.com/x',
    );
    assert.equal(normalizeUrl(''), '');
    assert.equal(normalizeUrl('not a url'), 'not a url');
  });
});

describe('§5.2 mergeSearchResults 轮转合并', () => {
  const source = (url, extra = {}) => ({ url, ...extra });

  test('按 rank 轮转合并，并计算 score', () => {
    const merged = mergeSearchResults([
      {
        query: 'q1',
        sources: [
          source('https://a.com/1'),
          source('https://a.com/2'),
          source('https://a.com/3'),
        ],
      },
      {
        query: 'q2',
        sources: [source('https://d.com/1'), source('https://a.com/1')],
      },
    ]);

    assert.deepEqual(
      merged.map((item) => item.url),
      [
        'https://a.com/1',
        'https://d.com/1',
        'https://a.com/2',
        'https://a.com/3',
      ],
    );
    // a/1 命中两条查询 rank0：10*2-0=20；d/1 命中一条 rank0：10。
    assert.equal(merged[0].score, 20);
    assert.equal(merged[0].bestRank, 0);
    assert.deepEqual(merged[0].queries, ['q1', 'q2']);
    assert.equal(merged[1].score, 10);
    assert.equal(merged[2].score, 9);
    assert.equal(merged[3].score, 8);
    assert.equal(merged[0].domain, 'a.com');
  });

  test('归一化后去重（utm / fragment / 大小写）', () => {
    const merged = mergeSearchResults([
      {
        query: 'q1',
        sources: [source('https://A.com/x?utm_source=1#top')],
      },
      { query: 'q2', sources: [source('https://a.com/x')] },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].url, 'https://a.com/x');
    assert.deepEqual(merged[0].queries, ['q1', 'q2']);
  });

  test('maxSources 截断与同分按 order 升序', () => {
    const merged = mergeSearchResults(
      [
        { query: 'q1', sources: [source('https://a.com/1')] },
        { query: 'q2', sources: [source('https://b.com/1')] },
      ],
      { maxSources: 1 },
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].url, 'https://a.com/1');

    const tied = mergeSearchResults([
      { query: 'q1', sources: [source('https://a.com/1')] },
      { query: 'q2', sources: [source('https://b.com/1')] },
    ]);
    assert.equal(tied[0].score, 10);
    assert.equal(tied[1].score, 10);
    assert.deepEqual(
      tied.map((item) => item.url),
      ['https://a.com/1', 'https://b.com/1'],
    );
  });

  test('缺失 URL 的来源被忽略', () => {
    const merged = mergeSearchResults([
      { query: 'q1', sources: [source(''), { title: 'no url' }] },
    ]);
    assert.deepEqual(merged, []);
  });
});

// ---------------------------------------------------------------------------
// §5.3 正文抓取选择
// ---------------------------------------------------------------------------

describe('§5.3 正文抓取选择', () => {
  const SELECTION_SOURCES = [
    { url: 'https://a.com/1', title: 'A1' },
    { url: 'https://a.com/2', title: 'A2' },
    { url: 'https://a.com/3', title: 'A3' },
    { url: 'https://b.com/1', title: 'B1' },
    { url: 'https://b.com/2', title: 'B2' },
    { url: 'https://c.com/1', title: 'C1' },
  ];

  function selectionDeps(fetchHandlers = {}) {
    const handlers = {
      'https://a.com/1': page('a1 '.repeat(20)),
      'https://a.com/2': page('a2 '.repeat(20)),
      'https://a.com/3': page('a3 '.repeat(20)),
      'https://b.com/1': page('b1 '.repeat(20)),
      'https://b.com/2': page('b2 '.repeat(20)),
      'https://c.com/1': page('c1 '.repeat(20)),
      ...fetchHandlers,
    };
    const search = makeSearch({}, () => ({ sources: SELECTION_SOURCES }));
    const fetchPage = makeFetch(handlers);
    return { search, fetchPage };
  }

  test('同 host 最多 2 个，fetchTop 上限生效', () => {
    const targets = selectFetchTargets(
      SELECTION_SOURCES.map((item, index) => ({
        ...item,
        score: 100 - index,
        domain: new URL(item.url).hostname,
      })),
      { fetchTop: 4 },
    );
    assert.deepEqual(
      targets.map((item) => item.url),
      [
        'https://a.com/1',
        'https://a.com/2',
        'https://b.com/1',
        'https://b.com/2',
      ],
    );
    assert.deepEqual(selectFetchTargets(SELECTION_SOURCES, { fetchTop: 0 }), []);
  });

  test('runResearch 抓取选择：同 host 最多 2、按 score 优先', async () => {
    const { search, fetchPage } = selectionDeps();
    const result = await runResearch(
      { question: '抓取选择测试' },
      { search, fetchPage },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(
      fetchPage.calls.map((call) => call.url),
      [
        'https://a.com/1',
        'https://a.com/2',
        'https://b.com/1',
        'https://b.com/2',
      ],
    );
    assert.equal(result.stats.fetches, 4);
    assert.deepEqual(
      result.sources.map((source) => source.fetchStatus),
      ['ok', 'ok', 'skipped', 'ok', 'ok', 'skipped'],
    );
    assert.equal(result.sources[0].fetched, true);
    assert.equal(result.sources[2].fetched, false);
  });

  test('quick 档 fetchTop=0 不调用 fetchPage', async () => {
    const { search, fetchPage } = selectionDeps();
    const result = await runResearch(
      { question: '快速档不抓取', depth: 'quick' },
      { search, fetchPage },
    );
    assert.equal(result.ok, true);
    assert.equal(fetchPage.calls.length, 0);
    assert.equal(result.stats.fetches, 0);
    for (const source of result.sources) {
      assert.equal(source.fetchStatus, 'skipped');
      assert.equal(source.fetched, false);
    }
    assert.ok(result.gaps.join('\n').includes('fetchTop=0'));
  });

  test('单源抓取失败不中断其它来源', async () => {
    const failure = Object.assign(new Error('连接被重置'), { code: 'fetch-error' });
    const { search, fetchPage } = selectionDeps({
      'https://a.com/2': failure,
    });
    const result = await runResearch(
      { question: '抓取失败容错' },
      { search, fetchPage },
    );
    assert.equal(result.ok, true);
    assert.equal(result.sources[1].fetchStatus, 'failed');
    assert.equal(result.sources[1].fetched, false);
    for (const index of [0, 3, 4]) {
      assert.equal(result.sources[index].fetchStatus, 'ok');
    }
    // 失败后从候选队列补位：a/2 失败 → 补抓 b/2（S5）与 c/1（S6），
    // 直到成功抓取数重新达到 fetchTop=4。
    assert.equal(result.sources[5].fetchStatus, 'ok');
    assert.equal(result.stats.fetches, 5);
    assert.ok(result.gaps.join('\n').includes('抓取失败'));
  });

  test('非 2xx 视为失败并带状态码进 gap', async () => {
    const { search, fetchPage } = selectionDeps({
      'https://a.com/1': {
        url: 'https://a.com/1',
        statusCode: 404,
        body: { kind: 'text', content: 'not found' },
        truncated: false,
      },
    });
    const result = await runResearch(
      { question: 'HTTP 状态码测试' },
      { search, fetchPage },
    );
    assert.equal(result.sources[0].fetchStatus, 'failed');
    assert.ok(result.gaps.join('\n').includes('HTTP 404'));
  });

  test('预算耗尽后来源标 skipped 并加 warning', async () => {
    const { search, fetchPage } = selectionDeps();
    const result = await runResearch(
      {
        question: '预算测试',
        maxSources: 6,
        fetchTop: 3,
        fetchCharBudget: 100,
      },
      { search, fetchPage },
    );
    assert.equal(result.ok, true);
    // fetchTop=3 选出 a/1、a/2、b/1；正文各 20 个 "a1 " 共 60 字符：
    // 第一个可容纳（60 ≤ 100），第二、三个超出预算 → skipped。
    assert.equal(result.sources[0].fetchStatus, 'ok');
    assert.equal(result.sources[1].fetchStatus, 'skipped');
    assert.equal(result.sources[3].fetchStatus, 'skipped');
    assert.ok(result.warnings.join('\n').includes('预算'));
    assert.ok(result.gaps.join('\n').includes('预算'));
  });

  test('provider truncated 标记为 truncated 并加 warning', async () => {
    const { search, fetchPage } = selectionDeps({
      'https://a.com/1': page('截断正文 '.repeat(20), { truncated: true }),
    });
    const result = await runResearch(
      { question: '截断标记测试' },
      { search, fetchPage },
    );
    assert.equal(result.sources[0].fetchStatus, 'truncated');
    assert.equal(result.sources[0].fetched, true);
    assert.ok(result.warnings.join('\n').includes('截断'));
  });
});

// ---------------------------------------------------------------------------
// task-3 抓取失败回退（真实 E2E 暴露的缺陷）
// ---------------------------------------------------------------------------

describe('task-3 抓取失败回退', () => {
  test('失败后回退取到后续来源（同域名两个 404 的真实场景）', async () => {
    const g1 = 'https://raw.githubusercontent.com/a/b/README.md';
    const g2 = 'https://raw.githubusercontent.com/a/c/README.md';
    const docs = 'https://docs.example.com/page';
    const blog = 'https://blog.example.com/post';
    const sources = [
      { url: g1, title: 'G1' },
      { url: g2, title: 'G2' },
      { url: docs, title: 'Docs' },
      { url: blog, title: 'Blog' },
    ];
    const notFound = { statusCode: 404, body: { kind: 'text', content: '404: Not Found' }, truncated: false };
    const content =
      'fallback fetch evidence paragraph that is long enough to be extracted as evidence for the research report.';
    const search = makeSearch({}, () => ({ sources }));
    const fetchPage = makeFetch({
      [g1]: notFound,
      [g2]: notFound,
      [docs]: page(content),
      [blog]: page(content),
    });
    const result = await runResearch(
      {
        question: 'fallback fetch evidence',
        depth: 'standard',
        fetchTop: 2,
        fetchCharBudget: 60000,
      },
      { search, fetchPage },
    );
    assert.equal(result.ok, true);
    // 初始 2 个候选都 404；回退补抓 docs / blog 两个不同域名来源。
    assert.deepEqual(fetchPage.calls.map((call) => call.url), [g1, g2, docs, blog]);
    assert.equal(result.stats.fetches, 4);
    const failed = result.sources.filter((source) => source.fetchStatus === 'failed');
    const ok = result.sources.filter((source) => source.fetchStatus === 'ok');
    assert.equal(failed.length, 2);
    assert.equal(ok.length, 2);
    assert.deepEqual(
      [...new Set(result.evidence.map((item) => item.sourceId))].sort(),
      ['S3', 'S4'],
    );
  });

  test('同 host 失败后不再重复消耗候选', async () => {
    const a1 = 'https://bad.example/1';
    const a2 = 'https://bad.example/2';
    const a3 = 'https://bad.example/3';
    const good = 'https://good.example/1';
    const search = makeSearch({}, () => ({
      sources: [
        { url: a1, title: 'A1' },
        { url: a2, title: 'A2' },
        { url: a3, title: 'A3' },
        { url: good, title: 'Good' },
      ],
    }));
    const failure = Object.assign(new Error('站点不可用'), { code: 'fetch-failed' });
    const fetchPage = makeFetch({
      [a1]: failure,
      [a2]: failure,
      [a3]: page('should not be fetched, host already failed'),
      [good]: page('fallback source content long enough to be used as evidence paragraph here'),
    });
    const result = await runResearch(
      { question: 'failed host fallback', depth: 'standard', fetchTop: 2 },
      { search, fetchPage },
    );
    assert.equal(result.ok, true);
    // bad.example 的第三个候选不应再被尝试。
    assert.deepEqual(fetchPage.calls.map((call) => call.url), [a1, a2, good]);
    assert.equal(result.stats.fetches, 3);
    assert.equal(result.sources[2].fetchStatus, 'skipped');
    assert.equal(result.sources[3].fetchStatus, 'ok');
  });

  test('尝试次数上限为 fetchTop * 3', async () => {
    const sources = Array.from({ length: 10 }, (_, index) => ({
      url: `https://fail${index}.example/page`,
      title: `Fail ${index}`,
    }));
    const search = makeSearch({}, () => ({ sources }));
    const notFound = { statusCode: 404, body: { kind: 'text', content: '404' }, truncated: false };
    const fetchPage = makeFetch(
      Object.fromEntries(sources.map((source) => [source.url, notFound])),
    );
    const result = await runResearch(
      { question: 'attempt cap test', depth: 'standard', fetchTop: 2, fetchCharBudget: 60000 },
      { search, fetchPage },
    );
    assert.equal(result.ok, true);
    assert.equal(result.stats.fetches, 6);
    assert.equal(fetchPage.calls.length, 6);
    assert.equal(
      result.sources.filter((source) => source.fetchStatus === 'failed').length,
      6,
    );
    // 其余候选保持 skipped，不会被无限重试。
    assert.equal(
      result.sources.filter((source) => source.fetchStatus === 'skipped').length,
      4,
    );
  });

  test('gaps 中 provider 错误消息截断到 ≤240 字符且保留错误码', async () => {
    const bad = 'https://long-error.example/page';
    const good = 'https://good.example/page';
    const search = makeSearch({}, () => ({
      sources: [
        { url: bad, title: 'Bad' },
        { url: good, title: 'Good' },
      ],
    }));
    const longMessage = `上游返回异常 ${'provider-detail-'.repeat(300)}`;
    const failure = Object.assign(new Error(longMessage), {
      code: 'upstream-error',
    });
    const fetchPage = makeFetch({
      [bad]: failure,
      [good]: page('good content long enough to be extracted as an evidence paragraph for testing'),
    });
    const result = await runResearch(
      { question: 'gap truncation test', depth: 'standard', fetchTop: 1 },
      { search, fetchPage },
    );
    assert.equal(result.ok, true);
    const failureGap = result.gaps.find((gap) => gap.includes('upstream-error'));
    assert.ok(failureGap, '失败 gap 必须保留错误码');
    assert.ok(failureGap.length <= MAX_PROVIDER_MESSAGE_CHARS);
    assert.ok(failureGap.endsWith('…'));
    assert.ok(!failureGap.includes('provider-detail-'.repeat(50)));
  });

  test('超预算来源会被跳过并回退到更小的后续来源', async () => {
    const huge = 'https://huge.example/page';
    const small1 = 'https://small1.example/page';
    const small2 = 'https://small2.example/page';
    const search = makeSearch({}, () => ({
      sources: [
        { url: huge, title: 'Huge' },
        { url: small1, title: 'Small1' },
        { url: small2, title: 'Small2' },
      ],
    }));
    const fetchPage = makeFetch({
      [huge]: page('h'.repeat(200)),
      [small1]: page('s'.repeat(50)),
      [small2]: page('t'.repeat(50)),
    });
    const result = await runResearch(
      {
        question: 'budget fallback test',
        depth: 'standard',
        fetchTop: 2,
        fetchCharBudget: 100,
      },
      { search, fetchPage },
    );
    assert.equal(result.ok, true);
    assert.equal(result.sources[0].fetchStatus, 'skipped');
    assert.equal(result.sources[1].fetchStatus, 'ok');
    assert.equal(result.sources[2].fetchStatus, 'ok');
    assert.equal(result.stats.fetches, 3);
    assert.equal(result.stats.contentChars, 100);
  });
});

// ---------------------------------------------------------------------------
// §5.4 HTML 退化 / §5.5 段落抽取
// ---------------------------------------------------------------------------

describe('§5.4 HTML 退化与 §5.5 Markdown 段落抽取', () => {
  test('htmlToText：去脚本样式、块级置换行、解码实体、折叠空白', () => {
    const html =
      '<html><head><style>.x{color:red}</style><script>alert("secret")</script></head>' +
      '<body><h1>标题</h1><p>第一段 &amp; 内容，&quot;引号&quot; 与&nbsp;空格。</p>' +
      '<p>Second &lt;tag&gt; paragraph.</p></body></html>';
    const text = htmlToText(html);
    assert.ok(text.includes('标题'));
    assert.ok(text.includes('第一段 & 内容'));
    assert.ok(text.includes('Second <tag> paragraph.'));
    assert.ok(!text.includes('secret'));
    assert.ok(!text.includes('color:red'));
    assert.ok(!text.includes('<p>'));
    assert.ok(!/<script/i.test(text));
  });

  test('extractPassages：去标题/围栏代码/纯链接/短块，每来源最多 2 段', () => {
    const markdown = [
      '# 这是标题行',
      '',
      '第一段足够长的正文，包含 alpha 和 beta 两个词项，用于验证证据抽取的基本工作方式。',
      '',
      '`'.repeat(3),
      'code alpha beta fence should be removed',
      '`'.repeat(3),
      '',
      '[一个纯链接](https://example.com/page)',
      '',
      '短段落 alpha',
      '',
      '第二段也足够长，只包含 beta 词项，用来验证只命中单个词项的段落分数确实更低一些。',
    ].join('\n');

    const passages = extractPassages(markdown, ['alpha', 'beta'], {
      maxPassages: 2,
      maxChars: 600,
    });
    assert.equal(passages.length, 2);
    assert.ok(passages[0].passage.includes('alpha'));
    assert.ok(passages[0].passage.includes('beta'));
    assert.deepEqual(passages[0].matchedTerms, ['alpha', 'beta']);
    assert.equal(passages[0].score, 2);
    assert.deepEqual(passages[1].matchedTerms, ['beta']);
    assert.equal(passages[1].score, 1);

    const joined = passages.map((item) => item.passage).join('\n');
    assert.ok(!joined.includes('这是标题行'));
    assert.ok(!joined.includes('code alpha beta fence'));
    assert.ok(!joined.includes('example.com'));
    assert.ok(!joined.includes('短段落 alpha'));
  });

  test('extractPassages：maxChars 截断、maxPassages 上限', () => {
    const longParagraph = `alpha ${'x'.repeat(1000)}`;
    const truncated = extractPassages(longParagraph, ['alpha'], {
      maxPassages: 1,
      maxChars: 100,
    });
    assert.equal(truncated.length, 1);
    assert.equal(truncated[0].passage.length, 100);

    const many = [
      `alpha 第一段够长的正文内容 ${'一'.repeat(40)}`,
      `alpha 第二段够长的正文内容 ${'二'.repeat(40)}`,
      `alpha 第三段够长的正文内容 ${'三'.repeat(40)}`,
    ].join('\n\n');
    assert.equal(extractPassages(many, ['alpha'], { maxPassages: 2 }).length, 2);
  });

  test('html 抓取结果经退化后仍可抽取证据', async () => {
    const url = 'https://html.example/a';
    const html =
      '<html><body><p>This html evidence extraction paragraph is long enough to be selected as a passage for the research report.</p>' +
      '<p>Another paragraph about html evidence extraction methodology appears right here.</p></body></html>';
    const search = makeSearch({}, () => [
      { url, title: 'HTML 页面' },
    ]);
    const fetchPage = makeFetch({ [url]: htmlPage(html) });
    const result = await runResearch(
      { question: 'html evidence extraction' },
      { search, fetchPage },
    );
    assert.equal(result.ok, true);
    assert.equal(result.sources[0].fetched, true);
    assert.ok(result.sources[0].contentChars > 0);
    assert.ok(result.evidence.length > 0);
    assert.ok(result.evidence[0].passage.includes('html evidence extraction'));
  });
});

// ---------------------------------------------------------------------------
// §5.5 证据命中词项与排序
// ---------------------------------------------------------------------------

describe('§5.5 证据命中词项与排序', () => {
  test('按出现次数累计分数并降序，命中词项大小写不敏感', () => {
    const markdown = [
      'ALPHA alpha 出现三次 alpha，这一段足够长，用于验证命中次数打分的排序逻辑是否正确。',
      '',
      'beta 只出现一次的这一段同样足够长，用于验证第二名的分数确实低于第一段的内容。',
    ].join('\n');
    const passages = extractPassages(markdown, ['alpha', 'beta'], {
      maxPassages: 2,
    });
    assert.equal(passages.length, 2);
    assert.ok(passages[0].score > passages[1].score);
    assert.deepEqual(passages[0].matchedTerms, ['alpha']);
    assert.deepEqual(passages[1].matchedTerms, ['beta']);
    assert.ok(passages[0].passage.toLowerCase().includes('alpha'));
  });

  test('无词项命中时不产出证据段', () => {
    const markdown =
      '这是一段足够长的正文内容，但是不包含任何目标词项，所以不应该被抽取为证据段落。';
    assert.deepEqual(extractPassages(markdown, ['alpha'], {}), []);
    assert.deepEqual(extractPassages(markdown, [], {}), []);
  });
});

// ---------------------------------------------------------------------------
// §5.6 第二轮查询
// ---------------------------------------------------------------------------

describe('§5.6 第二轮查询', () => {
  test('仅当词项在 ≥2 个来源出现且不在原查询中时生成', () => {
    const queries = buildFollowupQueries(
      'topic',
      [
        { url: 'u1', content: 'alpha beta the and with' },
        { url: 'u2', content: 'alpha beta the and with' },
      ],
      {
        rounds: 2,
        maxQueries: 5,
        existingQueries: [
          'topic',
          'topic latest analysis',
          'topic data evidence',
        ],
      },
    );
    // 停用词被过滤，最大新增 2 条（受 maxQueries=5 与现有 3 条约束）。
    assert.deepEqual(queries, ['topic alpha', 'topic beta']);
  });

  test('已出现在原查询中的词项不生成；相同 URL 只计一次', () => {
    const queries = buildFollowupQueries(
      'topic',
      [
        { url: 'u1', content: 'alpha beta' },
        { url: 'u1', content: 'alpha beta' },
        { url: 'u2', content: 'alpha beta' },
      ],
      {
        rounds: 2,
        maxQueries: 5,
        existingQueries: ['topic', 'topic alpha'],
      },
    );
    assert.deepEqual(queries, ['topic beta']);
  });

  test('rounds=1 不生成；没有共有新词项不生成；无新增配额不生成', () => {
    assert.deepEqual(
      buildFollowupQueries(
        'topic',
        [{ url: 'u1', content: 'alpha' }, { url: 'u2', content: 'alpha' }],
        { rounds: 1, maxQueries: 5, existingQueries: [] },
      ),
      [],
    );

    assert.deepEqual(
      buildFollowupQueries(
        'topic',
        [
          { url: 'u1', content: 'alpha photovoltaic cells' },
          { url: 'u2', content: 'beta financing models' },
        ],
        { rounds: 2, maxQueries: 5, existingQueries: ['topic'] },
      ),
      [],
    );

    assert.deepEqual(
      buildFollowupQueries(
        'topic',
        [
          { url: 'u1', content: 'alpha beta' },
          { url: 'u2', content: 'alpha beta' },
        ],
        {
          rounds: 2,
          maxQueries: 3,
          existingQueries: ['topic', 'topic latest analysis', 'topic data evidence'],
        },
      ),
      [],
    );
  });

  test('runResearch 第二轮：有新词项才新增、总数不超 maxQueries', async () => {
    const sources = [
      { url: 'https://s1.example/a', title: 'S1' },
      { url: 'https://s2.example/b', title: 'S2' },
    ];
    const search = makeSearch(
      { 'solar power battery': [] },
      () => ({ sources }),
    );
    const fetchPage = makeFetch({
      'https://s1.example/a': page(
        'battery improves solar deployment in utility scale projects',
      ),
      'https://s2.example/b': page(
        'battery enables rooftop systems for households and businesses',
      ),
    });
    const result = await runResearch(
      { question: 'solar power' },
      { search, fetchPage },
    );
    assert.equal(result.ok, true);
    const roundTwo = result.queries.filter((entry) => entry.round === 2);
    assert.equal(roundTwo.length, 1);
    assert.equal(roundTwo[0].query, 'solar power battery');
    assert.equal(roundTwo[0].status, 'empty');
    assert.ok(result.queries.length <= 5);
    assert.ok(
      result.coverage.some(
        (entry) => entry.query === 'solar power battery' && entry.sources === 0,
      ),
    );
  });

  test('runResearch 第二轮：无共有新词项时只有第一轮查询', async () => {
    const sources = [
      { url: 'https://s1.example/a', title: 'S1' },
      { url: 'https://s2.example/b', title: 'S2' },
    ];
    const search = makeSearch({}, () => ({ sources }));
    const fetchPage = makeFetch({
      'https://s1.example/a': page(
        'photovoltaic cells convert photons directly into electricity efficiently',
      ),
      'https://s2.example/b': page(
        'rooftop financing models affect adoption rates across regions',
      ),
    });
    const result = await runResearch(
      { question: 'solar power' },
      { search, fetchPage },
    );
    assert.equal(result.ok, true);
    assert.equal(
      result.queries.filter((entry) => entry.round === 2).length,
      0,
    );
    assert.equal(result.queries.length, 3);
  });
});

// ---------------------------------------------------------------------------
// §4.2 失败路径
// ---------------------------------------------------------------------------

describe('§4.2 失败路径', () => {
  test('无效输入返回 invalid-input 信封', async () => {
    const deps = { search: makeSearch(), fetchPage: makeFetch({}) };
    const invalidInputs = [
      null,
      {},
      { question: '' },
      { question: '   ' },
      { question: 'x'.repeat(301) },
      { question: '正常问题', depth: 'extreme' },
      { question: '正常问题', maxQueries: 0 },
      { question: '正常问题', maxQueries: 11 },
      { question: '正常问题', maxSources: 31 },
      { question: '正常问题', fetchTop: 9 },
      { question: '正常问题', fetchCharBudget: 200001 },
      { question: '正常问题', maxQueries: 2.5 },
      { question: '正常问题', subquestions: 'x' },
      { question: '正常问题', subquestions: [''] },
      {
        question: '正常问题',
        subquestions: ['1', '2', '3', '4', '5', '6'],
      },
    ];
    for (const input of invalidInputs) {
      const result = await runResearch(input, deps);
      assert.equal(result.ok, false, JSON.stringify(input));
      assert.equal(result.code, 'invalid-input', JSON.stringify(input));
      assert.equal(typeof result.message, 'string');
      assert.ok(result.message.length > 0);
    }
    // 无效输入不应触发任何搜索。
    assert.equal(deps.search.calls.length, 0);
  });

  test('全部搜索失败 → all-searches-failed', async () => {
    const failure = Object.assign(new Error('provider down'), {
      code: 'web-search-failed',
    });
    const search = makeSearch({}, () => {
      throw failure;
    });
    const result = await runResearch(
      { question: '全部失败场景' },
      { search, fetchPage: makeFetch({}) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'all-searches-failed');
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.includes('全部'));
  });

  test('搜索成功但 0 来源 → no-results，message 带首条查询', async () => {
    const search = makeSearch({}, () => ({ sources: [], truncated: false }));
    const result = await runResearch(
      { question: '空结果场景' },
      { search, fetchPage: makeFetch({}) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'no-results');
    assert.ok(result.message.includes('空结果场景'));
  });

  test('signal 已取消 → 抛 AbortError，且不发起搜索', async () => {
    const controller = new AbortController();
    controller.abort();
    const search = makeSearch();
    await assert.rejects(
      () =>
        runResearch(
          { question: '取消场景' },
          { search, fetchPage: makeFetch({}), signal: controller.signal },
        ),
      (error) => error && error.name === 'AbortError',
    );
    assert.equal(search.calls.length, 0);
  });

  test('搜索过程中取消 → 抛 AbortError', async () => {
    const controller = new AbortController();
    let count = 0;
    const search = async () => {
      count += 1;
      controller.abort();
      throw new DOMException('cancelled', 'AbortError');
    };
    await assert.rejects(
      () =>
        runResearch(
          { question: '中途取消场景' },
          { search, fetchPage: makeFetch({}), signal: controller.signal },
        ),
      (error) => error && error.name === 'AbortError',
    );
    assert.equal(count, 1);
  });

  test('signal 贯穿 search / fetchPage 调用', async () => {
    const controller = new AbortController();
    const source = { url: 'https://signal.example/a', title: 'S' };
    const search = makeSearch({}, () => ({ sources: [source] }));
    const fetchPage = makeFetch({
      [source.url]: page('signal forwarding long enough paragraph for evidence'),
    });
    const result = await runResearch(
      { question: 'signal 透传测试', maxSources: 1 },
      { search, fetchPage, signal: controller.signal },
    );
    assert.equal(result.ok, true);
    assert.ok(search.calls.length > 0);
    for (const call of search.calls) assert.equal(call.signal, controller.signal);
    assert.equal(fetchPage.calls.length, 1);
    assert.equal(fetchPage.calls[0].signal, controller.signal);
  });
});

// ---------------------------------------------------------------------------
// §6 报告
// ---------------------------------------------------------------------------

describe('§6 报告', () => {
  test('完整报告包含问题、来源行、证据引用块、缺口段与统计', async () => {
    const sources = [
      {
        url: 'https://alpha.example/articles/1',
        title: 'Alpha 文章',
        snippet: 'alpha snippet',
        publishedAt: '2025-01-01',
      },
      { url: 'https://beta.example/articles/2', title: 'Beta 文章' },
    ];
    const search = makeSearch({}, () => ({ sources }));
    const fetchPage = makeFetch({
      'https://alpha.example/articles/1': page(
        'solar panel efficiency improves with battery storage and better materials according to this long paragraph.',
      ),
      'https://beta.example/articles/2': page(
        'rooftop installations pair each battery with inverters to stabilize the local grid over time.',
      ),
    });
    const result = await runResearch(
      { question: 'solar panel efficiency trends' },
      { search, fetchPage },
    );
    const report = result.reportMarkdown;

    assert.ok(report.startsWith('# 深度研究证据报告'));
    assert.ok(report.includes('solar panel efficiency trends'));
    assert.ok(report.includes('## 检索执行'));
    assert.ok(report.includes('| # | 查询 | 轮次 | 状态 | 来源 |'));
    assert.ok(report.includes('## 来源（按相关度）'));
    assert.ok(report.includes('### S1 · '));
    assert.ok(report.includes('- URL：'));
    assert.ok(report.includes('## 证据摘录'));
    assert.ok(report.includes('### [S1]'));
    assert.match(report, /^> .+/m);
    assert.ok(report.includes('匹配词项：'));
    assert.ok(report.includes('## 交叉印证'));
    assert.ok(report.includes('同时命中'));
    assert.ok(report.includes('## 缺口与提示'));
    assert.ok(report.includes('## 统计'));
    assert.ok(report.includes('搜索 '));
    assert.ok(report.length <= MAX_REPORT_CHARS);
  });

  test('无来源/无证据/无交叉时报告仍完整', () => {
    const report = buildReport({
      question: '空报告',
      generatedAt: '2026-01-01T00:00:00.000Z',
      depth: 'quick',
      queries: [],
      sources: [],
      evidence: [],
      coverage: [],
      gaps: [],
      warnings: [],
      stats: { searches: 0, fetches: 0, contentChars: 0, elapsedMs: 0 },
    });
    assert.ok(report.includes('（无来源）'));
    assert.ok(report.includes('无来源被多条查询同时命中'));
    assert.ok(report.includes('## 缺口与提示'));
    assert.ok(report.includes('- 无'));
  });

  test('报告超过 30000 字符时截断并提示', () => {
    const sources = Array.from({ length: 300 }, (_, index) => ({
      id: `S${index + 1}`,
      url: `https://example.com/${index}`,
      title: `来源标题 ${index}`,
      domain: 'example.com',
      queries: ['q'],
      score: 10,
      fetched: true,
      fetchStatus: 'ok',
      contentChars: 600,
      snippet: 'x'.repeat(200),
    }));
    const evidence = Array.from({ length: 300 }, (_, index) => ({
      sourceId: 'S1',
      url: 'https://example.com/1',
      title: '来源标题 1',
      passage: `证据段落 ${index} ${'证'.repeat(600)}`,
      matchedTerms: ['证据', '段落'],
      score: 2,
    }));
    const report = buildReport({
      question: '超长报告',
      sources,
      evidence,
      gaps: ['缺口'],
      stats: { searches: 1, fetches: 1, contentChars: 600, elapsedMs: 5 },
    });
    assert.ok(report.length <= MAX_REPORT_CHARS);
    assert.ok(report.includes('已截断'));
  });

  test('buildReport 对缺失字段保持宽容', () => {
    assert.doesNotThrow(() => buildReport());
    assert.doesNotThrow(() => buildReport({}));
    assert.equal(typeof buildReport({}), 'string');
  });
});

// ---------------------------------------------------------------------------
// §4.2 输出结构
// ---------------------------------------------------------------------------

describe('§4.2 输出结构', () => {
  function fullScenarioDeps() {
    const sources = [
      {
        url: 'https://alpha.example/articles/1',
        title: 'Alpha 文章',
        snippet: 'alpha snippet',
        publishedAt: '2025-01-01',
      },
      { url: 'https://beta.example/articles/2', title: 'Beta 文章' },
    ];
    const search = makeSearch({}, () => ({ sources }));
    const fetchPage = makeFetch({
      'https://alpha.example/articles/1': page(
        'solar panel efficiency improves with battery storage and better materials, according to this long paragraph of evidence.',
      ),
      'https://beta.example/articles/2': page(
        'rooftop installations pair each battery with inverters to stabilize the local grid over a long time horizon.',
      ),
    });
    return { search, fetchPage };
  }

  test('成功结果包含 SPEC §4.2 全部字段且类型正确', async () => {
    const deps = fullScenarioDeps();
    const result = await runResearch(
      { question: 'solar panel efficiency trends' },
      {
        ...deps,
        now: () => new Date('2026-01-02T03:04:05.000Z'),
      },
    );
    assertResearchResultShape(result);
    assert.equal(result.generatedAt, '2026-01-02T03:04:05.000Z');
    assert.equal(result.question, 'solar panel efficiency trends');
    assert.equal(result.depth, 'standard');
    assert.ok(result.sources.length >= 2);
    assert.equal(result.sources[0].id, 'S1');
    assert.ok(result.queries.length >= 3);
    assert.equal(result.coverage.length, result.queries.length);
    assert.ok(result.stats.searches >= 3);
    assert.ok(result.stats.fetches >= 2);
    assert.ok(result.stats.contentChars > 0);
    assert.equal(typeof result.stats.elapsedMs, 'number');
    assert.ok(result.reportMarkdown.includes('## 统计'));
  });

  test('手动覆盖 maxQueries/maxSources/fetchTop 影响实际执行', async () => {
    const sources = Array.from({ length: 7 }, (_, index) => ({
      url: `https://h${index}.example/page`,
      title: `来源 ${index}`,
    }));
    const search = makeSearch({}, () => ({ sources }));
    const fetchPage = makeFetch(
      Object.fromEntries(
        sources.map((source) => [
          source.url,
          page('override test paragraph that is long enough to be kept as evidence candidate'),
        ]),
      ),
    );
    const result = await runResearch(
      {
        question: 'override behavior check',
        maxQueries: 2,
        maxSources: 3,
        fetchTop: 1,
        fetchCharBudget: 1000,
      },
      { search, fetchPage },
    );
    assert.equal(result.ok, true);
    assert.equal(result.queries.length, 2);
    assert.equal(result.sources.length, 3);
    // 第一轮 2 条查询，均命中，第二轮可能补充查询；抓取只针对 1 个来源。
    assert.ok(result.stats.fetches <= 1);
  });
});
