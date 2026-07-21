import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DiagnosticTelemetry } from "./application/diagnostic-telemetry.js";
import type { PreviewEnvironmentUseCases } from "./application/preview-environments.js";
import {
  hasWorkflowMcpScope,
  type WorkflowMcpPrincipal,
} from "./auth-context.js";
import {
  diagnosticEnvelopeTraceMetadata,
  setSpanOutput,
} from "./observability/content.js";
import {
  narrowerPreviewTraceRange,
  parsePreviewTraceRange,
  PreviewEnvironmentRequestError,
} from "./ports/preview-environments.js";
import type { RegisteredTool } from "./workflow-tools.js";

type NextAction = {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
};

type PreviewToolEnvelope = {
  ok: boolean;
  observedAt: string;
  telemetry: DiagnosticTelemetry;
  data?: unknown;
  error?: { code: string; message: string; retryable: boolean };
  nextActions: NextAction[];
};

export type PreviewToolsContext = {
  principal: WorkflowMcpPrincipal;
  previews: PreviewEnvironmentUseCases;
};

const NAME = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
  .describe("Lowercase preview name returned by list_preview_environments.");
const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const REQUEST_ID = z.string().min(1).max(256);
const SIGNATURE = z.string().regex(/^[0-9a-f]{64}$/);

const TRACE_FIELDS = {
  range: z.enum(["15m", "1h", "6h", "24h", "7d"]).optional(),
  status: z.enum(["all", "ok", "error"]).optional(),
  service: z.string().max(128).optional(),
  search: z.string().max(160).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

const OUTPUT_SCHEMA = {
  ok: z.boolean(),
  observedAt: z.string(),
  telemetry: z.object({
    state: z.enum(["complete", "partial", "pending", "unavailable"]),
    isFinal: z.boolean(),
    warnings: z.array(z.string()),
    refreshAfterMs: z.number().int().positive().optional(),
  }),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .optional(),
  nextActions: z.array(
    z.object({
      tool: z.string(),
      arguments: z.record(z.unknown()),
      reason: z.string(),
    }),
  ),
};

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const CREATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timeoutRetryRange(
  cause: unknown,
  requestedRange: unknown,
): ReturnType<typeof parsePreviewTraceRange> {
  if (
    !(cause instanceof PreviewEnvironmentRequestError) ||
    cause.code !== "preview_trace_timeout" ||
    !cause.retryable
  ) {
    return null;
  }
  const details = record(cause.details);
  if (details?.retryRange === null) return null;
  return (
    parsePreviewTraceRange(details?.retryRange) ??
    narrowerPreviewTraceRange(
      parsePreviewTraceRange(details?.range) ??
        parsePreviewTraceRange(requestedRange) ??
        "1h",
    )
  );
}

function response(tool: string, envelope: PreviewToolEnvelope) {
  setSpanOutput(diagnosticEnvelopeTraceMetadata(envelope, tool));
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(envelope, null, 2) },
    ],
    structuredContent: envelope,
  };
}

function success(
  tool: string,
  data: unknown,
  options: {
    telemetry?: DiagnosticTelemetry;
    nextActions?: NextAction[];
  } = {},
) {
  return response(tool, {
    ok: true,
    observedAt: new Date().toISOString(),
    telemetry: options.telemetry ?? {
      state: "complete",
      isFinal: true,
      warnings: [],
    },
    data,
    nextActions: options.nextActions ?? [],
  });
}

function failure(
  tool: string,
  cause: unknown,
  nextActions: NextAction[] = [],
) {
  const error =
    cause instanceof PreviewEnvironmentRequestError
      ? cause
      : new PreviewEnvironmentRequestError(
          cause instanceof Error ? cause.message : String(cause),
          "preview_management_failed",
          false,
        );
  return {
    ...response(tool, {
      ok: false,
      observedAt: new Date().toISOString(),
      telemetry: {
        state: "unavailable",
        isFinal: !error.retryable,
        warnings: [error.message],
        ...(error.retryAfterMs ? { refreshAfterMs: error.retryAfterMs } : {}),
      },
      ...(error.details === undefined ? {} : { data: error.details }),
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
      nextActions,
    }),
    isError: true,
  };
}

function previewTelemetry(phase: unknown): DiagnosticTelemetry {
  const normalized = typeof phase === "string" ? phase.toLowerCase() : "";
  const pending = [
    "pending",
    "provisioning",
    "claiming",
    "sleeping",
    "recycling",
    "terminating",
  ].includes(normalized);
  return {
    state: pending ? "pending" : "complete",
    isFinal: !pending,
    warnings: [],
    ...(pending ? { refreshAfterMs: 5_000 } : {}),
  };
}

function phase(value: unknown): unknown {
  return record(record(value)?.preview)?.phase;
}

function teardownPhase(value: unknown): string {
  const phase = record(record(value)?.teardown)?.phase;
  return typeof phase === "string" ? phase : "unknown";
}

