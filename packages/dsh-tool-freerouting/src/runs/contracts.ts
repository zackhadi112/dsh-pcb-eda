import type { Agent } from '@deepseek-ai/dsh-agent';

export type RoutingAlgorithm = 'route' | 'route-nets';

export interface RouteParameters {
  drawtimeSec: number;
  /**
   * After routing completes, fill all copper zones on the board. Useful when GND
   * was skipped (left for a copper pour) — the zones connect what the router left.
   */
  fillZonesAfterRoute: boolean;
  fast: boolean;
  realtime: boolean;
  /**
   * Nets to exclude from a whole-board run (e.g. GND, left for a copper pour/zone).
   * Only applied when `routeOnlyNets` is empty (whole-board scope); the server parses
   * the exported DSN's net list and routes the difference.
   */
  skipNets: string[];
  routeOnlyNets: string[];
}

export type RunState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface RunProgress {
  /** Distinct nets that have copper so far (from the latest intermediate session). */
  nets?: number;
  percentage?: number;
  /** Realtime intermediate sessions streamed back into KiCad so far. */
  refreshes?: number;
  /** Track segments counted in the latest intermediate session. */
  segments?: number;
  state: string;
  /** Vias counted in the latest intermediate session. */
  vias?: number;
  /** Live DRC violations from FreeRouting's status `statistics`, when reported. */
  violations?: number;
}

export interface RoutingResult {
  durationMs: number;
  imported: boolean;
  netCount: number;
  /** Imported tracks the Bridge reported as lying outside the board outline. */
  outsideBoard?: number;
  /** How many realtime intermediate sessions were streamed back while routing. */
  refreshes?: number;
  /** Target nets that received copper in the final session (net-level successes). */
  routedNets?: number;
  statistics?: Record<string, unknown>;
  tracks: number;
  /** Target nets left unrouted, capped for payload size (net-level failures). */
  unroutedNetNames?: string[];
  /** Count of target nets left unrouted. */
  unroutedNets?: number;
  vias: number;
  /** DRC violations reported by FreeRouting, when available. */
  violations?: number;
  /** User-facing caveat (board-edge overflow, degraded realtime preview, …). */
  warning?: string;
  /** Copper zones auto-created for the skipped pour nets (only when fillZonesAfterRoute). */
  zonesCreated?: number;
  /** Copper zones filled after routing (only present when `fillZonesAfterRoute` was true). */
  zonesFilled?: number;
}

export interface RunOutput {
  content: Uint8Array;
  contentType: 'text/plain; charset=utf-8';
  filename: string;
  routing: RoutingResult;
}

export interface RunError {
  code: string;
  message: string;
  status: number;
}

export interface RunRecord {
  algorithm: RoutingAlgorithm;
  createdAt: number;
  error?: RunError;
  expiresAt: number;
  id: string;
  jobId?: string;
  /** Rolling, user-visible Chinese log of the run's milestones (capped server-side). */
  log?: string[];
  output?: RunOutput;
  owner: Agent;
  ownerSessionId: string;
  parameters: RouteParameters;
  progress?: RunProgress;
  state: RunState;
  token: string;
  updatedAt: number;
}

export interface RunStatusResponse {
  algorithm: RoutingAlgorithm;
  created_at: string;
  error?: RunError;
  expires_at: string;
  job_id?: string;
  log?: string[];
  output_name?: string;
  progress?: RunProgress;
  run_id: string;
  schema_version: 1;
  state: RunState;
  summary?: {
    duration_ms: number;
    imported: boolean;
    net_count: number;
    outside_board?: number;
    refreshes?: number;
    routed_nets?: number;
    statistics?: Record<string, unknown>;
    tracks: number;
    unrouted_net_names?: string[];
    unrouted_nets?: number;
    vias: number;
    violations?: number;
    warning?: string;
    zones_created?: number;
    zones_filled?: number;
  };
  updated_at: string;
}

export function statusResponse(run: RunRecord): RunStatusResponse {
  const routing = run.output?.routing;
  return {
    algorithm: run.algorithm,
    created_at: new Date(run.createdAt).toISOString(),
    expires_at: new Date(run.expiresAt).toISOString(),
    run_id: run.id,
    schema_version: 1,
    state: run.state,
    updated_at: new Date(run.updatedAt).toISOString(),
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.jobId === undefined ? {} : { job_id: run.jobId }),
    ...(run.log === undefined ? {} : { log: [...run.log] }),
    ...(run.output === undefined ? {} : { output_name: run.output.filename }),
    ...(run.progress === undefined ? {} : { progress: run.progress }),
    ...(routing === undefined
      ? {}
      : {
          summary: {
            duration_ms: routing.durationMs,
            imported: routing.imported,
            net_count: routing.netCount,
            ...(routing.outsideBoard === undefined ? {} : { outside_board: routing.outsideBoard }),
            ...(routing.refreshes === undefined ? {} : { refreshes: routing.refreshes }),
            ...(routing.routedNets === undefined ? {} : { routed_nets: routing.routedNets }),
            ...(routing.statistics === undefined ? {} : { statistics: routing.statistics }),
            tracks: routing.tracks,
            ...(routing.unroutedNetNames === undefined
              ? {}
              : { unrouted_net_names: [...routing.unroutedNetNames] }),
            ...(routing.unroutedNets === undefined ? {} : { unrouted_nets: routing.unroutedNets }),
            vias: routing.vias,
            ...(routing.violations === undefined ? {} : { violations: routing.violations }),
            ...(routing.warning === undefined ? {} : { warning: routing.warning }),
            ...(routing.zonesCreated === undefined
              ? {}
              : { zones_created: routing.zonesCreated }),
            ...(routing.zonesFilled === undefined ? {} : { zones_filled: routing.zonesFilled }),
          },
        }),
  };
}
