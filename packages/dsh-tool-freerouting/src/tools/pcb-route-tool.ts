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

export function createRouteTool(runs: RunStore, runService: RunService, routePrefix: string) {
  return defineTool({
    name: 'pcb_route',
    description:
      'Autoroute the entire currently open KiCad PCB board with FreeRouting. The server pulls the board DSN straight out of KiCad, runs the router in the background, streams progress into the board, and imports the finished session back. Use this for whole-board routing; no file selection is needed.',
    parameters: {
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
      skip_nets: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Net names to leave unrouted for a later copper pour/zone (default GND). Pass an empty array to route every net.',
        default: ['GND'],
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
      const run = runs.create(
        'route',
        {
          drawtimeSec: integerInRange(args.drawtime_sec, 15, 1, 60, 'drawtime_sec'),
          fast: args.fast ?? false,
          fillZonesAfterRoute: args.fill_zones ?? true,
          realtime: args.realtime ?? true,
          routeOnlyNets: [],
          skipNets: normalizedNets(args.skip_nets ?? ['GND']),
        },
        requireAgent(exec.agent),
      );
      runService.start(run);
      return createdRunOutput(run, routePrefix, 'Whole-board autorouting');
    },
    presentCall: () => ({ card: 'generic', title: 'Route the whole board', kind: 'execute' }),
  });
}
