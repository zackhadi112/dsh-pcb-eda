import type { Context } from '@deepseek-ai/cordis';

import type { RunService } from '../runs/run-service.js';
import type { RunStore } from '../runs/run-store.js';
import { createRouteNetsTool } from './pcb-route-nets-tool.js';
import { createRouteTool } from './pcb-route-tool.js';

export function registerFreeroutingTools(
  ctx: Context,
  runs: RunStore,
  runService: RunService,
  routePrefix: string,
): Array<() => void> {
  return [
    ctx.tools.register(createRouteTool(runs, runService, routePrefix)),
    ctx.tools.register(createRouteNetsTool(runs, runService, routePrefix)),
  ];
}
