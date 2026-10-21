/**
 * 查询规划：depth 预设、问题归一化、查询生成。
 *
 * 本文件是纯函数模块：不接触 ctx、不发网络请求、不写文件。
 * 由 lib/research.js 重导出 planQueries，测试可直接从任一文件导入。
 */

/** SPEC §4.3 固定的 depth 预设（不要在这里加隐藏默认值）。 */
export const DEPTH_PRESETS = Object.freeze({
  quick: Object.freeze({
    rounds: 1,
    maxQueries: 3,
    maxSources: 8,
    fetchTop: 0,
    fetchCharBudget: 0,
  }),
  standard: Object.freeze({
    rounds: 2,
    maxQueries: 5,
    maxSources: 12,
    fetchTop: 4,
    fetchCharBudget: 60000,
  }),
  deep: Object.freeze({
    rounds: 2,
    maxQueries: 8,
    maxSources: 20,
    fetchTop: 6,
    fetchCharBudget: 120000,
  }),
});

/** 默认深度。 */
export const DEFAULT_DEPTH = 'standard';

/** 单条查询的最大长度（SPEC §2.1 Search API 约束：非空、≤128 字符）。 */
export const MAX_QUERY_CHARS = 128;

/** 问题长度上限（SPEC §4.1）。 */
export const MAX_QUESTION_CHARS = 300;

/** CJK 判定：汉字、假名、韩文。用于选择自动扩展后缀。 */
const CJK_RE =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

/**
 * 判断文本是否含 CJK 字符。
 * @param {unknown} text
 * @returns {boolean}
 */
export function hasCJK(text) {
  return CJK_RE.test(String(text ?? ''));
}

/**
 * 去掉首尾空白，并把内部连续空白折叠为单个空格。
 * @param {unknown} text
 * @returns {string}
 */
export function collapseWhitespace(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 把任意输入规范成一条可用查询：折叠空白、截断到 128 字符、去首尾空白。
 * 截断后若为空串则返回 ''（调用方负责跳过）。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeQuery(raw) {
  const text = collapseWhitespace(raw);
  if (!text) return '';
  if (text.length <= MAX_QUERY_CHARS) return text;
  return text.slice(0, MAX_QUERY_CHARS).trim();
}

/**
 * 解析最终生效的参数上限：depth 预设 + 显式覆盖。
 * 未知 depth 回退到 standard（runResearch 在入口处已校验，这里只做兜底）。
 * @param {{ depth?: string, maxQueries?: number, maxSources?: number, fetchTop?: number, fetchCharBudget?: number }} [options]
 * @returns {{ depth: string, rounds: number, maxQueries: number, maxSources: number, fetchTop: number, fetchCharBudget: number }}
 */
export function resolveLimits(options = {}) {
  const depth =
    typeof options.depth === 'string' && DEPTH_PRESETS[options.depth]
      ? options.depth
      : DEFAULT_DEPTH;
  const preset = DEPTH_PRESETS[depth];
  const pick = (key) =>
    options[key] === undefined || options[key] === null
      ? preset[key]
      : options[key];
  return {
    depth,
    rounds: preset.rounds,
    maxQueries: pick('maxQueries'),
    maxSources: pick('maxSources'),
    fetchTop: pick('fetchTop'),
    fetchCharBudget: pick('fetchCharBudget'),
  };
}

/**
 * 生成研究查询列表（SPEC §5.1）。
 *
 * 顺序：core → subquestions → 自动扩展；精确去重；每条 ≤128 字符；
 * 总数不超过 maxQueries（subquestions 优先于自动扩展）。
 *
 * @param {string} question
 * @param {{ depth?: string, subquestions?: string[], maxQueries?: number, maxSources?: number, fetchTop?: number, fetchCharBudget?: number }} [options]
 * @returns {{ core: string, queries: string[], limits: { depth: string, rounds: number, maxQueries: number, maxSources: number, fetchTop: number, fetchCharBudget: number } }}
 */
export function planQueries(question, options = {}) {
  const limits = resolveLimits(options);
  const core = collapseWhitespace(question);
  const candidates = [];

  /** 规范化后按精确字符串去重入列。 */
  const push = (raw) => {
    const query = normalizeQuery(raw);
    if (!query) return;
    if (candidates.includes(query)) return;
    candidates.push(query);
  };

  push(core);

  const subquestions = Array.isArray(options.subquestions)
    ? options.subquestions
    : [];
  for (const subquestion of subquestions) {
    push(subquestion);
  }

  // 自动扩展：quick 档不做；其它 depth 追加两条口径不同的查询。
  // core 为空（纯空白问题）时不扩展，否则会凭空生成 "latest analysis"。
  if (core && (limits.rounds > 1 || limits.depth !== 'quick')) {
    const suffixes = hasCJK(core)
      ? [' 最新进展', ' 数据 引用']
      : [' latest analysis', ' data evidence'];
    for (const suffix of suffixes) {
      push(core + suffix);
    }
  }

  const maxQueries = Math.max(0, Math.floor(limits.maxQueries));
  return { core, queries: candidates.slice(0, maxQueries), limits };
}
