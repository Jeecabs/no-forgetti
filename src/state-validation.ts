export function requireNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}.`);
  return value as number;
}

export function optionalIsoTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${label}.`);
  return value;
}
