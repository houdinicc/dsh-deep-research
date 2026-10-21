/**
 * dsh-deep-research —— 研究历史存储。
 *
 * 只持久化「成功的研究结果」，供 Web 面板的历史列表与详情回放使用。
 * 研究本身每次现跑，历史只是结果快照。
 *
 * 设计取舍（与 dsh-raindrop/lib/store.js 同款）：
 *  - 零依赖：只用 node:* 内置模块，插件因此不需要 pnpm 安装；
 *  - 单文件 `$DSH_HOME/deep-research/runs.json`，格式 `{ version: 1, runs: [...] }`；
 *  - 写入是「临时文件 + rename」的原子替换，目录 0700、文件 0600；
 *  - 文件缺失、JSON 损坏或结构不认识**不抛错**，按空列表处理，下次写入覆盖；
 *  - 新记录在前，最多保留 `maxRuns` 条（缺省 20）。
 *
 * 本模块不依赖 Cordis，可单独测试。
 *
 * @module dsh-deep-research/store
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE_NAME = 'runs.json';
const STATE_VERSION = 1;
const DEFAULT_MAX_RUNS = 20;

/** `$DSH_HOME`（缺省 `~/.dsh`）下的插件私有数据目录。 */
export function resolveDataDir() {
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : path.join(os.homedir(), '.dsh');
  return path.join(home, 'deep-research');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeMaxRuns(value) {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_RUNS;
}

function emptyState() {
  return { version: STATE_VERSION, runs: [] };
}

/**
 * 把磁盘上的一条记录修成契约字段；认不出 id 的记录直接丢弃。
 *
 * 保留记录里的额外字段（`save(result, extra)` 允许附加元数据），因此这里
 * 先展开 raw 再覆盖必需字段，而不是白名单重建。
 */
function normalizeRecord(raw) {
  if (!isPlainObject(raw)) return null;
  const id = asString(raw.id);
  if (id === '') return null;
  return {
    ...raw,
    id,
    savedAt: asString(raw.savedAt),
    question: asString(raw.question),
    depth: asString(raw.depth) || 'standard',
    generatedAt: asString(raw.generatedAt),
    ok: true,
    stats: isPlainObject(raw.stats) ? raw.stats : {},
    queries: asArray(raw.queries),
    sources: asArray(raw.sources),
    evidence: asArray(raw.evidence),
    coverage: asArray(raw.coverage),
    gaps: asArray(raw.gaps),
    warnings: asArray(raw.warnings),
    reportMarkdown: asString(raw.reportMarkdown),
  };
}

/** 读取并校验磁盘结构；任何异常都按空库处理。 */
function parseState(text, maxRuns) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyState();
  }
  if (!isPlainObject(raw) || raw.version !== STATE_VERSION || !Array.isArray(raw.runs)) {
    return emptyState();
  }
  const seen = new Set();
  const runs = [];
  for (const item of raw.runs) {
    const record = normalizeRecord(item);
    if (record === null || seen.has(record.id)) continue;
    seen.add(record.id);
    runs.push(record);
  }
  return { version: STATE_VERSION, runs: runs.slice(0, maxRuns) };
}

/**
 * 打开（或首次创建）研究历史库。
 *
 * @param {object} [options]
 * @param {string} [options.dir] 数据目录；缺省 `resolveDataDir()`。
 * @param {number} [options.maxRuns] 最多保留的记录数；缺省 20。
 * @param {() => Date} [options.now] 时间来源，便于测试注入。
 * @returns {{
 *   file: string,
 *   save(result: object, extra?: object): object,
 *   list(): Array<{ id: string, savedAt: string, question: string, depth: string,
 *                   sourceCount: number, evidenceCount: number, elapsedMs: number }>,
 *   get(id: string): object | null,
 *   clear(): void,
 * }}
 */
export function createStore(options = {}) {
  const dir =
    typeof options.dir === 'string' && options.dir.trim() !== '' ? options.dir.trim() : resolveDataDir();
  const file = path.join(dir, FILE_NAME);
  const maxRuns = normalizeMaxRuns(options.maxRuns);
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  /** 当前时间：`now()` 返回非法 Date 时回落到真实时钟。 */
  function currentDate() {
    const value = now();
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  }

  /** 读盘；文件缺失/损坏/结构不认识都当空库，不抛错。 */
  function load() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return emptyState();
    }
    return parseState(text, maxRuns);
  }

  /** 原子写：tmp + rename，目录 0700、文件 0600。 */
  function persist(state) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* 目录权限不是致命问题，继续写 */
    }
    const tmp = path.join(
      dir,
      `.${FILE_NAME}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.tmp`,
    );
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(tmp, 0o600);
      } catch {
        /* 见上 */
      }
      fs.renameSync(tmp, file);
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 清理失败不掩盖原始错误 */
      }
      throw error;
    }
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* 见上 */
    }
  }

  /** `r-<时间戳36>-<6位随机>`；随机段用 hex，撞车时重抽。 */
  function generateId(at, taken) {
    const stamp = Math.max(0, at.getTime()).toString(36);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = `r-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
      if (!taken.has(id)) return id;
    }
    return `r-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  }

  return {
    file,

    /**
     * 保存一条成功结果。失败结果或非法入参直接抛错（route 层不会走到这里）。
     *
     * @param {object} result `runResearch` 的结果对象。
     * @param {object} [extra] 附加元数据（不覆盖 id/savedAt/ok）。
     * @returns {object} 落盘的完整 record。
     */
    save(result, extra) {
      if (!isPlainObject(result) || result.ok !== true) {
        throw new Error('only successful runs are stored');
      }

      const state = load();
      const at = currentDate();
      const taken = new Set(state.runs.map((record) => record.id));
      const record = {
        id: generateId(at, taken),
        savedAt: at.toISOString(),
        question: asString(result.question),
        depth: asString(result.depth) || 'standard',
        generatedAt: asString(result.generatedAt),
        ok: true,
        stats: isPlainObject(result.stats) ? { ...result.stats } : {},
        queries: asArray(result.queries),
        sources: asArray(result.sources),
        evidence: asArray(result.evidence),
        coverage: asArray(result.coverage),
        gaps: asArray(result.gaps),
        warnings: asArray(result.warnings),
        reportMarkdown: asString(result.reportMarkdown),
      };
      if (isPlainObject(extra)) {
        for (const [key, value] of Object.entries(extra)) {
          if (key === 'id' || key === 'savedAt' || key === 'ok') continue;
          record[key] = value;
        }
      }

      persist({ version: STATE_VERSION, runs: [record, ...state.runs].slice(0, maxRuns) });
      return record;
    },

    /** 历史摘要（不含正文/reportMarkdown），新记录在前。 */
    list() {
      return load().runs.map((record) => {
        const elapsed = Number(record.stats?.elapsedMs);
        return {
          id: record.id,
          savedAt: record.savedAt,
          question: record.question,
          depth: record.depth,
          sourceCount: record.sources.length,
          evidenceCount: record.evidence.length,
          elapsedMs: Number.isFinite(elapsed) ? Math.max(0, Math.trunc(elapsed)) : 0,
        };
      });
    },

    /** 按 id 取完整记录；不存在返回 null。 */
    get(id) {
      const key = typeof id === 'string' ? id : '';
      if (key === '') return null;
      return load().runs.find((record) => record.id === key) ?? null;
    },

    /** 清空历史（写回空库，保留文件）。 */
    clear() {
      persist(emptyState());
    },
  };
}
