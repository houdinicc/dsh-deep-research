/**
 * 离线演示：用注入的 fake `search` / `fetchPage` 跑通一次完整研究流水线，
 * 打印证据报告。不联网、不需要 API Key，用于快速确认插件逻辑可用。
 *
 * 运行：node scripts/demo.mjs
 */

import { runResearch } from '../lib/research.js';

const SEARCH_FIXTURES = {
  'DeepSeek Search API 是什么？': [
    {
      url: 'https://api-docs.deepseek.com/guides/search/',
      title: 'Search & Fetch | DeepSeek API Docs',
      snippet:
        'The Search API and the Fetch API give agents and RAG applications access to live web content, powered by an in-house search engine.',
      publishedAt: '2026-10-17',
    },
    {
      url: 'https://news.example.com/deepseek-search-api',
      title: 'DeepSeek 搜索 API 开放：每千次 0.75 美元',
      snippet: 'DeepSeek 于 2026 年 10 月开放独立搜索与抓取 API，定价为每千次成功请求 0.75 美元。',
      publishedAt: '2026-10-18',
    },
  ],
  'DeepSeek Search API 是什么？ 最新进展': [
    {
      url: 'https://api-docs.deepseek.com/guides/search/',
      title: 'Search & Fetch | DeepSeek API Docs',
      snippet: 'Search supports operators such as site: and quoted phrases; count is 1 to 50.',
      publishedAt: '2026-10-17',
    },
    {
      url: 'https://pandaily.com/deepseek-api-search-fetch-endpoints',
      title: 'DeepSeek Adds Standalone Search and Fetch APIs',
      snippet:
        'Search is served at api.deepseek.com/v1/tools/search and Fetch at /v1/tools/fetch, priced at 5 yuan per 1,000 calls.',
      publishedAt: '2026-10-18',
    },
  ],
};

const FETCH_FIXTURE = `# Search & Fetch

The Search API and the Fetch API give agents and RAG applications access to live web content. Search is served at POST https://api.deepseek.com/v1/tools/search and returns structured results with title, url and snippet.

The Fetch API retrieves one URL and returns its Markdown content. It is billed per successful request at 5 yuan per 1,000 calls.

## Query operators

Queries support site: filters and quoted phrases, up to 128 characters, and count from 1 to 50.`;

const deps = {
  async search(query, maxResults) {
    const sources = SEARCH_FIXTURES[query] ?? [];
    return { sources: sources.map((source) => ({ ...source })), truncated: false };
  },
  async fetchPage(url) {
    return { url, statusCode: 200, body: { kind: 'text', content: FETCH_FIXTURE }, truncated: false };
  },
  now: () => new Date('2026-10-21T14:30:00Z'),
};

const result = await runResearch(
  {
    question: 'DeepSeek Search API 是什么？',
    depth: 'standard',
    maxQueries: 3,
    maxSources: 5,
    fetchTop: 2,
    fetchCharBudget: 60000,
  },
  deps,
);

if (result.ok !== true) {
  console.error('demo failed:', result);
  process.exit(1);
}

console.log(
  `ok=${result.ok}  queries=${result.queries.length}  sources=${result.sources.length}  evidence=${result.evidence.length}`,
);
console.log('--------------------------------------------------');
console.log(result.reportMarkdown);
