import { z } from 'zod';

/**
 * FreeRouting `/v1` responses are loosely typed and vary between builds, so every
 * schema here is permissive and the client falls back to alternative field names.
 */

export const jobStatusSchema = z.looseObject({
  state: z.string().optional(),
  status: z.string().optional(),
  progress_percentage: z.number().optional(),
  progress: z.number().optional(),
  // Some FreeRouting builds also report a nested `statistics` blob while the job is
  // still RUNNING; accept it so live progress can surface violations/connections.
  statistics: z.record(z.string(), z.unknown()).optional(),
});

export const jobOutputSchema = z.looseObject({
  data: z.string().optional(),
  dataBase64: z.string().optional(),
  output: z.string().optional(),
  ses: z.string().optional(),
  filename: z.string().optional(),
  // FreeRouting `statistics` is a nested, build-dependent blob (values may be null,
  // numbers, strings, or objects), so accept any JSON value instead of failing the run.
  statistics: z.record(z.string(), z.unknown()).optional(),
});

export const identifierSchema = z.looseObject({
  id: z.string().optional(),
  job_id: z.string().optional(),
  session_id: z.string().optional(),
});

export type JobStatus = z.infer<typeof jobStatusSchema>;
export type JobOutput = z.infer<typeof jobOutputSchema>;
