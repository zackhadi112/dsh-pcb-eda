/**
 * `@huaqiu/dsh-tool-freerouting` — node plugin entry.
 *
 * Provides PCB autorouting tools via FreeRouting:
 *
 *   pcb_route          whole-board autorouting
 *   pcb_route_nets     selected-net autorouting
 *
 * ── Architectural boundary ─────────────────────────────────────────────────
 * The production request path for KiCad is:
 *   DSH → dsh-tool-freerouting → hq-edge → EDA Host
 *
 * This plugin owns DSH integration only: it translates tool calls into
 * hq-edge HTTP requests (for KiCad board operations) and direct HTTP calls
 * to the FreeRouting engine at `http://127.0.0.1:37864`.
 *
 * The plugin is self-contained — no `@hqedge/*` dependency. The hq-edge base
 * URL is resolved at request time: (1) `ctx.hqEdge.baseUrl` from the
 * edge-bridge HOST, then (2) config overlay (`hqEdgeBaseUrl`), then (3)
 * `HQ_EDGE_BASE_URL` env fallback. `hqEdge` is a REQUIRED inject.
 *
 * @module @huaqiu/dsh-tool-freerouting
 */
import type { Context } from '@deepseek-ai/cordis';
import { getLogger } from '@huaqiu/dsh-plugin-log';
import type { Config } from './config.js';
import { apply as applyRuntime } from './runtime.js';

/** Plugin id — matches package.json. */
export const name = '@huaqiu/dsh-tool-freerouting'

/**
 * Cordis services this half depends on.
 *
 * `hqEdge` is REQUIRED: the edge-bridge (the HOST) provides the node-side
 * `hqEdge` service whose `baseUrl` is the loopback HQ Edge endpoint.
 * `tools` is the DSH node runtime tool registry.
 * `systemPrompt` is for registering the freerouting system-prompt section.
 * `webServer` is for registering the run status/output HTTP API.
 * `jobs` is for running background routing jobs.
 */
export const inject = ['hqEdge', 'tools', 'systemPrompt', 'webServer', 'jobs'] as const

export type { Config, ResolvedConfig } from './config.js'
export { Config as ConfigSchema } from './config.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Provided by the hq-edge `edge-bridge` plugin (the HOST). `baseUrl` is the
     * loopback HQ Edge endpoint, e.g. "http://localhost:18080". This is a
     * REQUIRED inject: `apply()` reads `ctx.hqEdge` to resolve the endpoint.
     */
    hqEdge: { baseUrl?: string }
  }
}

/** Shared component name for the unified DSH-plugin log. */
const COMPONENT = 'dsh-tool-freerouting'
const log = getLogger(COMPONENT)

/**
 * Host plugin body — register routing tools, web server, and system prompt.
 *
 * @param ctx - real cordis context (node side).
 * @returns disposer — unregisters the tools on plugin dispose.
 */
export function apply(ctx: Context, config: Partial<Config> = {}): () => void {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error(
      '@huaqiu/dsh-tool-freerouting requires the DSH `tools` service (ctx.tools.register).',
    )
  }

  log.info('applying dsh-tool-freerouting node half')

  // The runtime apply is async (it sets up background services), but we need
  // to return a sync disposer from the cordis `apply`. We fire-and-forget the
  // async setup and capture the disposer when it resolves.
  let runtimeDispose: (() => void) | undefined
  const setupPromise = applyRuntime(ctx, config as Config).then(
    (dispose) => {
      runtimeDispose = dispose
      log.info('dsh-tool-freerouting node half ready')
    },
    (err) => {
      log.error('dsh-tool-freerouting setup failed', { error: String(err) })
    },
  )

  return () => {
    // If setup hasn't completed yet, wait for it before disposing.
    setupPromise.finally(() => {
      try {
        runtimeDispose?.()
      } catch {
        // best-effort teardown
      }
    })
  }
}
