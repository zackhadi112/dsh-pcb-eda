import { Buffer } from 'node:buffer';

import {
  identifierSchema,
  type JobOutput,
  jobOutputSchema,
  type JobStatus,
  jobStatusSchema,
} from './upstream-contracts.js';
import { UpstreamServiceError } from './upstream-errors.js';

export interface FreeroutingClientOptions {
  baseUrl: string;
  environmentHost: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  profileEmail: string;
  profileId: string;
  requestTimeoutMs: number;
}

export interface RouteParameters {
  drawtimeSec: number;
  fast: boolean;
  realtime: boolean;
  routeOnlyNets: string[];
}

export interface RouteHandlers {
  /** Called whenever the FreeRouting job state changes. */
  onState?: (state: string, percentage?: number) => void;
  /**
   * Called on every poll tick (not only on state changes) with the latest percentage,
   * state, and any live `statistics`, so the run can publish smooth realtime progress
   * instead of freezing between state transitions.
   */
  onProgress?: (progress: RouteProgress) => void;
  /** Called with each intermediate SES (base64) while the job is RUNNING. */
  onIntermediate?: (sesBase64: string) => Promise<void> | void;
}

/** One poll tick's worth of progress, forwarded through `RouteHandlers.onProgress`. */
export interface RouteProgress {
  percentage?: number;
  state: string;
  statistics?: Record<string, unknown>;
  /** Monotonic poll-tick counter, starting at 1 for the first observed status. */
  ticks: number;
}

export interface RouteOutcome {
  sesBase64: string;
  state: string;
  statistics?: Record<string, unknown>;
}

export type FreeroutingJobState =
  | 'INVALID'
  | 'QUEUED'
  | 'READY_TO_START'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'TIMED_OUT'
  | 'CANCELLED'
  | 'TERMINATED';

const TERMINAL_STATES = new Set(['COMPLETED', 'TIMED_OUT', 'CANCELLED', 'TERMINATED', 'INVALID']);
const MIN_INTERMEDIATE_BYTES = 100;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(cleanup, ms);
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cleanup);
      resolve();
    }
    signal?.addEventListener('abort', cleanup, { once: true });
  });
}

function extractSesBase64(output: JobOutput): string {
  return output.data ?? output.dataBase64 ?? output.output ?? output.ses ?? '';
}

/**
 * Server-side FreeRouting `/v1` client. Mirrors the proven flow from the Python
 * plugin (`freerouting_io/http.py`) and NextChat (`app/utils/freerouting-client.ts`):
 * session -> enqueue -> upload(base64) -> settings -> start -> poll -> output.
 *
 * Connects directly to the FreeRouting engine at `http://127.0.0.1:37864`.
 */
export class FreeroutingClient {
  private sessionId: string | undefined;

