import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';
import type { JobOutcome } from '@deepseek-ai/dsh-jobs';

import type { FreeroutingClient, RouteProgress } from '../proxy/freerouting-client.js';
import type { KicadUpstreamClient } from '../proxy/kicad-upstream-interface.js';
import { runError, UpstreamServiceError } from '../proxy/upstream-errors.js';
import type { RouteParameters, RunOutput, RunRecord, RoutingResult } from './contracts.js';
import { assessImportGeometry } from './import-geometry.js';
import type { FreeroutingLauncher } from './launcher.js';
import type { RunStore } from './run-store.js';
import {
  countSes,
  describeRoutingSummary,
  normalizeStatistics,
  parseDsnNetNames,
  parseDsnNetPinCounts,
  type SesCounters,
  summarizeRouting,
} from './statistics.js';

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'pcb-freerouting': 'pcb-freerouting';
  }
}

/** Cap on the rolling user-visible run log, so a long route cannot grow it forever. */
const MAX_LOG_LINES = 20;
/** Cap on a single log line, so one verbose upstream message cannot dominate the log. */
const MAX_LOG_LINE_CHARS = 200;

/**
 * Build a concise Chinese summary from a RoutingResult for the job's `detail` field.
 * The DSH framework renders `detail` into the status line that the LLM sees in its
 * context injection (e.g. `[status: completed, 走线 512 段，过孔 18 个]`), so a
 * human-readable detail lets the LLM report real statistics instead of just "completed".
 */
function formatRoutingDetail(routing: RoutingResult): string {
  const parts: string[] = [];
  if (routing.routedNets !== undefined) {
    parts.push(`布通 ${routing.routedNets}/${routing.netCount} 网络`);
  }
  parts.push(`走线 ${routing.tracks} 段`);
  parts.push(`过孔 ${routing.vias} 个`);
  if (routing.unroutedNets !== undefined && routing.unroutedNets > 0) {
    parts.push(`未布通 ${routing.unroutedNets} 个`);
  }
  if (routing.violations !== undefined && routing.violations > 0) {
    parts.push(`违规 ${routing.violations} 处`);
  }
  if (routing.zonesCreated !== undefined && routing.zonesCreated > 0) {
    parts.push(`新建铺铜 ${routing.zonesCreated} 个`);
  }
  parts.push(`用时 ${Math.round(routing.durationMs / 1000)} 秒`);
  return parts.join('，');
}

/**
 * Human-readable Chinese label for a FreeRouting job state. `RunProgress.state` and the
 * run log show this instead of the raw upstream enum.
 */
function upstreamStateText(state: string): string {
  switch (state.toUpperCase()) {
    case 'CANCELLED': {
      return '任务已取消';
    }
    case 'COMPLETED': {
      return '已完成';
    }
    case 'IMPORTING': {
      return '正在导回 KiCad';
    }
    case 'INVALID': {
      return '任务无效';
    }
    case 'PAUSED': {
      return '已暂停';
    }
    case 'PREPARING': {
      return '正在准备';
    }
    case 'QUEUED': {
      return '排队中';
    }
    case 'READY_TO_START': {
      return '等待启动';
    }
    case 'RUNNING': {
      return '布线中';
    }
    case 'TERMINATED': {
      return '已终止';
    }
    case 'TIMED_OUT': {
      return '超时';
    }
    default: {
      return state;
    }
  }
}

/**
 * Drives one routing run end to end inside a DSH background job:
 * export the KiCad board DSN → run the FreeRouting job (streaming intermediate
 * sessions back into KiCad) → import the final SES → let the Bridge confirm the
 * imported tracks stayed inside the board outline. The job is cancellable through
 * the AbortController wired to `ctx.jobs`.
 *
 * KiCad communication goes through hq-edge (base64 data exchange, no shared
 * filesystem paths). FreeRouting is connected directly at `:37864`.
 */