/** Register BFF-authorized preview lifecycle and diagnostic tools. */
export function registerPreviewEnvironmentTools(
  server: McpServer,
  context: PreviewToolsContext,
): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const canRead = hasWorkflowMcpScope(context.principal, "workflow:read");
  const canExecute = hasWorkflowMcpScope(
    context.principal,
    "workflow:execute",
  );

  const register = (
    scope: "read" | "execute",
    name: string,
    description: string,
    config: Record<string, unknown>,
    handler: (args: any) => Promise<any>,
  ) => {
    if (
      (scope === "read" && !canRead) ||
      (scope === "execute" && !canExecute)
    ) {
      return;
    }
    (server as any).registerTool(
      name,
      { title: config.title, description, ...config, outputSchema: OUTPUT_SCHEMA },
      handler,
    );
    tools.push({ name, description });
  };

  register(
    "read",
    "list_preview_services",
    "List the current server-authorized app-live service catalog before launching a preview. Service names are resolved by the BFF, not guessed by the client.",
    { title: "List Preview Services", inputSchema: {}, annotations: READ_ONLY },
    async () => {
      try {
        return success(
          "list_preview_services",
          await context.previews.listServices(),
        );
      } catch (cause) {
        return failure("list_preview_services", cause);
      }
    },
  );

  register(
    "read",
    "list_preview_environments",
    "List the dev preview fleet with capacity, lifecycle, readiness, exact revisions, and service selection. Requires platform-admin authorization in Workflow Builder.",
    {
      title: "List Preview Environments",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const data = await context.previews.list();
        return success("list_preview_environments", data);
      } catch (cause) {
        return failure("list_preview_environments", cause);
      }
    },
  );

  register(
    "read",
    "get_preview_environment",
    "Read one authorized preview's lifecycle and immutable generation tuple. Use the returned requestId and sourceRevision for any teardown.",
    {
      title: "Get Preview Environment",
      inputSchema: { name: NAME },
      annotations: READ_ONLY,
    },
    async ({ name }: { name: string }) => {
      try {
        const data = await context.previews.get(name);
        return success("get_preview_environment", data, {
          telemetry: previewTelemetry(phase(data)),
          nextActions: [
            {
              tool: "debug_preview_environment",
              arguments: { name },
              reason: "Inspect runtime readiness and tuple-scoped traces.",
            },
          ],
        });
      } catch (cause) {
        return failure("get_preview_environment", cause);
      }
    },
  );

  register(
    "read",
    "debug_preview_environment",
    "Return a bounded first-pass debug bundle: lifecycle, runtime containers, tuple-scoped traces, evidence coverage, and a cross-read generation fence.",
    {
      title: "Debug Preview Environment",
      inputSchema: { name: NAME, ...TRACE_FIELDS },
      annotations: READ_ONLY,
    },
    async (args: { name: string } & Record<string, unknown>) => {
      const { name, ...query } = args;
      try {
        const data = await context.previews.debug(name, query);
        const timeoutRetry =
          data.traceFailure?.code === "preview_trace_timeout" &&
          data.traceFailure.retryable
            ? data.traceFailure.retryRange
            : null;
        const nextActions: NextAction[] = timeoutRetry
          ? [
              {
                tool: "query_preview_traces",
                arguments: { name, ...query, range: timeoutRetry },
                reason: "Retry the same bounded query over a narrower range.",
              },
            ]
          : data.evidenceCoverage.traces === "available"
            ? [
                {
                  tool: "query_preview_traces",
                  arguments: {
                    name,
                    status: "error",
                    range: "1h",
                    limit: 50,
                  },
                  reason: "Drill into recent error traces with explicit filters.",
                },
              ]
            : [];
        return success("debug_preview_environment", data, {
          telemetry: data.telemetry,
          nextActions,
        });
      } catch (cause) {
        return failure("debug_preview_environment", cause);
      }
    },
  );

  register(
    "read",
    "query_preview_traces",
    "Query bounded trace summaries for the exact authorized preview generation. ClickHouse credentials and raw SQL remain behind the physical observability adapter.",
    {
      title: "Query Preview Traces",
      inputSchema: { name: NAME, ...TRACE_FIELDS },
      annotations: READ_ONLY,
    },
    async (args: { name: string } & Record<string, unknown>) => {
      const { name, ...query } = args;
      try {
        return success(
          "query_preview_traces",
          await context.previews.queryTraces(name, query),
          {
            nextActions: [
              {
                tool: "debug_preview_environment",
                arguments: { name },
                reason: "Correlate traces with lifecycle and runtime readiness.",
              },
            ],
          },
        );
      } catch (cause) {
        const retryRange = timeoutRetryRange(cause, query.range);
        return failure(
          "query_preview_traces",
          cause,
          retryRange
            ? [
                {
                  tool: "query_preview_traces",
                  arguments: { name, ...query, range: retryRange },
                  reason:
                    "Retry the same bounded query over a narrower range.",
                },
              ]
            : [],
        );
      }
    },
  );

  register(
    "execute",
    "launch_preview_environment",
    "Launch an isolated dev app-live vCluster preview. The BFF derives identity, platform revision, capabilities, provenance, and cold placement; this tool never accepts cluster credentials or image overrides.",
    {
      title: "Launch Preview Environment",
      inputSchema: {
        name: NAME,
        services: z
          .array(z.string().min(1).max(128))
          .min(1)
          .max(20)
          .optional()
          .describe("Names returned by list_preview_services; omit for all."),
        sourceRef: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe("Workflow Builder Git ref to resolve server-side; omit for the configured default."),
        ttlHours: z.number().int().min(1).max(168).optional(),
        lifecycle: z.enum(["ephemeral", "retained"]).optional(),
      },
      annotations: CREATE,
    },
    async (args: {
      name: string;
      services?: string[];
      sourceRef?: string;
      ttlHours?: number;
      lifecycle?: "ephemeral" | "retained";
    }) => {
      try {
        const data = await context.previews.launch(args);
        return success("launch_preview_environment", data, {
          telemetry: {
            state: "pending",
            isFinal: false,
            warnings: [],
            refreshAfterMs: 5_000,
          },
          nextActions: [
            {
              tool: "get_preview_environment",
              arguments: { name: args.name },
              reason: "Poll the accepted launch until the preview is ready.",
            },
          ],
        });
      } catch (cause) {
        return failure("launch_preview_environment", cause);
      }
    },
  );

  register(
    "execute",
    "teardown_preview_environment",
    "Request teardown of one exact preview generation. The required requestId and sourceRevision fence against deleting a recreated preview; archive and cleanup policy remain BFF-owned.",
    {
      title: "Teardown Preview Environment",
      inputSchema: {
        name: NAME,
        expectedRequestId: REQUEST_ID.describe(
          "provenance.requestId from get_preview_environment",
        ),
        expectedSourceRevision: SHA.describe(
          "sourceRevision from the same get_preview_environment response",
        ),
        forceFailed: z.boolean().optional(),
        discardUnarchived: z
          .boolean()
          .optional()
          .describe("Explicit platform-admin data-loss authorization."),
      },
      annotations: DESTRUCTIVE,
    },
    async (args: {
      name: string;
      expectedRequestId: string;
      expectedSourceRevision: string;
      forceFailed?: boolean;
      discardUnarchived?: boolean;
    }) => {
      const { name, ...input } = args;
      try {
        const data = await context.previews.teardown(name, input);
        const nextActions: NextAction[] = data.teardown
          ? [
              {
                tool: "get_preview_teardown_status",
                arguments: data.teardown,
                reason: "Poll the signed cleanup ticket until all absence checks complete.",
              },
            ]
          : [];
        return success("teardown_preview_environment", data, {
          telemetry: {
            state: data.teardown ? "pending" : "complete",
            isFinal: data.teardown === null,
            warnings: [],
            ...(data.teardown ? { refreshAfterMs: 5_000 } : {}),
          },
          nextActions,
        });
      } catch (cause) {
        return failure("teardown_preview_environment", cause);
      }
    },
  );

  register(
    "read",
    "get_preview_teardown_status",
    "Poll the signed, exact-generation teardown ticket and return every physical cleanup check. The ticket is accepted only by the BFF's preview cleanup port.",
    {
      title: "Get Preview Teardown Status",
      inputSchema: {
        name: NAME,
        environmentUid: z.string().min(1).max(128),
        requestId: REQUEST_ID,
        sourceRevision: SHA,
        signature: SIGNATURE,
      },
      annotations: READ_ONLY,
    },
    async (ticket: {
      name: string;
      environmentUid: string;
      requestId: string;
      sourceRevision: string;
      signature: string;
    }) => {
      try {
        const data = await context.previews.getTeardownStatus(ticket);
        const phase = teardownPhase(data);
        if (phase !== "pending" && phase !== "complete") {
          throw new PreviewEnvironmentRequestError(
            `Preview teardown returned unsupported phase '${phase}'`,
            "preview_teardown_contract_mismatch",
            false,
            undefined,
            data,
          );
        }
        const pending = phase === "pending";
        return success("get_preview_teardown_status", data, {
          telemetry: {
            state: pending ? "pending" : "complete",
            isFinal: !pending,
            warnings: [],
            ...(pending ? { refreshAfterMs: 5_000 } : {}),
          },
          nextActions: pending
            ? [
                {
                  tool: "get_preview_teardown_status",
                  arguments: ticket,
                  reason: "Cleanup is still converging.",
                },
              ]
            : [],
        });
      } catch (cause) {
        return failure("get_preview_teardown_status", cause);
      }
    },
  );

  return tools;
}
