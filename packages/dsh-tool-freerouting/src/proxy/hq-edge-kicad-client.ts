/**
 * hq-edge HTTP client for KiCad PCB board operations.
 *
 * DSH → dsh-tool-freerouting → hq-edge → EDA Host is the ONLY production path
 * for KiCad communication. This module sends board operations (export DSN,
 * import SES, fill zones, etc.) to the hq-edge HTTP router and maps the HTTP
 * status back to semantic error categories.
 *
 * The base URL is resolved lazily at request time from `ctx.hqEdge.baseUrl`
 * (the edge-bridge HOST service), with config/env fallback.
 *
 * @module
 */

import {
  type KicadUpstreamClient,
  type UpstreamFillZonesResult,
  type UpstreamImportResult,
  type UpstreamStatus,
} from './kicad-upstream-interface.js';
import { UpstreamServiceError } from './upstream-errors.js';

export interface HqEdgeKicadClientOptions {
  /** Static hq-edge base URL from config/env (fallback). */
  baseUrl?: string;
  /** Per-request timeout in ms. */
  requestTimeoutMs: number;
  /**
   * Optional late-bound resolver for the HQ Edge base URL. When supplied it is
   * consulted on EVERY request and takes priority over the static `baseUrl`.
   * This lets the plugin read the endpoint from `ctx.hqEdge.baseUrl`.
   */
  baseUrlResolver?: () => string | undefined;
}

interface BoardEnvelope {
  errorMsg?: string;
  success?: boolean;
}

/**
 * HTTP client for KiCad board operations via hq-edge.
 *
 * Implements `KicadUpstreamClient` so `RunService` can use it transparently.
 * All DSN/SES data is exchanged as base64 — no shared filesystem paths.
 */
export class HqEdgeKicadClient implements KicadUpstreamClient {
  constructor(private readonly options: HqEdgeKicadClientOptions) {}

  private resolveBaseUrl(): string {
    const url =
      this.options.baseUrlResolver?.()?.trim() ??
      this.options.baseUrl?.trim() ??
      '';
    if (url.length === 0) {
      throw new UpstreamServiceError(
        'HQ_EDGE_UNAVAILABLE',
        503,
        'No hq-edge base URL configured (hqEdgeBaseUrl / HQ_EDGE_BASE_URL) — ' +
          'board tools require the hq-edge EDA host bridge.',
      );
    }
    return url.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json' };
  }

  private timeoutSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  }

  private async request<T extends BoardEnvelope>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const baseUrl = this.resolveBaseUrl();
    const url = `${baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: this.headers(),
        signal: this.timeoutSignal(signal),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw cause;
      }
      throw new UpstreamServiceError(
        'HQ_EDGE_UNAVAILABLE',
        503,
        `hq-edge is not reachable at ${url}; is the hq-edge server running?`,
      );
    }
    const payload = (await response.json().catch(() => undefined)) as T | undefined;
    if (!response.ok || payload === undefined) {
      const detail =
        typeof (payload as BoardEnvelope | undefined)?.errorMsg === 'string'
          ? (payload as BoardEnvelope).errorMsg
          : '';
      throw new UpstreamServiceError(
        'HQ_EDGE_REQUEST_FAILED',
        response.status,
        `hq-edge ${method} ${path} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      );
    }
    return payload;
  }

  async status(signal?: AbortSignal): Promise<UpstreamStatus> {
    return this.request<UpstreamStatus>('GET', '/api/v1/board/status', undefined, signal);
  }

  async ensureBoard(signal?: AbortSignal): Promise<void> {
    const result = await this.request<BoardEnvelope>(
      'POST',
      '/api/v1/board/ensure',
      {},
      signal,
    );
    if (result.success !== true) {
      throw new UpstreamServiceError(
        'HQ_EDGE_BOARD_UNAVAILABLE',
        503,
        result.errorMsg ?? 'KiCad has no open board to route; open a .kicad_pcb first',
      );
    }
  }

  /**
   * Export the current board as Specctra DSN via hq-edge.
   * hq-edge returns `{ success, data: "..." }` (base64-encoded).
   */
  async exportDsn(signal?: AbortSignal): Promise<Buffer> {
    const result = await this.request<BoardEnvelope & { data?: string }>(
      'POST',
      '/api/v1/board/export-dsn',
      {},
      signal,
    );
    if (result.success !== true) {
      throw new UpstreamServiceError(
        'HQ_EDGE_EXPORT_FAILED',
        502,
        result.errorMsg ?? 'hq-edge could not export the board DSN',
      );
    }
    const base64 = result.data ?? '';
    if (base64 === '') {
      throw new UpstreamServiceError(
        'HQ_EDGE_EXPORT_EMPTY',
        502,
        'hq-edge exported an empty DSN',
      );
    }
    return Buffer.from(base64, 'base64');
  }

  /**
   * Import a routing session (SES) into KiCad via hq-edge.
   * Sends base64-encoded SES data; hq-edge handles the KiCad bridge internally.
   */
  async importSession(
    sesBase64: string,
    signal?: AbortSignal,
  ): Promise<UpstreamImportResult> {
    const body: Record<string, unknown> = { sesData: sesBase64 };
    const result = await this.request<UpstreamImportResult>(
      'POST',
      '/api/v1/board/import-session',
      body,
      signal,
    );
    if (result.success !== true) {
      throw new UpstreamServiceError(
        'HQ_EDGE_IMPORT_FAILED',
        502,
        result.errorMsg ?? 'hq-edge could not import the routing session',
      );
    }
    return result;
  }

  async fillZones(
    nets?: readonly string[],
    signal?: AbortSignal,
  ): Promise<UpstreamFillZonesResult> {
    const body = nets !== undefined && nets.length > 0 ? { nets: [...nets] } : {};
    const result = await this.request<UpstreamFillZonesResult>(
      'POST',
      '/api/v1/board/fill-zones',
      body,
      signal,
    );
    if (result.success !== true) {
      throw new UpstreamServiceError(
        'HQ_EDGE_FILL_ZONES_FAILED',
        502,
        result.errorMsg ?? 'hq-edge could not fill the copper zones',
      );
    }
    return result;
  }
}
