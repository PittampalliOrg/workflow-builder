import type {
  CaptureDevPreviewSourcesResult,
  DevPreviewAcceptanceCapturePort,
  ImmutableGitSha,
  PreviewAcceptanceBrokerPort,
  PreviewAcceptanceBrokerResult,
  PreviewLocalControlIdentityPort,
  PreviewSessionContinuationBody,
  PreviewSessionContinuationInput,
  PreviewSessionContinuationPort,
  PreviewSessionContinuationResult,
  PreviewSourcePromotionPort,
  PreviewSourcePromotionResult,
  WorkflowDataService,
} from "$lib/server/application/ports";

const FULL_SHA = /^[0-9a-f]{40}$/;

type ContinuationAction =
  | Readonly<{
      kind: "capture";
      services: readonly string[];
      iteration: number | null;
    }>
  | Readonly<{
      kind: "promote";
      artifactId: string;
      title: string | null;
      bodyMarkdown: string | null;
      draft: boolean;
    }>
  | Readonly<{
      kind: "acceptance";
      pullRequest: Readonly<{
        repository: string;
        number: number;
        baseSha: ImmutableGitSha;
        headSha: ImmutableGitSha;
      }>;
    }>;

type PreviewSessionContinuationDeps = Readonly<{
  workflowData: Pick<
    WorkflowDataService,
    "getScopedExecutionById" | "isPlatformAdmin"
  >;
  identity: PreviewLocalControlIdentityPort;
  capture: DevPreviewAcceptanceCapturePort;
  promotion: PreviewSourcePromotionPort;
  acceptance: PreviewAcceptanceBrokerPort;
  requestId?: () => string;
}>;

/**
 * Continues a user-owned interactive preview without turning the public route
 * into a control-plane client. Its immutable identity is always local, never
 * browser supplied.
 */
export class ApplicationPreviewSessionContinuationService
  implements PreviewSessionContinuationPort
{
  private readonly requestId: () => string;

  constructor(private readonly deps: PreviewSessionContinuationDeps) {
    this.requestId = deps.requestId ?? (() => globalThis.crypto.randomUUID());
  }

  async continue(
    input: PreviewSessionContinuationInput,
  ): Promise<PreviewSessionContinuationResult> {
    const action = parseAction(input.action);
    if (!action) return failure(400, "Invalid preview continuation action");

    const execution = await this.deps.workflowData
      .getScopedExecutionById({
        executionId: input.executionId,
        userId: input.userId,
        projectId: input.projectId ?? null,
      })
      .catch(() => null);
    if (!execution) return failure(404, "Execution not found");
    if (!(await this.deps.workflowData.isPlatformAdmin(input.userId))) {
      return failure(403, "Admin access required");
    }

    let identity;
    try {
      identity = this.deps.identity.current();
    } catch {
      return failure(502, "Preview continuation is unavailable");
    }

    try {
      switch (action.kind) {
        case "capture":
          return success(
            captureBody(
              await this.deps.capture.captureAcceptanceCandidate({
                executionId: execution.id,
                nodeId: "preview-session-continuation",
                iteration: action.iteration,
                expectedServices: action.services,
                platformRevision: identity.environmentPlatformRevision,
                sourceRevision: identity.environmentSourceRevision,
                catalogDigest: identity.catalogDigest,
              }),
            ),
          );
        case "promote": {
          const result = await this.deps.promotion.promote({
            executionId: execution.id,
            artifactId: action.artifactId,
            title: action.title,
            bodyMarkdown: action.bodyMarkdown,
            draft: action.draft,
          });
          // Promotion transfers the preview-local artifact before it reaches
          // the hub. The result therefore carries the new central artifact ID,
          // not the browser-supplied preview-local source ID.
          if (result.executionId !== execution.id) {
            throw new Error("preview promotion result is not scoped to the execution");
          }
          return success(promotionBody(result));
        }
        case "acceptance": {
          const result = await this.deps.acceptance.replay({
            requestId: this.requestId(),
            previewName: identity.previewName,
            environmentRequestId: identity.environmentRequestId,
            environmentPlatformRevision: identity.environmentPlatformRevision,
            environmentSourceRevision: identity.environmentSourceRevision,
            catalogDigest: identity.catalogDigest,
            pullRequest: action.pullRequest,
          });
          if (!matchesAcceptance(result, action, identity.previewName)) {
            throw new Error("preview acceptance result does not match its request");
          }
          return success(acceptanceBody(result), result.ok ? 200 : 422);
        }
      }
    } catch {
      // The public session API never reflects transport or broker internals.
      return failure(502, "Preview continuation could not complete");
    }
  }
}

