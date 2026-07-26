/** Plain JSON-shaped object. Class instances and exotic prototypes are rejected. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

/**
 * Every key in `required` must be present and no key outside `required ∪ optional`
 * may appear. Callers that only want to reject unknown keys must not use this.
 */
export function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length === 0 && unexpected.length === 0) return;
  const detail = [
    ...(missing.length ? [`missing ${missing.join(", ")}`] : []),
    ...(unexpected.length ? [`unexpected ${unexpected.join(", ")}`] : []),
  ].join("; ");
  throw new Error(`Invalid object shape: ${detail}.`);
}

export function requireNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}.`);
  return value as number;
}

export function optionalIsoTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${label}.`);
  return value;
}
