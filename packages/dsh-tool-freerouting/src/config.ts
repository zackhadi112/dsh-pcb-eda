import z from '@deepseek-ai/schemastery';

const defaults = {
  autoLaunchFreerouting: true,
  drawtimeSec: 5,
  environmentHost: 'dsh-freerouting/1.0.0',
  freeroutingBaseUrl: 'http://127.0.0.1:37864',
  freeroutingLaunchTimeoutMs: 60_000,
  freeroutingStartBat: '',
  hqEdgeBaseUrl: '',
  maxPendingRuns: 4,
  pollIntervalMs: 2_000,
  pollTimeoutMs: 900_000,
  profileEmail: 'huaqiu@qq.com',
  profileId: 'd0071163-7ba3-46b3-b3af-bc2ebbd4d1a0',
  realtime: true,
  requestTimeoutMs: 120_000,
  resultTtlMs: 60 * 60 * 1000,
  routePrefix: '/pcb-freerouting',
} as const;

export interface Config {
  autoLaunchFreerouting?: boolean;
  drawtimeSec?: number;
  environmentHost?: string;
  freeroutingBaseUrl?: string;
  freeroutingLaunchTimeoutMs?: number;
  freeroutingStartBat?: string;
  /** HQ Edge base URL (fallback when `ctx.hqEdge` is absent). */
  hqEdgeBaseUrl?: string;
  maxPendingRuns?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  profileEmail?: string;
  profileId?: string;
  realtime?: boolean;
  requestTimeoutMs?: number;
  resultTtlMs?: number;
  routePrefix?: string;
}

export interface ResolvedConfig {
  autoLaunchFreerouting: boolean;
  drawtimeSec: number;
  environmentHost: string;
  freeroutingBaseUrl: string;
  freeroutingLaunchTimeoutMs: number;
  freeroutingStartBat: string;
  hqEdgeBaseUrl: string;
  maxPendingRuns: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  profileEmail: string;
  profileId: string;
  realtime: boolean;
  requestTimeoutMs: number;
  resultTtlMs: number;
  routePrefix: string;
}

export const Config: z<Config> = z.object({
  freeroutingBaseUrl: z.string().default(defaults.freeroutingBaseUrl),
  autoLaunchFreerouting: z.boolean().default(defaults.autoLaunchFreerouting),
  freeroutingStartBat: z.string().default(defaults.freeroutingStartBat),
  hqEdgeBaseUrl: z.string().default(defaults.hqEdgeBaseUrl),
  routePrefix: z.string().default(defaults.routePrefix),
  profileId: z.string().default(defaults.profileId),
  profileEmail: z.string().default(defaults.profileEmail),
  environmentHost: z.string().default(defaults.environmentHost),
  realtime: z.boolean().default(defaults.realtime),
  drawtimeSec: z.natural().min(1).max(120).default(defaults.drawtimeSec),
  pollIntervalMs: z.natural().min(250).max(60_000).default(defaults.pollIntervalMs),
  pollTimeoutMs: z
    .natural()
    .min(10_000)
    .max(2 * 60 * 60 * 1000)
    .default(defaults.pollTimeoutMs),
  requestTimeoutMs: z
    .natural()
    .min(1_000)
    .max(15 * 60 * 1000)
    .default(defaults.requestTimeoutMs),
  resultTtlMs: z
    .natural()
    .min(60_000)
    .max(7 * 24 * 60 * 60 * 1000)
    .default(defaults.resultTtlMs),
  maxPendingRuns: z.natural().min(1).max(64).default(defaults.maxPendingRuns),
  freeroutingLaunchTimeoutMs: z
    .natural()
    .min(5_000)
    .max(10 * 60 * 1000)
    .default(defaults.freeroutingLaunchTimeoutMs),
});

function requireHttpUrl(value: string, label: string): string {
  if (value === '') return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  return parsed.href.replace(/\/$/, '');
}

export function resolveConfig(config: Config = {}): ResolvedConfig {
  const routePrefix = config.routePrefix ?? defaults.routePrefix;
  if (!/^\/[\w/-]*[\w-]$/.test(routePrefix) || routePrefix.includes('//')) {
    throw new Error('routePrefix must be an absolute path without a trailing slash');
  }

  const freeroutingBaseUrl = config.freeroutingBaseUrl ?? defaults.freeroutingBaseUrl;
  if (freeroutingBaseUrl !== '') {
    requireHttpUrl(freeroutingBaseUrl, 'freeroutingBaseUrl');
  }

  return {
    autoLaunchFreerouting: config.autoLaunchFreerouting ?? defaults.autoLaunchFreerouting,
    drawtimeSec: config.drawtimeSec ?? defaults.drawtimeSec,
    environmentHost: config.environmentHost ?? defaults.environmentHost,
    freeroutingBaseUrl: requireHttpUrl(freeroutingBaseUrl, 'freeroutingBaseUrl'),
    freeroutingLaunchTimeoutMs:
      config.freeroutingLaunchTimeoutMs ?? defaults.freeroutingLaunchTimeoutMs,
    freeroutingStartBat: config.freeroutingStartBat ?? defaults.freeroutingStartBat,
    hqEdgeBaseUrl: config.hqEdgeBaseUrl ?? defaults.hqEdgeBaseUrl,
    maxPendingRuns: config.maxPendingRuns ?? defaults.maxPendingRuns,
    pollIntervalMs: config.pollIntervalMs ?? defaults.pollIntervalMs,
    pollTimeoutMs: config.pollTimeoutMs ?? defaults.pollTimeoutMs,
    profileEmail: config.profileEmail ?? defaults.profileEmail,
    profileId: config.profileId ?? defaults.profileId,
    realtime: config.realtime ?? defaults.realtime,
    requestTimeoutMs: config.requestTimeoutMs ?? defaults.requestTimeoutMs,
    resultTtlMs: config.resultTtlMs ?? defaults.resultTtlMs,
    routePrefix,
  };
}
