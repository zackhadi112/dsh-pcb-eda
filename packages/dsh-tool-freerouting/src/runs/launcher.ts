import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { UpstreamServiceError } from '../proxy/upstream-errors.js';

/**
 * Local discovery + launch of the FreeRouting service (`:37864`).
 *
 * The DSH host, KiCad, and FreeRouting all run on the same machine, so when a routing
 * run finds `:37864` down it can start it itself instead of failing. The service is
 * shipped next to KiCad as `<KiCad install>\bin\freerouting_plugin\start.bat`, but the
 * install root differs per machine (华秋 KiCad lives at a non-standard, non-ASCII path),
 * so it is never hard-coded: the running KiCad process's own executable path reveals the
 * `bin` directory, with `where.exe` as a fallback.
 *
 * This module is server-side only (it touches `node:child_process` / `node:fs`).
 */

/** How to reach the FreeRouting service, used only for log/error text. */
export interface FreeroutingLauncherOptions {
  /** When false the launcher never spawns anything; a down service is just reported. */
  autoLaunch: boolean;
  /** FreeRouting base URL (e.g. `http://127.0.0.1:37864`), for messages only. */
  baseUrl: string;
  /** How long to wait for `:37864` to answer after spawning `start.bat`. */
  launchTimeoutMs: number;
  /** Polling interval while waiting for the freshly launched service to come up. */
  pollIntervalMs: number;
  /** Liveness probe for `:37864` — wired to `FreeroutingClient.checkStatus`. */
  probe: (signal?: AbortSignal) => Promise<boolean>;
  /** Explicit `start.bat` path; when set it wins over auto-discovery. */
  startBatOverride?: string;
}

/** Name of the launcher batch file relative to the KiCad `bin` directory. */
const START_BAT_RELPATH = join('freerouting_plugin', 'start.bat');

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

/** Run a command, capture stdout as UTF-8, and never throw (empty string on failure). */
function runCommand(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    let stdout = '';
    let child;
    try {
      child = spawn(command, [...args], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve('');
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(stdout));
  });
}

/**
 * Ask Windows for the executable paths of any running KiCad process. `-EncodedCommand`
 * (UTF-16LE base64) sidesteps every quoting problem, and forcing the console to UTF-8
 * keeps 华秋's non-ASCII install path (`D:\wj\华秋Kicad\…`) intact instead of mojibake.
 */
async function queryKicadProcessPaths(): Promise<string[]> {
  const script =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
    "Get-CimInstance Win32_Process -Filter \"Name='pcbnew.exe' OR Name='kicad.exe'\" | " +
    'ForEach-Object { $_.ExecutablePath }';
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = await runCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encoded,
  ]);
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().endsWith('.exe'));
}

/** Prefer `pcbnew.exe` (the PCB editor that hosts the plugin) over the `kicad.exe` launcher. */
function rankExe(exe: string): number {
  return exe.toLowerCase().endsWith('pcbnew.exe') ? 0 : 1;
}

/**
 * Locate the KiCad `bin` directory that actually contains `freerouting_plugin\start.bat`.
 * Strategy: running KiCad process paths first (always matches the KiCad in use), then
 * `where.exe` on PATH. Returns undefined when nothing valid is found — never a guess.
 */
async function findKicadBinWithStartBat(): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    return undefined;
  }
  const candidates: string[] = [];
  const fromProcess = await queryKicadProcessPaths();
  for (const exe of [...fromProcess].sort((a, b) => rankExe(a) - rankExe(b))) {
    candidates.push(dirname(exe));
  }
  for (const name of ['pcbnew', 'kicad']) {
    const out = await runCommand('where.exe', [name]);
    const first = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '');
    if (first !== undefined) {
      candidates.push(dirname(first));
    }
  }
  for (const bin of candidates) {
    if (existsSync(join(bin, START_BAT_RELPATH))) {
      return bin;
    }
  }
  return undefined;
}

/**
 * Resolve the absolute path to `start.bat`, or undefined when it cannot be found. An
 * explicit override wins (and must exist); otherwise the KiCad install dir is discovered.
 */
export async function resolveStartBat(override?: string): Promise<string | undefined> {
  if (override !== undefined && override.trim() !== '') {
    return existsSync(override) ? override : undefined;
  }
  const bin = await findKicadBinWithStartBat();
  return bin === undefined ? undefined : join(bin, START_BAT_RELPATH);
}

/**
 * Fire-and-forget launch of `start.bat` in its own console. `cmd /c start "" "<bat>"`
 * returns immediately while the batch (and the FreeRouting.exe it starts) keeps running
 * detached from the DSH host. Readiness is decided by polling the port, never by the
 * child's exit code, because the service is long-lived.
 */
function spawnStartBat(startBat: string): void {
  const child = spawn('cmd.exe', ['/c', `start "" "${startBat}"`], {
    cwd: dirname(startBat),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    windowsVerbatimArguments: true,
  });
  // A spawn error (e.g. missing cmd.exe) must not crash the run; the poll timeout below
  // reports "service did not come up", which is the accurate user-visible outcome.
  child.on('error', () => undefined);
  child.unref();
}

/**
 * Guarantees the FreeRouting service is reachable before a routing run needs it. When the
 * port is down and auto-launch is enabled, it locates and runs `start.bat`, then polls
 * until the service answers or the timeout elapses. Concurrent runs share one launch so
 * a double-click never spawns two FreeRouting instances.
 */
export class FreeroutingLauncher {
  private launchInFlight: Promise<void> | undefined;

  constructor(private readonly options: FreeroutingLauncherOptions) {}

  async ensureUp(record: (message: string) => void, signal?: AbortSignal): Promise<void> {
    if (await this.options.probe(signal)) {
      return;
    }
    if (!this.options.autoLaunch) {
      throw new UpstreamServiceError(
        'FREEROUTING_UNAVAILABLE',
        503,
        `FreeRouting service is not reachable at ${this.options.baseUrl} (auto-launch disabled)`,
      );
    }
    if (this.launchInFlight === undefined) {
      this.launchInFlight = this.launch(record, signal).finally(() => {
        this.launchInFlight = undefined;
      });
    }
    return this.launchInFlight;
  }

  private async launch(record: (message: string) => void, signal?: AbortSignal): Promise<void> {
    const startBat = await resolveStartBat(this.options.startBatOverride);
    if (startBat === undefined) {
      throw new UpstreamServiceError(
        'FREEROUTING_UNAVAILABLE',
        503,
        `未检测到 FreeRouting 服务（${this.options.baseUrl}），且无法在 KiCad 安装目录下定位 freerouting_plugin\\start.bat；请手动启动 FreeRouting 后重试`,
      );
    }

    record(`未检测到 FreeRouting 服务，正在启动：${startBat}`);
    spawnStartBat(startBat);

    const deadline = Date.now() + this.options.launchTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new UpstreamServiceError('RUN_CANCELLED', 499, 'The routing run was cancelled');
      }
      if (await this.options.probe(signal)) {
        record('FreeRouting 服务已就绪');
        return;
      }
      await abortableSleep(this.options.pollIntervalMs, signal);
    }
    throw new UpstreamServiceError(
      'FREEROUTING_UNAVAILABLE',
      503,
      `start.bat 已启动，但 ${Math.round(this.options.launchTimeoutMs / 1000)} 秒内 ${
        this.options.baseUrl
      } 仍未就绪`,
    );
  }
}
