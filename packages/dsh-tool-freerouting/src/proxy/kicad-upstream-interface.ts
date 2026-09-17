/**
 * Unified interface for KiCad PCB board communication.
 *
 * `HqEdgeKicadClient` (hq-edge HTTP, the production path) satisfies this
 * contract so `RunService` can switch transports transparently.
 *
 * The types below use the same field shapes as the Bridge's JSON responses
 * (snake_case where the Bridge emits snake_case). TypeScript structural
 * typing ensures any implementation returning a compatible shape is accepted.
 *
 * @module proxy/kicad-upstream-interface
 */

// ── Shared result types ──────────────────────────────────────────────────────

/** Health / board-presence report from the KiCad upstream. */
export interface UpstreamStatus {
  ok: boolean;
  board_loaded?: boolean;
  board_source?: string;
  pcbnew_available?: boolean;
}

/** Post-import geometry self-check (board-outline containment). */
export interface UpstreamImportGeometry {
  board_bbox_mm?: [number, number, number, number] | null;
  checked?: number;
  mirrored?: boolean;
  outside?: number;
  session_bbox_mm?: [number, number, number, number] | null;
}

/** Result of importing a routing session (SES) into KiCad. */
export interface UpstreamImportResult {
  ok: boolean;
  error?: string;
  geometry?: UpstreamImportGeometry;
  method?: string;
  tracks?: number;
  vias?: number;
}

/** Result of reverting a previously imported session. */
export interface UpstreamRevertResult {
  ok: boolean;
  error?: string;
  removed?: number;
}

/** Result of creating + filling copper zones. */
export interface UpstreamFillZonesResult {
  ok: boolean;
  error?: string;
  /** Per-net zone creation problems (non-fatal). */
  errors?: string[];
  /** Copper zones auto-created for the requested pour nets before filling. */
  zonesCreated?: number;
  /** Copper zones filled after routing. */
  zonesFilled?: number;
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
   * `purgeNets` lists nets whose leftover tracks/vias must be deleted first.
   * Returns import statistics + geometry self-check.
   */
  importSession(
    sesBase64: string,
    purgeNets?: readonly string[],
    signal?: AbortSignal,
  ): Promise<UpstreamImportResult>;

  /** Roll back the tracks/vias added by the most recent `importSession`. */
  revertSession(signal?: AbortSignal): Promise<UpstreamRevertResult>;

  /**
   * Auto-create copper zones for `nets` (default GND) on every copper layer,
   * then fill all zones.
   */
  fillZones(
    nets?: readonly string[],
    signal?: AbortSignal,
  ): Promise<UpstreamFillZonesResult>;
}