  constructor(private readonly options: FreeroutingClientOptions) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Freerouting-Profile-ID': this.options.profileId,
      'Freerouting-Profile-Email': this.options.profileEmail,
      'Freerouting-Environment-Host': this.options.environmentHost,
    };
  }

  private timeoutSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(`${this.options.baseUrl}/v1${path}`, {
      method,
      headers: this.headers(),
      signal: this.timeoutSignal(signal),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new UpstreamServiceError(
        'FREEROUTING_REQUEST_FAILED',
        response.status,
        `FreeRouting ${method} ${path} failed: ${response.status} ${text.slice(0, 200)}`,
      );
    }
    const raw = await response.text();
    return (raw.length > 0 ? JSON.parse(raw) : {}) as T;
  }

  async checkStatus(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.request('GET', '/system/status', undefined, signal);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureSession(signal?: AbortSignal): Promise<string> {
    if (this.sessionId !== undefined) {
      return this.sessionId;
    }
    try {
      const list = await this.request<unknown>('GET', '/sessions/list', undefined, signal);
      if (Array.isArray(list) && list.length > 0 && typeof list[0] === 'string') {
        this.sessionId = list[0];
        return this.sessionId;
      }
    } catch {
      // fall through and create a fresh session
    }
    const created = identifierSchema.parse(
      await this.request('POST', '/sessions/create', {}, signal),
    );
    const sessionId = created.id ?? created.session_id;
    if (sessionId === undefined || sessionId === '') {
      throw new UpstreamServiceError(
        'FREEROUTING_SESSION_FAILED',
        502,
        'FreeRouting could not create a routing session',
      );
    }
    this.sessionId = sessionId;
    return sessionId;
  }

  /**
   * Run one routing job to completion. `dsnBase64` is the Specctra DSN exported from
   * KiCad; `routeOnlyNets` empty means whole-board routing.
   */
  async route(
    filename: string,
    dsnBase64: string,
    parameters: RouteParameters,
    handlers: RouteHandlers,
    signal?: AbortSignal,
  ): Promise<RouteOutcome> {
    if (!(await this.checkStatus(signal))) {
      throw new UpstreamServiceError(
        'FREEROUTING_UNAVAILABLE',
        503,
        `FreeRouting service is not reachable at ${this.options.baseUrl}`,
      );
    }
    const sessionId = await this.ensureSession(signal);

    const enqueued = identifierSchema.parse(
      await this.request(
        'POST',
        '/jobs/enqueue',
        { name: filename, priority: 'NORMAL', session_id: sessionId },
        signal,
      ),
    );
    const jobId = enqueued.id ?? enqueued.job_id;
    if (jobId === undefined || jobId === '') {
      throw new UpstreamServiceError(
        'FREEROUTING_ENQUEUE_FAILED',
        502,
        'FreeRouting could not enqueue the routing job',
      );
    }

    try {
      await this.request('POST', `/jobs/${jobId}/input`, { data: dsnBase64, filename }, signal);

      // Settings must be applied AFTER the DSN upload: FreeRouting rebuilds the
      // RouterSettings during uploadInput and would reset anything set earlier.
      const settings: Record<string, unknown> = {};
      if (parameters.fast) {
        settings.algorithm = 'freerouting-router/fast';
      }
      if (parameters.routeOnlyNets.length > 0) {
        settings.route_only_nets = parameters.routeOnlyNets;
      }
      if (Object.keys(settings).length > 0) {
        await this.request('POST', `/jobs/${jobId}/settings`, settings, signal);
      }

      await this.request('PUT', `/jobs/${jobId}/start`, undefined, signal);
      return await this.poll(jobId, parameters, handlers, signal);
    } catch (cause) {
      if (signal?.aborted) {
        await this.cancel(jobId);
      }
      throw cause;
    }
  }

  private async poll(
    jobId: string,
    parameters: RouteParameters,
    handlers: RouteHandlers,
    signal?: AbortSignal,
  ): Promise<RouteOutcome> {
    const deadline = Date.now() + this.options.pollTimeoutMs;
    const drawIntervalMs = Math.max(1, parameters.drawtimeSec) * 1000;
    let lastState = '';
    let lastDrawAt = 0;
    let ticks = 0;

    for (;;) {
      if (signal?.aborted) {
        await this.cancel(jobId);
        throw new UpstreamServiceError('RUN_CANCELLED', 499, 'The routing run was cancelled');
      }
      if (Date.now() > deadline) {
        await this.cancel(jobId);
        throw new UpstreamServiceError(
          'FREEROUTING_TIMEOUT',
          504,
          `FreeRouting job did not finish within ${Math.round(this.options.pollTimeoutMs / 1000)}s`,
        );
      }

      const status: JobStatus = jobStatusSchema.parse(
        await this.request('GET', `/jobs/${jobId}`, undefined, signal),
      );
      const state = String(status.state ?? status.status ?? '').toUpperCase();
      const percentage = status.progress_percentage ?? status.progress;
      ticks += 1;
      handlers.onProgress?.({
        ...(percentage === undefined ? {} : { percentage }),
        state,
        ...(status.statistics === undefined ? {} : { statistics: status.statistics }),
        ticks,
      });
      if (state !== lastState) {
        lastState = state;
        handlers.onState?.(state, percentage);
      }

      if (TERMINAL_STATES.has(state)) {
        if (state !== 'COMPLETED') {
          throw new UpstreamServiceError(
            'FREEROUTING_JOB_FAILED',
            502,
            `FreeRouting job ended in state ${state || 'UNKNOWN'}`,
          );
        }
        break;
      }

      if (parameters.realtime && state === 'RUNNING') {
        const now = Date.now();
        if (now - lastDrawAt >= drawIntervalMs) {
          lastDrawAt = now;
          const intermediate = await this.tryOutput(jobId, signal);
          if (intermediate !== undefined) {
            await handlers.onIntermediate?.(intermediate);
          }
        }
      }

      await abortableSleep(this.options.pollIntervalMs, signal);
    }

    const output: JobOutput = jobOutputSchema.parse(
      await this.request('GET', `/jobs/${jobId}/output`, undefined, signal),
    );
    const sesBase64 = extractSesBase64(output);
    if (sesBase64 === '') {
      throw new UpstreamServiceError(
        'FREEROUTING_EMPTY_OUTPUT',
        502,
        'FreeRouting completed but returned an empty SES output',
      );
    }
    return {
      sesBase64,
      state: 'COMPLETED',
      ...(output.statistics === undefined ? {} : { statistics: output.statistics }),
    };
  }

  private async tryOutput(jobId: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const output: JobOutput = jobOutputSchema.parse(
        await this.request('GET', `/jobs/${jobId}/output`, undefined, signal),
      );
      const sesBase64 = extractSesBase64(output);
      if (sesBase64 !== '' && Buffer.from(sesBase64, 'base64').length >= MIN_INTERMEDIATE_BYTES) {
        return sesBase64;
      }
    } catch {
      // No intermediate output yet; ignore and keep polling.
    }
    return undefined;
  }

  /** Best-effort cancel that never uses the (possibly aborted) run signal. */
  async cancel(jobId: string): Promise<void> {
    try {
      await this.request('PUT', `/jobs/${jobId}/cancel`, undefined, undefined);
    } catch {
      // Cancelling is best effort; ignore failures.
    }
  }
}

export type { FreeroutingJobState as JobState };
