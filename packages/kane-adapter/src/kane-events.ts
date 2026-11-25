/**
 * Readers for kane-cli `--agent` NDJSON events, verified against kane-cli 0.10.9 output.
 * Every field is read defensively: the stream is vendor output, so a missing or mistyped
 * field becomes null instead of an exception.
 */

export type JsonObject = Readonly<Record<string, unknown>>;

export interface ProgressEvent {
  readonly step: number;
  readonly status: string;
  readonly remark: string;
  readonly ts: string | null;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function eventType(event: unknown): string | null {
  return isJsonObject(event) && typeof event.type === 'string' ? event.type : null;
}

/** Progress lines are the only untyped events: `{step, status, remark}`. */
export function asProgressEvent(event: unknown): ProgressEvent | null {
  if (!isJsonObject(event) || 'type' in event) return null;
  if (typeof event.step !== 'number' || typeof event.status !== 'string') return null;
  return {
    step: event.step,
    status: event.status,
    remark: typeof event.remark === 'string' ? event.remark : '',
    ts: typeof event.ts === 'string' ? event.ts : null,
  };
}

export function stringField(object: JsonObject, key: string): string | null {
  const value = object[key];
  return typeof value === 'string' ? value : null;
}

export function finiteNumberField(object: JsonObject, key: string): number | null {
  const value = object[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function objectField(object: JsonObject, key: string): JsonObject | null {
  const value = object[key];
  return isJsonObject(value) ? value : null;
}

/** Renders a scalar as text; structured values are kept as compact JSON. */
export function displayValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
