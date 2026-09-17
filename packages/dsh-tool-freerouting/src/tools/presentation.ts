import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JsonValue } from '@deepseek-ai/dsh-session';

import type { RunRecord } from '../runs/contracts.js';

export const openObject = { type: 'object', additionalProperties: true } as const;

export function render(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }];
}

export function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) {
    throw new Error('PCB FreeRouting tools require an agent session');
  }
  return agent;
}

export function createdRunOutput(run: RunRecord, routePrefix: string, title: string) {
  return {
    algorithm: run.algorithm,
    capability_token: run.token,
    expires_at: new Date(run.expiresAt).toISOString(),
    run_id: run.id,
    schema_version: 1,
    state: run.state,
    status_endpoint: `${routePrefix}/api/runs/${run.id}/status`,
    title,
  };
}

export function runMeta(value: JsonValue, routePrefix: string): JsonValue {
  const run = value as Record<string, JsonValue>;
  return {
    algorithm: run.algorithm ?? '',
    card: 'pcb-freerouting-run',
    routePrefix,
    runId: run.run_id ?? '',
    state: run.state ?? '',
    title: run.title ?? '',
    token: run.capability_token ?? '',
  };
}

export function normalizedNets(nets: string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const net of nets ?? []) {
    const value = net.trim();
    if (value !== '') {
      normalized.add(value);
    }
  }
  return [...normalized];
}

export function integerInRange(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}
