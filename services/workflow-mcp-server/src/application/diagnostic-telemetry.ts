export type DiagnosticTelemetryState =
  | "complete"
  | "partial"
  | "pending"
  | "unavailable";

export type DiagnosticTelemetry = {
  state: DiagnosticTelemetryState;
  isFinal: boolean;
  warnings: string[];
  refreshAfterMs?: number;
};

const TELEMETRY_STATES = new Set<DiagnosticTelemetryState>([
  "complete",
  "partial",
  "pending",
  "unavailable",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export function diagnosticStatus(value: unknown): string | null {
  const root = record(value);
  if (!root) return null;
  if (typeof root.status === "string") return root.status;
  return diagnosticStatus(root.execution) ?? diagnosticStatus(root.overview);
}

function telemetryRecord(value: unknown): Record<string, unknown> | null {
  const root = record(value);
  if (!root) return null;
  const nested = record(root.telemetry);
  if (nested) return nested;
  return typeof root.state === "string" ? root : null;
}

/** Normalize an adapter response without hiding downstream degraded states. */
export function normalizeDiagnosticTelemetry(
  value: unknown,
  options: {
    status?: string | null;
    warnings?: string[];
  } = {},
): DiagnosticTelemetry {
  const status = options.status ?? diagnosticStatus(value);
  const active = status === "running" || status === "pending";
  const source = telemetryRecord(value);
  const sourceState = source?.state;
  let state: DiagnosticTelemetryState =
    typeof sourceState === "string" &&
    TELEMETRY_STATES.has(sourceState as DiagnosticTelemetryState)
      ? (sourceState as DiagnosticTelemetryState)
      : active
        ? "pending"
        : "complete";
  const warnings = unique([
    ...strings(source?.warnings),
    ...(options.warnings ?? []),
  ]);
  if (state === "complete" && warnings.length > 0) state = "partial";

  const explicitIsFinal = source?.isFinal;
  const isFinal = active
    ? false
    : typeof explicitIsFinal === "boolean"
      ? explicitIsFinal
      : source
        ? state === "complete"
        : true;
  const explicitRefresh = positiveInteger(source?.refreshAfterMs);
  const refreshAfterMs =
    explicitRefresh ??
    (!isFinal && state !== "unavailable" ? 5_000 : undefined);

  return {
    state,
    isFinal,
    warnings,
    ...(refreshAfterMs ? { refreshAfterMs } : {}),
  };
}

export function unavailableDiagnosticTelemetry(
  error: unknown,
): DiagnosticTelemetry {
  const source = record(error);
  const status = typeof source?.status === "number" ? source.status : null;
  const retryable = status == null || status === 429 || status >= 500;
  const warning = error instanceof Error ? error.message : String(error);
  return {
    state: "unavailable",
    isFinal: !retryable,
    warnings: [warning],
    ...(retryable ? { refreshAfterMs: 5_000 } : {}),
  };
}

/** Aggregate independent evidence reads while preserving their refresh contract. */
export function aggregateDiagnosticTelemetry(
  items: DiagnosticTelemetry[],
  options: {
    status?: string | null;
    warnings?: string[];
  } = {},
): DiagnosticTelemetry {
  const active = options.status === "running" || options.status === "pending";
  const states = items.map((item) => item.state);
  let state: DiagnosticTelemetryState;
  if (states.length === 0) {
    state = active ? "pending" : "complete";
  } else if (states.includes("pending")) {
    state = "pending";
  } else if (states.every((item) => item === "unavailable")) {
    state = "unavailable";
  } else if (states.includes("unavailable") || states.includes("partial")) {
    state = "partial";
  } else {
    state = "complete";
  }

  const warnings = unique([
    ...items.flatMap((item) => item.warnings),
    ...(options.warnings ?? []),
  ]);
  if (state === "complete" && warnings.length > 0) state = "partial";
  const isFinal = !active && items.every((item) => item.isFinal);
  const refreshCandidates = items
    .map((item) => item.refreshAfterMs)
    .filter((value): value is number => value !== undefined);
  const refreshAfterMs =
    refreshCandidates.length > 0
      ? Math.min(...refreshCandidates)
      : !isFinal && state !== "unavailable"
        ? 5_000
        : undefined;

  return {
    state,
    isFinal,
    warnings,
    ...(refreshAfterMs ? { refreshAfterMs } : {}),
  };
}
