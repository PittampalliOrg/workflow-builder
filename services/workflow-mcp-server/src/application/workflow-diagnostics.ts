import type {
  TraceLlmTurnQuery,
  TraceLogQuery,
  TraceSpanQuery,
  TraceToolCallQuery,
  WorkflowDiagnosticsPort,
  WorkflowExecutionListQuery,
} from "../ports/workflow-diagnostics.js";
import {
  aggregateDiagnosticTelemetry,
  diagnosticStatus,
  normalizeDiagnosticTelemetry,
  unavailableDiagnosticTelemetry,
  type DiagnosticTelemetry,
  type DiagnosticTelemetryState,
} from "./diagnostic-telemetry.js";

export type DiagnosticWarning = {
  source: "digest" | "spans" | "logs";
  message: string;
};

export type DiagnosticEvidenceCoverage =
  | "available"
  | Exclude<DiagnosticTelemetryState, "complete">;

export type WorkflowExecutionDiagnostic = {
  overview: unknown;
  digest: unknown | null;
  errorSpans: unknown | null;
  errorLogs: unknown | null;
  evidenceCoverage: {
    overview: "available";
    digest: DiagnosticEvidenceCoverage;
    spans: DiagnosticEvidenceCoverage;
    logs: DiagnosticEvidenceCoverage;
  };
  warnings: DiagnosticWarning[];
  telemetry: DiagnosticTelemetry;
};

export interface WorkflowDiagnosticsUseCases {
  listWorkflowExecutions(query: WorkflowExecutionListQuery): Promise<unknown>;
  debugWorkflowExecution(
    executionId: string,
  ): Promise<WorkflowExecutionDiagnostic>;
  getDigest(executionId: string): Promise<unknown>;
  searchSpans(executionId: string, query: TraceSpanQuery): Promise<unknown>;
  getSpan(executionId: string, spanId: string): Promise<unknown>;
  getLlmTurns(executionId: string, query: TraceLlmTurnQuery): Promise<unknown>;
  getToolCalls(executionId: string, query: TraceToolCallQuery): Promise<unknown>;
  getSpanTree(executionId: string, maxNodes?: number): Promise<unknown>;
  searchLogs(executionId: string, query: TraceLogQuery): Promise<unknown>;
  getBrowserScreenshot(
    executionId: string,
    storageRef: string,
  ): Promise<unknown>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function coverage(telemetry: DiagnosticTelemetry): DiagnosticEvidenceCoverage {
  return telemetry.state === "complete" ? "available" : telemetry.state;
}

function settledTelemetry(
  result: PromiseSettledResult<unknown>,
): DiagnosticTelemetry {
  return result.status === "fulfilled"
    ? normalizeDiagnosticTelemetry(result.value)
    : unavailableDiagnosticTelemetry(result.reason);
}

/** Application service that assembles a bounded first-pass debug bundle. */
export class ApplicationWorkflowDiagnosticsService implements WorkflowDiagnosticsUseCases {
  constructor(private readonly diagnostics: WorkflowDiagnosticsPort) {}

  listWorkflowExecutions(query: WorkflowExecutionListQuery): Promise<unknown> {
    return this.diagnostics.listWorkflowExecutions(query);
  }

  async debugWorkflowExecution(
    executionId: string,
  ): Promise<WorkflowExecutionDiagnostic> {
    const overview = await this.diagnostics.getExecutionOverview(executionId);
    const [digest, spans, logs] = await Promise.allSettled([
      this.diagnostics.getDigest(executionId),
      this.diagnostics.searchSpans(executionId, {
        errorsOnly: true,
        limit: 20,
      }),
      this.diagnostics.searchLogs(executionId, {
        errorsOnly: true,
        limit: 40,
      }),
    ]);

    const warnings: DiagnosticWarning[] = [];
    if (digest.status === "rejected") {
      warnings.push({ source: "digest", message: message(digest.reason) });
    }
    if (spans.status === "rejected") {
      warnings.push({ source: "spans", message: message(spans.reason) });
    }
    if (logs.status === "rejected") {
      warnings.push({ source: "logs", message: message(logs.reason) });
    }

    const evidence = {
      digest: settledTelemetry(digest),
      spans: settledTelemetry(spans),
      logs: settledTelemetry(logs),
    };
    for (const source of ["digest", "spans", "logs"] as const) {
      if (
        (source === "digest" && digest.status === "rejected") ||
        (source === "spans" && spans.status === "rejected") ||
        (source === "logs" && logs.status === "rejected")
      ) {
        continue;
      }
      for (const warning of evidence[source].warnings) {
        warnings.push({ source, message: warning });
      }
    }

    const prefixedWarnings = warnings.map(
      (warning) => `${warning.source}: ${warning.message}`,
    );
    const telemetry = aggregateDiagnosticTelemetry(
      Object.values(evidence).map((item) => ({ ...item, warnings: [] })),
      {
        status: diagnosticStatus(overview),
        warnings: prefixedWarnings,
      },
    );

    return {
      overview,
      digest: digest.status === "fulfilled" ? digest.value : null,
      errorSpans: spans.status === "fulfilled" ? spans.value : null,
      errorLogs: logs.status === "fulfilled" ? logs.value : null,
      evidenceCoverage: {
        overview: "available",
        digest: coverage(evidence.digest),
        spans: coverage(evidence.spans),
        logs: coverage(evidence.logs),
      },
      warnings,
      telemetry,
    };
  }

  getDigest(executionId: string): Promise<unknown> {
    return this.diagnostics.getDigest(executionId);
  }

  searchSpans(executionId: string, query: TraceSpanQuery): Promise<unknown> {
    return this.diagnostics.searchSpans(executionId, query);
  }

  getSpan(executionId: string, spanId: string): Promise<unknown> {
    return this.diagnostics.getSpan(executionId, spanId);
  }

  getLlmTurns(executionId: string, query: TraceLlmTurnQuery): Promise<unknown> {
    return this.diagnostics.getLlmTurns(executionId, query);
  }

  getToolCalls(executionId: string, query: TraceToolCallQuery): Promise<unknown> {
    return this.diagnostics.getToolCalls(executionId, query);
  }

  getSpanTree(executionId: string, maxNodes?: number): Promise<unknown> {
    return this.diagnostics.getSpanTree(executionId, maxNodes);
  }

  searchLogs(executionId: string, query: TraceLogQuery): Promise<unknown> {
    return this.diagnostics.searchLogs(executionId, query);
  }

  getBrowserScreenshot(
    executionId: string,
    storageRef: string,
  ): Promise<unknown> {
    return this.diagnostics.getBrowserScreenshot(executionId, storageRef);
  }
}
