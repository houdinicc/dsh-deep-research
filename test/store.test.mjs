import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createStore, resolveDataDir } from '../lib/store.js';

/** 每个用例一个临时目录，结束后删除；绝不碰真实 ~/.dsh。 */
function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-deep-research-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 与 `runResearch` 成功结果同形的 fixture。 */
function makeResult(overrides = {}) {
  return {
    ok: true,
    question: '深度研究插件怎么做？',
    depth: 'standard',
    generatedAt: '2026-10-21T08:00:00.000Z',
    stats: { searches: 2, fetches: 1, contentChars: 1234, elapsedMs: 4321 },
    queries: [{ query: '深度研究插件怎么做？', round: 1, status: 'ok', sourceCount: 2 }],
    sources: [
      { id: 'S1', url: 'https://example.com/a', title: 'A', domain: 'example.com', fetchStatus: 'ok' },
      { id: 'S2', url: 'https://example.com/b', title: 'B', domain: 'example.com', fetchStatus: 'skipped' },
    ],
    evidence: [{ sourceId: 'S1', url: 'https://example.com/a', passage: '证据段落', matchedTerms: ['证据'] }],
    coverage: [{ query: 'q', sources: 2, evidence: 1 }],
    gaps: ['示例缺口'],
    warnings: ['示例警告'],
    reportMarkdown: '# 证据报告\n\n正文…',
    ...overrides,
  };
}

function readRunsFile(store) {
  return JSON.parse(fs.readFileSync(store.file, 'utf8'));
}

test('resolveDataDir：跟随 $DSH_HOME，缺省 ~/.dsh/deep-research', () => {
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-home-fixture');
    assert.equal(resolveDataDir(), path.join(process.env.DSH_HOME, 'deep-research'));

    delete process.env.DSH_HOME;
    assert.equal(resolveDataDir(), path.join(os.homedir(), '.dsh', 'deep-research'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('空库：list 为空、get 命中不到、file 指向 runs.json', (t) => {
  const dir = makeTempDir(t);
  const store = createStore({ dir });

  assert.equal(store.file, path.join(dir, 'runs.json'));
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('r-anything'), null);
  assert.equal(store.get(''), null);
  assert.equal(store.get(undefined), null);
  assert.equal(fs.existsSync(store.file), false);
});

test('save/list/get：只存契约字段，摘要不含正文，磁盘结构为 version/runs', (t) => {
  const dir = makeTempDir(t);
  const now = new Date('2026-10-21T09:30:00.000Z');
  const store = createStore({ dir, now: () => now });

  const record = store.save(makeResult());

  assert.match(record.id, /^r-[0-9a-z]+-[0-9a-f]{6}$/);
  assert.equal(record.savedAt, now.toISOString());
  assert.equal(record.ok, true);
  assert.equal(record.question, '深度研究插件怎么做？');
  assert.equal(record.depth, 'standard');
  assert.equal(record.generatedAt, '2026-10-21T08:00:00.000Z');
  assert.deepEqual(record.stats, { searches: 2, fetches: 1, contentChars: 1234, elapsedMs: 4321 });
  assert.equal(record.sources.length, 2);
  assert.equal(record.reportMarkdown, '# 证据报告\n\n正文…');

  const onDisk = readRunsFile(store);
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.runs.length, 1);
  assert.equal(onDisk.runs[0].id, record.id);

  const [summary] = store.list();
  assert.deepEqual(Object.keys(summary).sort(), [
    'depth',
    'elapsedMs',
    'evidenceCount',
    'id',
    'question',
    'savedAt',
    'sourceCount',
  ]);
  assert.deepEqual(summary, {
    id: record.id,
    savedAt: now.toISOString(),
    question: '深度研究插件怎么做？',
    depth: 'standard',
    sourceCount: 2,
    evidenceCount: 1,
    elapsedMs: 4321,
  });
  // 摘要里绝不能带正文。
  assert.equal('reportMarkdown' in summary, false);
  assert.equal('sources' in summary, false);

  const full = store.get(record.id);
  assert.deepEqual(full, record);
  assert.equal(full.reportMarkdown, '# 证据报告\n\n正文…');
});

test('save：只接受成功结果，失败信封/非法入参一律抛错', (t) => {
  const store = createStore({ dir: makeTempDir(t) });

  for (const bad of [null, undefined, {}, { ok: false, code: 'internal', message: 'boom' }, 'x', []]) {
    assert.throws(() => store.save(bad), /only successful runs are stored/);
  }
  assert.deepEqual(store.list(), []);
  assert.equal(fs.existsSync(store.file), false);
});

test('maxRuns：超限淘汰最旧，新记录始终在前', (t) => {
  const dir = makeTempDir(t);
  let tick = 0;
  const store = createStore({
    dir,
    maxRuns: 2,
    now: () => new Date(Date.UTC(2026, 9, 21, 0, 0, tick++)),
  });

  const first = store.save(makeResult({ question: '第一个' }));
  const second = store.save(makeResult({ question: '第二个' }));
  const third = store.save(makeResult({ question: '第三个' }));

  assert.deepEqual(
    store.list().map((item) => item.question),
    ['第三个', '第二个'],
  );
  assert.equal(store.get(third.id) !== null, true);
  assert.equal(store.get(second.id) !== null, true);
  assert.equal(store.get(first.id), null);
  assert.equal(readRunsFile(store).runs.length, 2);

  // 重新打开同一目录，容量约束仍然生效。
  const reopened = createStore({ dir, maxRuns: 2 });
  assert.deepEqual(
    reopened.list().map((item) => item.question),
    ['第三个', '第二个'],
  );
});

test('损坏容错：非法 JSON、未知结构、坏记录都不抛错，下次写入覆盖', (t) => {
  const dir = makeTempDir(t);
  const store = createStore({ dir });

  fs.writeFileSync(store.file, '{ 不是 JSON', 'utf8');
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('r-1'), null);

  fs.writeFileSync(store.file, JSON.stringify({ version: 2, runs: [{ id: 'r-old' }] }), 'utf8');
  assert.deepEqual(store.list(), []);

  fs.writeFileSync(store.file, '[]', 'utf8');
  assert.deepEqual(store.list(), []);

  // 结构正确但记录残缺：只保留认得出 id 的记录，坏记录丢弃。
  fs.writeFileSync(
    store.file,
    JSON.stringify({
      version: 1,
      runs: [
        null,
        '字符串',
        { id: '' },
        { id: 'r-keep', savedAt: '2026-01-01T00:00:00.000Z', question: '旧记录', sources: [{ id: 'S1' }] },
      ],
    }),
    'utf8',
  );
  const kept = store.list();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 'r-keep');
  assert.equal(kept[0].question, '旧记录');
  assert.equal(kept[0].sourceCount, 1);
  assert.equal(kept[0].elapsedMs, 0);

  // 下一次 save 以干净结构覆盖磁盘。
  const record = store.save(makeResult({ question: '新记录' }));
  const onDisk = readRunsFile(store);
  assert.equal(onDisk.version, 1);
  assert.deepEqual(
    onDisk.runs.map((item) => item.id),
    [record.id, 'r-keep'],
  );
});

