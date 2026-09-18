import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UpstreamServiceError } from '../proxy/upstream-errors.js';

/**
 * FreeRouting service launcher with bundled JRE.
 *
 * The JRE and FreeRouting JAR are bundled in the `bundled/` directory,
 * eliminating dependency on KiCad installation or system Java.
 *
 * Startup arguments are derived from the original Freerouting.cfg:
 *   - `--gui.enabled=false`
 *   - `--api_server.enabled=true`
 *   - `--api_server.http_allowed=true`
 *   - `--api_server.endpoints=http://127.0.0.1:37864`
 *   - `-Xmx2G` (JVM heap limit)
 */

export interface FreeroutingLauncherOptions {
  /** When false the launcher never spawns anything; a down service is just reported. */
  autoLaunch: boolean;
  /** FreeRouting base URL (e.g. `http://127.0.0.1:37864`), for messages only. */
  baseUrl: string;
  /** How long to wait for the service to come up after spawning. */
  launchTimeoutMs: number;
  /** Polling interval while waiting for the freshly launched service to come up. */
  pollIntervalMs: number;
  /** Liveness probe for `:37864` — wired to `FreeroutingClient.checkStatus`. */
  probe: (signal?: AbortSignal) => Promise<boolean>;
}

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

/** Resolve paths for bundled JRE and JAR */
function getBundledPaths(): { javaExe: string; jarPath: string } {
  // Current file is in lib/ or src/runs/, bundled/ is at package root
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // Try multiple possible locations for the bundled directory
  const candidate1 = join(currentDir, '..', 'bundled');
  const candidate2 = join(currentDir, '..', '..', 'bundled');

  // Check first candidate
  const javaExe1 = join(candidate1, 'jre', 'bin', 'java.exe');
  const jarPath1 = join(candidate1, 'freerouting.jar');
  if (existsSync(javaExe1) && existsSync(jarPath1)) {
    return { javaExe: javaExe1, jarPath: jarPath1 };
  }

  // Check second candidate
  const javaExe2 = join(candidate2, 'jre', 'bin', 'java.exe');
  const jarPath2 = join(candidate2, 'freerouting.jar');
  if (existsSync(javaExe2) && existsSync(jarPath2)) {
    return { javaExe: javaExe2, jarPath: jarPath2 };
  }

  // Fallback to first candidate (will fail with clear error)
  return { javaExe: javaExe1, jarPath: jarPath1 };
}

/** Check if bundled resources exist */
function hasBundledResources(): boolean {
  const { javaExe, jarPath } = getBundledPaths();
  return existsSync(javaExe) && existsSync(jarPath);
}

/**
 * Launcher for the bundled FreeRouting service.
 *
 * Uses the bundled JRE to start the FreeRouting JAR directly,
 * without any dependency on KiCad or system Java.
 */
export class FreeroutingLauncher {
  private launchInFlight: Promise<void> | undefined;
  private childProcess: ChildProcess | undefined;

  constructor(private readonly options: FreeroutingLauncherOptions) {}

  /**
   * Ensures the FreeRouting service is up before a routing run.
   * If the service is already running, returns immediately.
   * Otherwise, spawns the bundled JRE + JAR and waits for readiness.
   */
  async ensureUp(record: (message: string) => void, signal?: AbortSignal): Promise<void> {
    // 1. Check if service is already running
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

    // 2. Deduplicate concurrent launches
    if (this.launchInFlight === undefined) {
      this.launchInFlight = this.launch(record, signal).finally(() => {
        this.launchInFlight = undefined;
      });
    }
    return this.launchInFlight;
  }

  private async launch(record: (message: string) => void, signal?: AbortSignal): Promise<void> {
    // 3. Check bundled resources
    if (!hasBundledResources()) {
      const { javaExe, jarPath } = getBundledPaths();
      throw new UpstreamServiceError(
        'FREEROUTING_UNAVAILABLE',
        503,
        `FreeRouting bundled resources missing:\n` +
        `  java.exe: ${existsSync(javaExe) ? 'found' : 'MISSING'} (${javaExe})\n` +
        `  freerouting.jar: ${existsSync(jarPath) ? 'found' : 'MISSING'} (${jarPath})\n` +
        `Please reinstall the plugin.`,
      );
    }

    const { javaExe, jarPath } = getBundledPaths();
    record('正在启动 FreeRouting 服务（内置 JRE）...');

    // 4. Spawn Java process with bundled JRE
    // Arguments from Freerouting.cfg (endpoints defaults to http://127.0.0.1:37864)
    const javaArgs = [
      '-Xmx2G',
      '-jar', jarPath,
      '--gui.enabled=false',
      '--api_server.enabled=true',
      '--api_server.http_allowed=true',
    ];

    this.childProcess = spawn(javaExe, javaArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Capture stdout/stderr for logging
    this.childProcess.stdout?.on('data', () => {
      // Could write to log file here if needed
    });
    this.childProcess.stderr?.on('data', () => {
      // Could write to log file here if needed
    });

    // Handle unexpected exit
    this.childProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[freerouting] Process exited with code ${code}`);
      }
      this.childProcess = undefined;
    });

    this.childProcess.on('error', (err) => {
      console.error(`[freerouting] Process error:`, err);
    });

    // 5. Poll until service is ready
    const deadline = Date.now() + this.options.launchTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        this.gracefulShutdown();
        throw new UpstreamServiceError('RUN_CANCELLED', 499, 'The routing run was cancelled');
      }
      if (await this.options.probe(signal)) {
        record('FreeRouting 服务已就绪');
        return;
      }
      await abortableSleep(this.options.pollIntervalMs, signal);
    }

    this.gracefulShutdown();
    throw new UpstreamServiceError(
      'FREEROUTING_UNAVAILABLE',
      503,
      `FreeRouting 启动失败，${Math.round(this.options.launchTimeoutMs / 1000)} 秒内未就绪`,
    );
  }

  /**
   * Gracefully shutdown the FreeRouting process.
   * Called when the DSH plugin is disposed.
   */
  gracefulShutdown(): void {
    if (!this.childProcess?.pid) return;

    try {
      // On Windows, use taskkill to terminate the process tree
      spawn('taskkill', ['/PID', String(this.childProcess.pid), '/F', '/T'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // best-effort
    }
    this.childProcess = undefined;
  }
}
