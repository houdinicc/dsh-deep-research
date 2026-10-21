/**
 * dsh-deep-research —— Web GUI 的 HTTP 路由。
 *
 * 客户端半用**文档相对路径** `fetch('api/dsh-deep-research/...')` 调这里
 * （GUI 用 `<base href="./">`，根绝对路径会在子路径部署下逃出前缀）。
 * 注册时相反，必须是带前导斜杠的绝对路径。
 *
 * 安全：所有路由都过 `isLoopbackRequest` —— 只接受本机回环连接、
 * 回环 Host 头、且非 cross-site 的请求。研究结果只落 Host 侧磁盘。
 *
 * 路由形状约束：WebRoute 只有 `kind: 'exact'`，同一 `(kind, path)` 只能注册一次，
 * 因此「列表」与「详情」共用 `/runs` 这一条路由，用 `?id=` 区分；`/run` 只接受 POST。
 * 三条「方法/路径」行为 -> 两条 WebRoute。
 *
 * @module dsh-deep-research/routes
 */

import { createStore } from './store.js';
import { resolveConfig, runResearchRequest } from './tools.js';

const ROUTE_PREFIX = '/api/dsh-deep-research';
const MAX_BODY_BYTES = 16 * 1024;

/** 只有本机页面能调这些路由（与 dsh-raindrop / dsh-todos 同款围栏）。 */
export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? '';
  const loopback =
    address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
  if (!loopback) return false;

  let hostname;
  try {
    hostname = new URL(`http://${req.headers.host ?? ''}`).hostname;
  } catch {
    return false;
  }
  if (!(hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname))) return false;

  return req.headers['sec-fetch-site'] !== 'cross-site';
}

/** 路由层自己的错误：直接带 HTTP 状态与信封错误码。 */
class RouteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RouteError';
    this.status = status;
    this.code = code;
  }
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

function fail(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message } });
}

/** 从 RouteError / 未知异常映射到 HTTP 状态与信封错误码。 */
function respondError(res, error) {
  if (error instanceof RouteError) {
    fail(res, error.status, error.code, error.message);
    return;
  }
  fail(res, 500, 'internal', String(error?.message ?? error));
}

/**
 * 读取 JSON body：上限 16 KiB，空 body / 非法 JSON / 非对象一律 400 invalid-body。
 *
 * 不强制 `content-type`：浏览器端固定带 `application/json`，这里放宽到只看实际内容，
 * 便于命令行与测试直接 POST；解析失败已经足够拦截垃圾输入。
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new RouteError(400, 'invalid-body', '请求体过大（上限 16 KiB）');
    }
    chunks.push(buffer);
  }
  if (size === 0) throw new RouteError(400, 'invalid-body', '请求体不能为空');

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RouteError(400, 'invalid-body', '请求体不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RouteError(400, 'invalid-body', '请求体必须是 JSON 对象');
  }
  return parsed;
}

/** 从 `req.url` 取 query 参数；解析不了就当没传。 */
function readQueryParam(req, name) {
  const rawUrl = typeof req.url === 'string' && req.url !== '' ? req.url : '/';
  try {
    const url = /^https?:\/\//i.test(rawUrl)
      ? new URL(rawUrl)
      : new URL(`http://${req.headers?.host ?? 'localhost'}${rawUrl}`);
    const value = url.searchParams.get(name);
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/**
 * 组装路由表。
 *
 * @param {object} options
 * @param {object} [options.config] 已归一化的插件配置（会再过一遍 `resolveConfig` 以防万一）。
 * @param {ReturnType<typeof createStore>} [options.store] 研究历史库；缺省按真实数据目录创建。
 * @param {() => object | undefined} [options.web] 返回 `ctx.web`（调用时解析）。
 * @param {() => Date} [options.now] 时间来源，便于测试注入。
 * @returns {Array<{ kind: 'exact', path: string, handler: (req: object, res: object) => Promise<void> }>}
 */
export function createRoutes({ config, store, web, now } = {}) {
  const resolvedConfig = resolveConfig(config);
  const history = store ?? createStore();
  const webService = typeof web === 'function' ? web : () => undefined;
  const clock = typeof now === 'function' ? now : () => new Date();

  async function handleRuns(req) {
    const id = readQueryParam(req, 'id');
    if (id !== '') {
      const record = history.get(id);
      if (record === null) throw new RouteError(404, 'not-found', '未找到该历史记录');
      return record;
    }
    return { runs: history.list() };
  }

  async function handleRun(req) {
    const body = await readJsonBody(req);
    const result = await runResearchRequest(body, {
      config: resolvedConfig,
      web: webService,
      now: clock,
    });
    // 只存成功结果；失败信封仍原样回给 UI 渲染。
    if (result !== null && typeof result === 'object' && result.ok === true) {
      history.save(result);
    }
    return result;
  }

  /**
   * 把一个路径包成 WebRoute：围栏 → 按 `req.method` 分发 → JSON 信封 → 错误归一。
   *
   * ⚠️ `webServer.register` 以 `(kind, path)` 判重，同一路径只能注册一条 WebRoute。
   * 因此 `/runs` 的「列表 + 详情」合并在这**一条**路由里，用 query 参数区分；
   * 非预期方法/未知路径统一 404 not-found（不做 405）。
   *
   * @param {string} path 路由子路径。
   * @param {Record<string, (req: object) => Promise<unknown>>} methods 方法 → 处理函数。
   */
  function endpoint(path, methods) {
    return {
      kind: 'exact',
      path: `${ROUTE_PREFIX}${path}`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          fail(res, 403, 'forbidden', '只允许本机回环请求');
          return;
        }
        const handle = Object.hasOwn(methods, req.method) ? methods[req.method] : null;
        if (typeof handle !== 'function') {
          fail(res, 404, 'not-found', '未找到该接口');
          return;
        }
        try {
          const value = await handle(req);
          writeJson(res, 200, { ok: true, value });
        } catch (error) {
          respondError(res, error);
        }
      },
    };
  }

  // 两条路由：(kind, path) 组合唯一，可安全逐个 webServer.register()。
  return [
    endpoint('/runs', { GET: handleRuns }),
    endpoint('/run', { POST: handleRun }),
  ];
}
