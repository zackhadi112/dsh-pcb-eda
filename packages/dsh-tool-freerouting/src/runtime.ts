import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-jobs';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-tools';

import type { Config } from './config.js';
import { resolveConfig } from './config.js';
import { createRunHttpRuntime } from './http/server.js';
import { FreeroutingClient } from './proxy/freerouting-client.js';
import { HqEdgeKicadClient } from './proxy/hq-edge-kicad-client.js';
import { FreeroutingLauncher } from './runs/launcher.js';
import { RunService } from './runs/run-service.js';
import { RunStore } from './runs/run-store.js';
import { FREEROUTING_PROMPT } from './system-prompt.js';
import { registerFreeroutingTools } from './tools/register-tools.js';

/**
 * Plugin body — wire up all services and register tools.
 *
 * KiCad communication goes through hq-edge (`HqEdgeKicadClient`), whose base URL
 * is resolved lazily from `ctx.hqEdge.baseUrl` (the edge-bridge HOST service).
 * FreeRouting is connected directly at `freeroutingBaseUrl` (default `:37864`).
 */
export async function apply(ctx: Context, config: Config): Promise<() => void> {
  const resolved = resolveConfig(config);

  // Late-bound hq-edge endpoint: prefer the edge-bridge service, then the overlay
  // config / env value. Consulted on every request (see HqEdgeKicadClient).
  const getHqEdgeBaseUrl = (): string | undefined => {
    const hq = ctx.hqEdge;
    return hq?.baseUrl && hq.baseUrl.trim().length > 0 ? hq.baseUrl : undefined;
  };

  const runs = new RunStore(resolved);
  const freerouting = new FreeroutingClient({
    baseUrl: resolved.freeroutingBaseUrl,
    environmentHost: resolved.environmentHost,
    pollIntervalMs: resolved.pollIntervalMs,
    pollTimeoutMs: resolved.pollTimeoutMs,
    profileEmail: resolved.profileEmail,
    profileId: resolved.profileId,
    requestTimeoutMs: resolved.requestTimeoutMs,
  });
  const bridge = new HqEdgeKicadClient({
    baseUrl: resolved.hqEdgeBaseUrl,
    baseUrlResolver: getHqEdgeBaseUrl,
    requestTimeoutMs: resolved.requestTimeoutMs,
  });
  const launcher = new FreeroutingLauncher({
    autoLaunch: resolved.autoLaunchFreerouting,
    baseUrl: resolved.freeroutingBaseUrl,
    launchTimeoutMs: resolved.freeroutingLaunchTimeoutMs,
    pollIntervalMs: resolved.pollIntervalMs,
    probe: (signal) => freerouting.checkStatus(signal),
  });
  const runService = new RunService(ctx, runs, freerouting, bridge, launcher);
  const http = createRunHttpRuntime(runs, resolved.routePrefix);

  ctx.webServer.register({
    kind: 'prefix',
    path: resolved.routePrefix,
    handler: http.handler,
  });
  ctx.systemPrompt.section({
    name: 'tool:pcb-freerouting',
    order: 130,
    text: FREEROUTING_PROMPT,
  });
  const disposeTools = registerFreeroutingTools(ctx, runs, runService, resolved.routePrefix);

  const hqEdgeUrl = getHqEdgeBaseUrl() ?? resolved.hqEdgeBaseUrl ?? '(not yet resolved)';
  ctx.logger.info(
    `PCB FreeRouting service: ${resolved.freeroutingBaseUrl} (hq-edge ${hqEdgeUrl})`,
  );

  return () => {
    for (const dispose of disposeTools.reverse()) {
      dispose();
    }
    runService.dispose();
    runs.dispose();
    launcher.gracefulShutdown();
  };
}
