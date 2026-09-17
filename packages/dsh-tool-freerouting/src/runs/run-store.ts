import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Agent } from '@deepseek-ai/dsh-agent';

import type {
  RouteParameters,
  RunError,
  RunOutput,
  RunProgress,
  RunRecord,
  RunState,
  RoutingAlgorithm,
} from './contracts.js';

interface RunStoreOptions {
  maxPendingRuns: number;
  resultTtlMs: number;
}

export class RunStoreError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
    this.name = 'RunStoreError';
  }
}

function tokenEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isActive(state: RunState): boolean {
  return state === 'queued' || state === 'running';
}

/**
 * In-memory routing run registry. Unlike the autoplacement store there is no upload
 * phase: a run is created directly in `queued` and the DSN is pulled from KiCad by the
 * background job, so the browser only ever reads status/output.
 */
export class RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: RunStoreOptions) {
    this.timer = setInterval(() => this.cleanup(), Math.min(options.resultTtlMs, 60_000));
    this.timer.unref?.();
  }

  create(
    algorithm: RoutingAlgorithm,
    parameters: RouteParameters,
    owner: Agent,
  ): RunRecord {
    const pending = [...this.runs.values()].filter((run) => isActive(run.state)).length;
    if (pending >= this.options.maxPendingRuns) {
      throw new RunStoreError(
        'RUN_CAPACITY_EXCEEDED',
        429,
        'The plugin has too many routing runs in progress',
      );
    }

    const now = Date.now();
    const run: RunRecord = {
      algorithm,
      createdAt: now,
      expiresAt: now + this.options.resultTtlMs,
      id: randomUUID(),
      owner,
      ownerSessionId: owner.id,
      parameters,
      state: 'queued',
      token: randomBytes(32).toString('base64url'),
      updatedAt: now,
    };
    this.runs.set(run.id, run);
    return run;
  }

  authorize(id: string, token: string): RunRecord | undefined {
    const run = this.runs.get(id);
    if (run === undefined || run.state === 'expired' || run.expiresAt <= Date.now()) {
      return undefined;
    }
    return tokenEquals(run.token, token) ? run : undefined;
  }

  require(id: string): RunRecord {
    const run = this.runs.get(id);
    if (run === undefined) {
      throw new RunStoreError('RUN_NOT_FOUND', 404, 'The routing run was not found');
    }
    return run;
  }

  setJobId(id: string, jobId: string): void {
    const run = this.require(id);
    run.jobId = jobId;
    run.updatedAt = Date.now();
  }

  running(id: string): void {
    this.transition(this.require(id), 'running');
  }

  setProgress(id: string, progress: RunProgress): void {
    const run = this.require(id);
    run.progress = progress;
    run.updatedAt = Date.now();
  }

  /** Replace the run's rolling, user-visible log (already capped by the caller). */
  setLog(id: string, log: readonly string[]): void {
    const run = this.require(id);
    run.log = [...log];
    run.updatedAt = Date.now();
  }

  succeed(id: string, output: RunOutput): void {
    const run = this.require(id);
    run.output = output;
    delete run.error;
    run.expiresAt = Date.now() + this.options.resultTtlMs;
    this.transition(run, 'succeeded');
  }

  fail(id: string, error: RunError): void {
    const run = this.require(id);
    run.error = error;
    run.expiresAt = Date.now() + this.options.resultTtlMs;
    this.transition(run, 'failed');
  }

  cancel(id: string): void {
    const run = this.require(id);
    run.expiresAt = Date.now() + this.options.resultTtlMs;
    this.transition(run, 'cancelled');
  }

  cleanup(now = Date.now()): void {
    for (const [id, run] of this.runs) {
      if (run.expiresAt > now || isActive(run.state)) {
        continue;
      }
      run.state = 'expired';
      this.runs.delete(id);
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.runs.clear();
  }

  private transition(run: RunRecord, state: RunState): void {
    run.state = state;
    run.updatedAt = Date.now();
  }
}
