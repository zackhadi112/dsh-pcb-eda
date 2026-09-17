import { defineTool } from '@deepseek-ai/dsh-tools';

import type { RunService } from '../runs/run-service.js';
import type { RunStore } from '../runs/run-store.js';
import {
  createdRunOutput,
  integerInRange,
  normalizedNets,
  openObject,
  render,
  requireAgent,
  runMeta,
} from './presentation.js';

export function createRouteNetsTool(runs: RunStore, runService: RunService, routePrefix: string) {
  return defineTool({
    name: 'pcb_route_nets',
    description:
      'Autoroute only the given nets on the currently open KiCad PCB board with FreeRouting. The server pulls the board DSN straight out of KiCad, routes just the listed nets in the background, streams progress into the board, and imports the finished session back. Provide one or more exact, non-empty net names.',
    parameters: {
      nets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact net names to route; at least one is required',
      },
      realtime: {
        type: 'boolean',
        description: 'Stream intermediate routing back into KiCad while the job runs',
        default: true,
      },
      drawtime_sec: {
        type: 'integer',
        description: 'Routing effort per pass in seconds, from 1 to 60',
        default: 15,
      },
      fast: {
        type: 'boolean',
        description: 'Use the faster routing algorithm (set true for speed, false for higher quality; default is quality)',
        default: false,
      },
      fill_zones: {
        type: 'boolean',
        description:
          'After routing, auto-create copper zones for the skipped pour nets (default GND) on all copper layers and fill them — same effect as the KiCad plugin. The pour runs only when every routed net succeeded; if any net is left unrouted (or success cannot be confirmed) the pour is skipped so failures are not buried under copper. Default true.',
        default: true,
      },
    },
    output: {
      schema: openObject,
      render,
      presentationMeta: (_args, value) => runMeta(value, routePrefix),
    },
    async execute(args, exec) {
      const routeOnlyNets = normalizedNets(args.nets);
      if (routeOnlyNets.length === 0) {
        throw new Error('pcb_route_nets requires at least one non-empty net name');
      }
      const run = runs.create(
        'route-nets',
        {
          drawtimeSec: integerInRange(args.drawtime_sec, 15, 1, 60, 'drawtime_sec'),
          fast: args.fast ?? false,
          fillZonesAfterRoute: args.fill_zones ?? true,
          realtime: args.realtime ?? true,
          routeOnlyNets,
          skipNets: [],
        },
        requireAgent(exec.agent),
      );
      runService.start(run);
      return createdRunOutput(run, routePrefix, 'Partial autorouting');
    },
    presentCall: () => ({ card: 'generic', title: 'Route selected nets', kind: 'execute' }),
  });
}
