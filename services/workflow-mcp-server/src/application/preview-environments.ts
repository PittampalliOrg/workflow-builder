import type { DiagnosticTelemetry } from "./diagnostic-telemetry.js";
import type {
  PreviewEnvironmentLaunchInput,
  PreviewEnvironmentSummary,
  PreviewEnvironmentsPort,
  PreviewTeardownInput,
  PreviewTeardownTicket,
  PreviewTraceQuery,
} from "../ports/preview-environments.js";

type EvidenceCoverage = "available" | "unavailable";

export type PreviewEnvironmentDiagnostic = {
  preview: PreviewEnvironmentSummary;
  runtime: unknown | null;
  traces: unknown[] | null;
  traceServices: string[];
  traceObservedAt: string | null;
  generationStable: boolean;
  evidenceCoverage: {
    preview: "available";
    runtime: EvidenceCoverage;
    traces: EvidenceCoverage;
  };
  telemetry: DiagnosticTelemetry;
};

export interface PreviewEnvironmentUseCases {
  list(): ReturnType<PreviewEnvironmentsPort["list"]>;
  listServices(): ReturnType<PreviewEnvironmentsPort["listServices"]>;
  get(name: string): ReturnType<PreviewEnvironmentsPort["get"]>;
  launch(
    input: PreviewEnvironmentLaunchInput,
  ): ReturnType<PreviewEnvironmentsPort["launch"]>;
  debug(
    name: string,
    query: PreviewTraceQuery,
  ): Promise<PreviewEnvironmentDiagnostic>;
  queryTraces(
    name: string,
    query: PreviewTraceQuery,
  ): ReturnType<PreviewEnvironmentsPort["queryTraces"]>;
  teardown(
    name: string,
    input: PreviewTeardownInput,
  ): ReturnType<PreviewEnvironmentsPort["teardown"]>;
  getTeardownStatus(
    ticket: PreviewTeardownTicket,
  ): ReturnType<PreviewEnvironmentsPort["getTeardownStatus"]>;
}

type PreviewGeneration = {
  requestId: string;
  platformRevision: string;
  sourceRevision: string;
  catalogDigest: string;
};

function generation(
  preview: PreviewEnvironmentSummary,
): PreviewGeneration | null {
  const requestId = preview.provenance?.requestId;
  if (
    typeof requestId !== "string" ||
    !requestId ||
    !preview.platformRevision ||
    !preview.sourceRevision ||
    !preview.catalogDigest
  ) {
    return null;
  }
  return {
    requestId,
    platformRevision: preview.platformRevision,
    sourceRevision: preview.sourceRevision,
    catalogDigest: preview.catalogDigest,
  };
}

function sameGeneration(
  left: PreviewGeneration | null,
  right: PreviewGeneration | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.requestId === right.requestId &&
    left.platformRevision === right.platformRevision &&
    left.sourceRevision === right.sourceRevision &&
    left.catalogDigest === right.catalogDigest
  );
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function transitionPhase(phase: string): boolean {
  return [
    "pending",
    "provisioning",
    "claiming",
    "sleeping",
    "recycling",
    "terminating",
  ].includes(phase.toLowerCase());
}

/** Application service for preview lifecycle operations and a bounded debug bundle. */
export class ApplicationPreviewEnvironmentService implements PreviewEnvironmentUseCases {
  constructor(private readonly previews: PreviewEnvironmentsPort) {}

  list(): ReturnType<PreviewEnvironmentsPort["list"]> {
    return this.previews.list();
  }

  listServices(): ReturnType<PreviewEnvironmentsPort["listServices"]> {
    return this.previews.listServices();
  }

  get(name: string): ReturnType<PreviewEnvironmentsPort["get"]> {
    return this.previews.get(name);
  }

  launch(
    input: PreviewEnvironmentLaunchInput,
  ): ReturnType<PreviewEnvironmentsPort["launch"]> {
    return this.previews.launch(input);
  }

  async debug(
    name: string,
    query: PreviewTraceQuery,
  ): Promise<PreviewEnvironmentDiagnostic> {
    const before = await this.previews.get(name);
    const [runtime, traces] = await Promise.allSettled([
      this.previews.getRuntime(name),
      this.previews.queryTraces(name, query),
    ]);
    // The second lifecycle read must begin only after both evidence reads have
    // settled; otherwise it cannot fence a delete/recreate during collection.
    const [after] = await Promise.allSettled([this.previews.get(name)]);
    const warnings: string[] = [];
    if (runtime.status === "rejected") {
      warnings.push(`runtime: ${message(runtime.reason)}`);
    }
    if (traces.status === "rejected") {
      warnings.push(`traces: ${message(traces.reason)}`);
    }
    if (after.status === "rejected") {
      warnings.push(`generation fence: ${message(after.reason)}`);
    }

    const preview =
      after.status === "fulfilled" ? after.value.preview : before.preview;
    const generationStable =
      after.status === "fulfilled" &&
      sameGeneration(generation(before.preview), generation(preview));
    if (!generationStable) {
      warnings.push(
        "Preview generation could not be proven stable across the diagnostic read; refresh before acting on this evidence.",
      );
    }

    const available =
      Number(runtime.status === "fulfilled") +
      Number(traces.status === "fulfilled");
    const pending = transitionPhase(preview.phase);
    const state: DiagnosticTelemetry["state"] = pending
      ? "pending"
      : available === 2 && generationStable
        ? "complete"
        : available === 0
          ? "unavailable"
          : "partial";
    const traceValue = traces.status === "fulfilled" ? traces.value : null;

    return {
      preview,
      runtime: runtime.status === "fulfilled" ? runtime.value.runtime : null,
      traces: traceValue?.traces ?? null,
      traceServices: traceValue?.services ?? [],
      traceObservedAt: traceValue?.observedAt ?? null,
      generationStable,
      evidenceCoverage: {
        preview: "available",
        runtime:
          runtime.status === "fulfilled" ? "available" : "unavailable",
        traces:
          traces.status === "fulfilled" ? "available" : "unavailable",
      },
      telemetry: {
        state,
        isFinal: state === "complete",
        warnings,
        ...(state === "complete" ? {} : { refreshAfterMs: 5_000 }),
      },
    };
  }

  queryTraces(
    name: string,
    query: PreviewTraceQuery,
  ): ReturnType<PreviewEnvironmentsPort["queryTraces"]> {
    return this.previews.queryTraces(name, query);
  }

  teardown(
    name: string,
    input: PreviewTeardownInput,
  ): ReturnType<PreviewEnvironmentsPort["teardown"]> {
    return this.previews.teardown(name, input);
  }

  getTeardownStatus(
    ticket: PreviewTeardownTicket,
  ): ReturnType<PreviewEnvironmentsPort["getTeardownStatus"]> {
    return this.previews.getTeardownStatus(ticket);
  }
}
