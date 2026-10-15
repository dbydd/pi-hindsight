/** Canonical plain-object guard for config/JSON values. Arrays and null are not records. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