test('权限位：目录 0700、文件 0600', { skip: process.platform === 'win32' }, (t) => {
  const dir = makeTempDir(t);
  const store = createStore({ dir });
  store.save(makeResult());

  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);

  // 嵌套目录也能递归创建。
  const nested = path.join(dir, 'a', 'b', 'c');
  const nestedStore = createStore({ dir: nested });
  nestedStore.save(makeResult());
  assert.equal(fs.statSync(nested).mode & 0o777, 0o700);
  assert.equal(fs.statSync(nestedStore.file).mode & 0o777, 0o600);
});

test('clear：清空历史并保留可读空库', (t) => {
  const dir = makeTempDir(t);
  const store = createStore({ dir });
  store.save(makeResult());
  assert.equal(store.list().length, 1);

  store.clear();

  assert.deepEqual(store.list(), []);
  assert.deepEqual(readRunsFile(store), { version: 1, runs: [] });
});

test('save(result, extra)：附加元数据随记录持久化，但不能覆盖 id/savedAt/ok', (t) => {
  const dir = makeTempDir(t);
  const store = createStore({ dir, now: () => new Date('2026-10-21T10:00:00.000Z') });

  const record = store.save(makeResult(), {
    origin: 'web',
    id: 'hacked',
    savedAt: 'hacked',
    ok: false,
  });

  assert.notEqual(record.id, 'hacked');
  assert.equal(record.savedAt, '2026-10-21T10:00:00.000Z');
  assert.equal(record.ok, true);
  assert.equal(record.origin, 'web');

  const reopened = createStore({ dir });
  const persisted = reopened.get(record.id);
  assert.equal(persisted.origin, 'web');
  assert.equal(persisted.ok, true);
});

test('保存多条：新记录在前，id 不重复', (t) => {
  const dir = makeTempDir(t);
  let tick = 0;
  const store = createStore({ dir, now: () => new Date(Date.UTC(2026, 9, 21, 1, 0, tick++)) });

  const first = store.save(makeResult({ question: 'A' }));
  const second = store.save(makeResult({ question: 'B' }));

  assert.notEqual(first.id, second.id);
  assert.deepEqual(
    store.list().map((item) => item.question),
    ['B', 'A'],
  );
});