export class RunService {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly ctx: Context,
    private readonly runs: RunStore,
    private readonly freerouting: FreeroutingClient,
    private readonly bridge: KicadUpstreamClient,
    private readonly launcher?: FreeroutingLauncher,
  ) {}

  start(run: RunRecord): string {
    const controller = new AbortController();
    try {
      const jobId = this.ctx.jobs.start({
        kind: 'pcb-freerouting',
        label: `PCB ${run.algorithm === 'route' ? 'whole-board routing' : 'partial routing'}`,
        outputLimitBytes: 16 * 1024,
        owner: run.owner,
        run: () => {
          this.controllers.set(run.id, controller);
          return {
            cancel: (reason) => controller.abort(reason),
            done: this.execute(run, controller.signal),
          };
        },
      });
      this.runs.setJobId(run.id, jobId);
      return jobId;
    } catch (cause) {
      this.runs.fail(run.id, {
        code: 'JOB_START_FAILED',
        message:
          cause instanceof Error ? cause.message : 'The DSH background job could not start',
        status: 503,
      });
      throw cause;
    }
  }

  dispose(): void {
    for (const controller of this.controllers.values()) {
      controller.abort('plugin disposed');
    }
    this.controllers.clear();
  }

  /**
   * Build the run's rolling, user-visible logger. Each call appends one Chinese line to
   * `RunRecord.log` (capped) and mirrors it to the host logger.
   */
  private createLog(runId: string): (message: string) => void {
    const lines: string[] = [];
    const shortId = runId.slice(0, 8);
    return (message: string) => {
      const line =
        message.length > MAX_LOG_LINE_CHARS
          ? `${message.slice(0, MAX_LOG_LINE_CHARS - 1)}…`
          : message;
      lines.push(line);
      if (lines.length > MAX_LOG_LINES) {
        lines.splice(0, lines.length - MAX_LOG_LINES);
      }
      try {
        this.ctx.logger.info(`[pcb-freerouting] run ${shortId}: ${line}`);
      } catch {
        // A missing/broken host logger must never interrupt routing.
      }
      try {
        this.runs.setLog(runId, lines);
      } catch {
        // The run may already be gone (expired/disposed); the log is best-effort.
      }
    };
  }

  private async execute(run: RunRecord, signal: AbortSignal): Promise<JobOutcome> {
    this.runs.running(run.id);
    const record = this.createLog(run.id);
    const startedAt = Date.now();
    try {
      const output = await this.route(run, signal, startedAt, record);
      this.runs.succeed(run.id, output);
      return {
        detail: formatRoutingDetail(output.routing),
        output: JSON.stringify({
          run_id: run.id,
          state: 'succeeded',
          summary: {
            net_count: output.routing.netCount,
            routed_nets: output.routing.routedNets,
            tracks: output.routing.tracks,
            unrouted_nets: output.routing.unroutedNets,
            vias: output.routing.vias,
          },
        }),
        status: 'completed',
      };
    } catch (cause) {
      if (signal.aborted) {
        record('布线已取消');
        this.runs.cancel(run.id);
        return { detail: 'cancelled', status: 'killed' };
      }
      try {
        this.ctx.logger.info(
          `[pcb-freerouting] run ${run.id} failed: ${
            cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
          }`,
        );
      } catch {
        // A missing/broken host logger must never mask the real failure below.
      }
      const error = runError(cause);
      record(`布线失败：${error.message}`);
      this.runs.fail(run.id, error);
      return {
        detail: `布线失败：${error.message}`,
        output: JSON.stringify({ error, log: run.log ?? [], run_id: run.id, state: 'failed' }),
        status: 'failed',
      };
    } finally {
      this.controllers.delete(run.id);
    }
  }

  private async route(
    run: RunRecord,
    signal: AbortSignal,
    startedAt: number,
    record: (message: string) => void,
  ): Promise<RunOutput> {
    const requested = run.parameters as RouteParameters;
    let intermediateFailures = 0;
    let refreshes = 0;
    let sample: RouteProgress | undefined;
    let live: SesCounters | undefined;

    // Merge the latest poll tick, the latest intermediate-session counters, and the live
    // DRC statistics into one RunProgress and publish it.
    const publish = (): void => {
      const percentage = sample?.percentage;
      const violations = normalizeStatistics(sample?.statistics).violations;
      this.runs.setProgress(run.id, {
        ...(percentage === undefined ? {} : { percentage }),
        ...(refreshes === 0 ? {} : { refreshes }),
        ...(live === undefined ? {} : { segments: live.segments, vias: live.vias }),
        ...(live === undefined || live.nets.length === 0 ? {} : { nets: live.nets.length }),
        ...(violations === undefined ? {} : { violations }),
        state: upstreamStateText(sample?.state ?? 'PREPARING'),
      });
    };

    record(
      run.algorithm === 'route'
        ? '开始整板布线'
        : `开始局部布线（${requested.routeOnlyNets.length} 个网络）`,
    );

    // 1. Pull the current board DSN straight out of KiCad via hq-edge (base64 exchange).
    // After a board switch the Bridge's cached board can be momentarily stale, so
    // re-bind (ensureBoard) and retry the export a few times before giving up.
    const dsnBytes = await this.exportDsnWithRetry(signal);
    if (dsnBytes.length === 0) {
      throw new UpstreamServiceError('EMPTY_DSN', 502, 'The board DSN exported from KiCad is empty');
    }
    const declaredNets = parseDsnNetNames(dsnBytes.toString('utf8'));
    // KiCad's DSN export lists single-pad pseudo-nets for pads without an electrical
    // net (`unconnected-(P5-Pad1)` for mounting holes, NC pins, spare pins). There is
    // nothing to route and FreeRouting never emits copper for them, so keeping them in
    // the target list used to report them as phantom "unrouted" nets.
    const pinCounts = parseDsnNetPinCounts(dsnBytes.toString('utf8'));
    const singlePadNets = declaredNets.filter((net) => (pinCounts.get(net) ?? 2) <= 1);
    const dsnNets = declaredNets.filter((net) => (pinCounts.get(net) ?? 2) > 1);
    if (singlePadNets.length > 0) {
      record(
        `忽略 ${singlePadNets.length} 个单焊盘网络（无需布线）：${singlePadNets.slice(0, 8).join(', ')}`,
      );
    }
    record(`DSN 导出：${Math.round(dsnBytes.length / 1024)} KB，${dsnNets.length} 个网络`);
    const parameters = this.applySkipNets(requested, dsnNets, record);
    const targetNets = parameters.routeOnlyNets.length > 0 ? parameters.routeOnlyNets : dsnNets;

    // 2. Run the FreeRouting job, streaming intermediate sessions into KiCad.
    // Make sure the FreeRouting service (:37864) is up first; when it is down and
    // auto-launch is enabled the launcher starts <KiCad>\bin\freerouting_plugin\start.bat
    // and waits for the port before the job is enqueued.
    await this.launcher?.ensureUp(record, signal);
    const outcome = await this.freerouting.route(
      'board.dsn',
      dsnBytes.toString('base64'),
      parameters,
      {
        onProgress: (progress) => {
          sample = progress;
          publish();
        },
        onIntermediate: async (sesBase64) => {
          refreshes += 1;
          const counters = countSes(Buffer.from(sesBase64, 'base64').toString('utf8'));
          live = counters;
          publish();
          record(
            `实时刷新 ${refreshes}：${counters.segments} 段走线 / ${counters.vias} 个过孔 / ${counters.nets.length} 个网络`,
          );
          try {
            // Import intermediate SES directly via hq-edge (base64, no file path).
            // skipNets (pour-only, e.g. GND) ride along so the Bridge also clears their
            // stale copper before every realtime frame, not just the final import.
            await this.bridge.importSession(sesBase64, requested.skipNets, signal);
          } catch (cause) {
            if (signal.aborted || (cause instanceof Error && cause.name === 'AbortError')) {
              throw cause;
            }
            intermediateFailures += 1;
            record(`实时刷新导入失败：${cause instanceof Error ? cause.message : String(cause)}`);
          }
        },
      },
      signal,
    );

    // 3. Import the authoritative final session via hq-edge (base64 exchange).
    const sesBytes = Buffer.from(outcome.sesBase64, 'base64');
    const imported = await this.bridge.importSession(outcome.sesBase64, requested.skipNets, signal);

    // Net-level routed/unrouted split.
    const ses = countSes(sesBytes.toString('utf8'));
    const summary = summarizeRouting({
      dsnNets,
      ses,
      ...(outcome.statistics === undefined ? {} : { statistics: outcome.statistics }),
      targetNets,
    });
    sample = { percentage: 100, state: 'IMPORTING', ticks: sample?.ticks ?? 0 };
    publish();

    // 4. Let the Bridge confirm the imported tracks stayed inside the board outline.
    const verdict = assessImportGeometry(imported.geometry);
    if (verdict.level === 'reject') {
      const reverted = await this.bridge
        .revertSession(signal)
        .then(() => true)
        .catch(() => false);
      throw new UpstreamServiceError(
        'ROUTING_OUTSIDE_BOARD',
        502,
        `${verdict.message}；${
          reverted
            ? '已撤销本次导入，板子恢复原状，请更新 KiCad 里的 FreeRouting 插件后重试'
            : '撤销导入失败，请在 KiCad 中手动删除板框外的走线'
        }`,
      );
    }

    const warnings: string[] = [];
    if (verdict.message !== undefined) {
      warnings.push(verdict.message);
    }
    if (intermediateFailures > 0) {
      warnings.push(`实时预览有 ${intermediateFailures} 次中间态导入失败（不影响最终结果）`);
    }

    // 5. Auto-create + fill copper zones after routing.
    // Strict gate: pour ONLY when every target net routed successfully.
    let zonesFilled: number | undefined;
    let zonesCreated: number | undefined;
    if (requested.fillZonesAfterRoute) {
      const unrouted = summary.unroutedNets;
      if (unrouted === undefined) {
        record('跳过铺铜：无法确认所有网络已布通（会话缺少网络归属），请手动填充铺铜');
        warnings.push(
          '无法确认布线是否全部完成，已跳过自动铺铜；请在 KiCad 中确认没有未布通连接后，手动执行"填充铺铜区域"',
        );
      } else if (unrouted > 0) {
        const names = summary.unroutedNetNames ?? [];
        record(
          `跳过铺铜：${unrouted} 个网络未布通${names.length > 0 ? `（${names.join(', ')}）` : ''}`,
        );
        warnings.push(
          `有 ${unrouted} 个网络未布通，已跳过自动铺铜；请先完成这些网络的布线，再执行"填充铺铜区域"`,
        );
      } else {
        try {
          const pourNets = requested.skipNets;
          const fillResult = await this.bridge.fillZones(pourNets, signal);
          zonesCreated = fillResult.zonesCreated ?? 0;
          zonesFilled = fillResult.zonesFilled ?? 0;
          if (zonesCreated > 0) {
            record(`自动创建铺铜：${pourNets.join(', ')} 共 ${zonesCreated} 个 zone`);
          }
          record(`铺铜完成：已填充 ${zonesFilled} 个铺铜区域`);
          for (const message of fillResult.errors ?? []) {
            warnings.push(`铺铜：${message}`);
          }
        } catch (cause) {
          if (signal.aborted || (cause instanceof Error && cause.name === 'AbortError')) {
            throw cause;
          }
          const message = cause instanceof Error ? cause.message : String(cause);
          record(`铺铜失败：${message}`);
          warnings.push(`铺铜失败，请手动在 KiCad 中执行"填充铺铜区域"`);
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    record(`布线完成，用时 ${Math.round(durationMs / 1000)} 秒`);
    record(describeRoutingSummary(summary, targetNets.length));
    record(
      `导回 KiCad：${imported.tracks ?? ses.segments} 条走线 / ${imported.vias ?? ses.vias} 个过孔`,
    );
    if (refreshes > 0) {
      record(`实时刷新共 ${refreshes} 次`);
    }

    const routing: RoutingResult = {
      durationMs,
      imported: imported.ok !== false,
      netCount: targetNets.length,
      ...(verdict.outside === 0 ? {} : { outsideBoard: verdict.outside }),
      ...(refreshes === 0 ? {} : { refreshes }),
      ...(summary.routedNets === undefined ? {} : { routedNets: summary.routedNets }),
      ...(outcome.statistics === undefined ? {} : { statistics: outcome.statistics }),
      tracks: imported.tracks ?? ses.segments,
      ...(summary.unroutedNetNames === undefined
        ? {}
        : { unroutedNetNames: summary.unroutedNetNames }),
      ...(summary.unroutedNets === undefined ? {} : { unroutedNets: summary.unroutedNets }),
      vias: imported.vias ?? ses.vias,
      ...(summary.violations === undefined ? {} : { violations: summary.violations }),
      ...(warnings.length === 0 ? {} : { warning: warnings.join('；') }),
      ...(zonesFilled === undefined ? {} : { zonesFilled }),
      ...(zonesCreated === undefined ? {} : { zonesCreated }),
    };
    return {
      content: new Uint8Array(sesBytes),
      contentType: 'text/plain; charset=utf-8',
      filename: 'board.ses',
      routing,
    };
  }

  /**
   * Whole-board runs can leave pour-only nets (GND by default) unrouted: route the
   * difference between the DSN's net list and `skipNets`.
   */
  private applySkipNets(
    parameters: RouteParameters,
    dsnNets: readonly string[],
    record: (message: string) => void,
  ): RouteParameters {
    if (parameters.routeOnlyNets.length > 0 || parameters.skipNets.length === 0) {
      return parameters;
    }
    const skip = new Set(parameters.skipNets.map((net) => net.toLowerCase()));
    const remaining = dsnNets.filter((net) => !skip.has(net.toLowerCase()));
    if (remaining.length === 0 || remaining.length === dsnNets.length) {
      return parameters;
    }
    record(
      `整板跳过 ${dsnNets.length - remaining.length} 个网络（${parameters.skipNets.join(', ')}），实际布线 ${remaining.length} 个`,
    );
    return { ...parameters, routeOnlyNets: remaining };
  }

  /**
   * Export the current board DSN via hq-edge, re-binding and retrying on transient
   * failures. Switching PCBs in KiCad leaves the Bridge's cached board briefly stale,
   * which used to surface as a hard error on the first export. `ensureBoard` re-binds,
   * and a short backoff lets KiCad stabilise before the next attempt.
   */
  private async exportDsnWithRetry(
    signal: AbortSignal,
    attempts = 3,
  ): Promise<Buffer> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.bridge.ensureBoard(signal);
        return await this.bridge.exportDsn(signal);
      } catch (cause) {
        if (signal.aborted || (cause instanceof Error && cause.name === 'AbortError')) {
          throw cause;
        }
        lastError = cause;
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