function parseAction(value: unknown): ContinuationAction | null {
  const body = record(value);
  if (!body || typeof body.action !== "string") return null;

  if (body.action === "capture" && onlyKeys(body, ["action", "services", "iteration"])) {
    const services = stringList(body.services);
    const iteration = body.iteration;
    if (
      services &&
      (iteration === undefined ||
        (typeof iteration === "number" &&
          Number.isSafeInteger(iteration) &&
          iteration >= 0))
    ) {
      return {
        kind: "capture",
        services,
        iteration: typeof iteration === "number" ? iteration : null,
      };
    }
  }

  if (
    body.action === "promote" &&
    onlyKeys(body, ["action", "artifactId", "title", "bodyMarkdown", "draft"]) &&
    nonBlankString(body.artifactId) &&
    optionalString(body.title) &&
    optionalString(body.bodyMarkdown) &&
    (body.draft === undefined || typeof body.draft === "boolean")
  ) {
    return {
      kind: "promote",
      artifactId: body.artifactId.trim(),
      title: optionalText(body.title),
      bodyMarkdown: optionalText(body.bodyMarkdown),
      draft: body.draft === true,
    };
  }

  if (body.action === "acceptance" && onlyKeys(body, ["action", "pullRequest"])) {
    const pullRequest = record(body.pullRequest);
    if (
      pullRequest &&
      onlyKeys(pullRequest, ["repository", "number", "baseSha", "headSha"]) &&
      nonBlankString(pullRequest.repository) &&
      typeof pullRequest.number === "number" &&
      Number.isSafeInteger(pullRequest.number) &&
      pullRequest.number > 0 &&
      typeof pullRequest.baseSha === "string" &&
      FULL_SHA.test(pullRequest.baseSha) &&
      typeof pullRequest.headSha === "string" &&
      FULL_SHA.test(pullRequest.headSha) &&
      pullRequest.baseSha !== pullRequest.headSha
    ) {
      return {
        kind: "acceptance",
        pullRequest: {
          repository: pullRequest.repository.trim(),
          number: pullRequest.number,
          baseSha: pullRequest.baseSha as ImmutableGitSha,
          headSha: pullRequest.headSha as ImmutableGitSha,
        },
      };
    }
  }

  return null;
}

function captureBody(
  result: CaptureDevPreviewSourcesResult,
): PreviewSessionContinuationBody {
  return {
    action: "capture",
    ok: result.ok === true,
    ...(typeof result.artifactId === "string"
      ? { artifactId: result.artifactId }
      : {}),
    services: result.services.map(({ service, ok }) => ({
      service,
      ok: ok === true,
    })),
  };
}

function promotionBody(
  result: PreviewSourcePromotionResult,
): PreviewSessionContinuationBody {
  return {
    action: "promote",
    ok: true,
    artifactId: result.artifactId,
    services: [...result.services],
    pullRequest: {
      repository: result.pullRequest.repository,
      number: result.pullRequest.number,
    },
    draft: result.draft === true,
  };
}

function matchesAcceptance(
  result: PreviewAcceptanceBrokerResult,
  action: Extract<ContinuationAction, { kind: "acceptance" }>,
  previewName: string,
): boolean {
  return (
    result.previewName === previewName &&
    result.pullRequest.repository === action.pullRequest.repository &&
    result.pullRequest.number === action.pullRequest.number &&
    result.pullRequest.baseSha === action.pullRequest.baseSha &&
    result.pullRequest.headSha === action.pullRequest.headSha
  );
}

function acceptanceBody(
  result: PreviewAcceptanceBrokerResult,
): PreviewSessionContinuationBody {
  return {
    action: "acceptance",
    ok: result.ok === true,
    services: [...result.services],
    pullRequest: {
      repository: result.pullRequest.repository,
      number: result.pullRequest.number,
    },
  };
}

function success(
  body: PreviewSessionContinuationBody,
  httpStatus: 200 | 422 = 200,
): PreviewSessionContinuationResult {
  return { status: "ok", httpStatus, body };
}

function failure(
  httpStatus: 400 | 403 | 404 | 502,
  message: string,
): PreviewSessionContinuationResult {
  return { status: "error", httpStatus, message };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const services = value.map((item) =>
    typeof item === "string" ? item.trim() : "",
  );
  return services.every(Boolean) && new Set(services).size === services.length
    ? services
    : null;
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
