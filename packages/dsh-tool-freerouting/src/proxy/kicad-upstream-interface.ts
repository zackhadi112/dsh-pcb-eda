/**
 * Unified interface for KiCad PCB board communication.
 *
 * `HqEdgeKicadClient` (hq-edge HTTP, the production path) satisfies this
 * contract so `RunService` can switch transports transparently.
 *
 * The types below mirror the hq-edge HTTP JSON responses (camelCase where
 * `toJson` emits camelCase). TypeScript structural typing ensures any
 * implementation returning a compatible shape is accepted.
 *
 * @module proxy/kicad-upstream-interface
 */

// ── Shared result types ──────────────────────────────────────────────────────

/**
 * Health / host-status report from hq-edge.
 *
 * hq-edge `GET /api/v1/board/status` returns host identity and capability
 * facts (not board-level details). `connected` is true when the EDA host is
 * reachable; `pcbSupported` is true when the host advertises the PCB
 * capability.
 */
export interface UpstreamStatus {
  /** Whether the EDA host gRPC connection is alive. */
  connected?: boolean;
  /** Whether the host advertises the PCB layout capability. */
  pcbSupported?: boolean;
  /** Host identity and installation details (opaque). */
  hostInfo?: Record<string, unknown>;
  /** Raw capability list from the host (opaque enum values). */
  capabilities?: unknown[];
  /** Present when the request itself succeeded (BoardEnvelope compat). */
  success?: boolean;
  /** Present when the request failed (BoardEnvelope compat). */
  errorMsg?: string;
}

/** Result of importing a routing session (SES) into KiCad. */
export interface UpstreamImportResult {
  success: boolean;
  errorMsg?: string;
}

/** Result of creating + filling copper zones. */
export interface UpstreamFillZonesResult {
  success: boolean;
  errorMsg?: string;
  /** Nets whose copper pour was successfully processed. */
  processedNets?: string[];
  /** Nets whose copper pour failed. */
  failedNets?: string[];
}

// ── The upstream client contract ─────────────────────────────────────────────

/**
 * Common contract for talking to KiCad's PCB editor — implemented by the
 * hq-edge HTTP client (`HqEdgeKicadClient`).
 *
 * `RunService` depends on this interface (not a concrete class) so the
 * transport can be swapped without changing routing logic.
 *
 * Note: unlike the legacy file-based KiCad Bridge, this interface uses
 * base64-encoded data for DSN/SES exchange (no shared filesystem paths).
 */
export interface KicadUpstreamClient {
  /** Query upstream health and board presence. */
  status(signal?: AbortSignal): Promise<UpstreamStatus>;

  /** Guarantee the correct board is loaded / re-bind after a board switch. */
  ensureBoard(signal?: AbortSignal): Promise<void>;

  /**
   * Export the current board as Specctra DSN and return the raw bytes.
   * The implementation handles the transport (hq-edge returns base64-encoded
   * DSN over HTTP).
   */
  exportDsn(signal?: AbortSignal): Promise<Buffer>;

  /**
   * Import a routing session (SES) from base64-encoded data.
   * Returns import statistics.
   */
  importSession(
    sesBase64: string,
    signal?: AbortSignal,
  ): Promise<UpstreamImportResult>;

  /**
   * Auto-create copper zones for `nets` (default GND) on every copper layer,
   * then fill all zones.
   */
  fillZones(
    nets?: readonly string[],
    signal?: AbortSignal,
  ): Promise<UpstreamFillZonesResult>;
}
