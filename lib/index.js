/**
 * Deep Research（dsh-deep-research）—— 宿主半入口。
 *
 * 本文件不 import 任何 `@deepseek-ai/*` 包：研究流水线只通过宿主已挂载的
 * `ctx.web`（search / fetch）取数，因此部署侧可以在「插件 → 内置插件设置 →
 * Web search」里自由切换 provider（DeepSeek Search API、Messages 搜索、本地抓取等）。
 *
 * 模块分工：
 *  - `lib/research.js`：纯编排（无 ctx）；
 *  - `lib/tools.js`：配置、参数规范化、工具定义与渲染；
 *  - `lib/webAdapter.js`：宿主 `ctx.web` 适配（宿主优先 + 账号兜底搜索）；
 *  - `lib/deepseekSearch.js`：账号兜底搜索（DeepSeek Search API，`x-dsh-auth-token`）；
 *  - `lib/store.js`：研究历史的落盘（`$DSH_HOME/deep-research/runs.json`）；
 *  - `lib/routes.js`：Web 面板用的 HTTP 路由（回环围栏 + JSON 信封）；
 *  - 本文件只做装配：路由、工具、历史三者共享同一个 store。
 *
 * @module dsh-deep-research
 */

import { createRoutes } from './routes.js';
import { createStore, resolveDataDir } from './store.js';
import { createTools, resolveConfig } from './tools.js';
import { createWebAdapter } from './webAdapter.js';

/**
 * 插件入口。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - patch 行的 `config:` 对象。
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const store = createStore({ dir: resolveDataDir() });

  /** 宿主 web + 账号兜底的统一取数通道（宿主优先，失败落账号搜索）。 */
  const createChannel = (scope) =>
    createWebAdapter({
      // 调用时解析：ctx.web 可能晚于本插件挂载，也可能被重新组合。
      getWeb: () => scope.get('web'),
      // 账号兜底：宿主 web-search-deepseek 只在会话路由为 deepseek-account 时才用
      // 账号 token；这里绕开该门控，让面板/工具在 API key 失效时仍有可用搜索。
      getAccount: () => scope.get('deepseekAccount'),
      config: resolved,
      logger: (level, message) => {
        const text = `dsh-deep-research: ${message}`;
        if (level === 'warn') scope.logger?.warn?.(text);
        else scope.logger?.info?.(text);
      },
    });

  // ---------------------------------------------------------- 面板数据路由
  // 路由不依赖 tools：即使 enableTools=false，Web 面板仍应可用。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const routes = createRoutes({
        config: resolved,
        store,
        web: createChannel(webCtx),
        now: () => new Date(),
        logger: (level, message, detail) => {
          const text = `dsh-deep-research: ${message}`;
          if (level === 'warn') webCtx.logger?.warn?.(text, detail);
          else webCtx.logger?.info?.(text);
        },
      });
      const disposers = routes.map((route) => webCtx.webServer.register(route));
      webCtx.logger?.info?.(`dsh-deep-research: 已注册 ${disposers.length} 条 Web 路由`);
      return () => {
        for (const dispose of disposers) if (typeof dispose === 'function') dispose();
      };
    }, 'dsh-deep-research: web routes');
  });

  // ------------------------------------------------------------ Agent 工具
  if (resolved.enableTools === false) {
    ctx.logger?.info?.('dsh-deep-research: enableTools=false，跳过工具注册');
  } else {
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.effect(() => {
        const definitions = createTools({
          config: resolved,
          web: createChannel(toolCtx),
          now: () => new Date(),
          log: (level, message, detail) => {
            const text = `dsh-deep-research: ${message}`;
            if (level === 'warn') toolCtx.logger?.warn?.(text, detail);
            else toolCtx.logger?.info?.(text);
          },
          // Agent 侧的研究结果同样进入面板历史。
          onResult: (value) => {
            try {
              store.save(value);
            } catch (error) {
              toolCtx.logger?.warn?.(`dsh-deep-research: 研究历史落盘失败：${error?.message ?? error}`);
            }
          },
        });
        const disposers = definitions.map((definition) => toolCtx.tools.register(definition));
        toolCtx.logger?.info?.(
          `dsh-deep-research: 已注册 ${definitions.length} 个 Agent 工具（${definitions
            .map((definition) => definition.name)
            .join(', ')}）`,
        );
        return () => {
          for (const dispose of disposers) if (typeof dispose === 'function') dispose();
        };
      }, 'dsh-deep-research: agent tools');
    });
  }

  ctx.logger?.info?.(
    `dsh-deep-research: 宿主半已激活（defaultDepth=${resolved.defaultDepth}, `
      + `maxQueries=${resolved.maxQueries}, maxSources=${resolved.maxSources}, fetchTop=${resolved.fetchTop}, `
      + `history=${store.file}）`,
  );
}
