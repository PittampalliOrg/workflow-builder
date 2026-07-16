import { env } from "$env/dynamic/private";
import type {
  PreviewDevelopmentBrokerSignalInput,
  PreviewDevelopmentBrokerStartInput,
  PreviewDevelopmentBrokerStatusInput,
  PreviewDevelopmentBrokerVerifyPromotionInput,
  PreviewDevelopmentPromotionVerificationResult,
  PreviewDevelopmentSignalResult,
  PreviewDevelopmentStartResult,
  PreviewDevelopmentStatusResult,
  PreviewTargetDevelopmentBrokerPort,
  PreviewTargetDevelopmentLeafTransportPort,
} from "$lib/server/application/ports";
import { PreviewTargetDevelopmentError } from "$lib/server/application/preview-target-development";
import { previewApiBaseUrl } from "$lib/server/application/adapters/preview-read-proxy";

const BROKER_PATH = "/api/internal/preview-control/development";
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

type WorkflowCommand =
  | Readonly<{
      kind: "start-workflow";
      input: PreviewDevelopmentBrokerStartInput["workflowInput"];
    }>
  | Readonly<{ kind: "get-workflow-status" }>
  | Readonly<{
      kind: "signal-workflow";
      action: PreviewDevelopmentBrokerSignalInput["action"];
    }>;

type WireCommand =
  | (WorkflowCommand &
      Readonly<{
        actorUserId: string;
        operationId: string;
        target: PreviewDevelopmentBrokerStatusInput["target"];
        executionId: string;
        workflowSpecDigest: `sha256:${string}`;
      }>)
  | Readonly<{
      kind: "verify-promotion";
      actorUserId: string;
      operationId: string;
      target: PreviewDevelopmentBrokerStatusInput["target"];
      childExecutionId: string;
      receiptId: string;
      services: readonly string[];
    }>;

type WireRequest = Readonly<{
  parentExecutionId: string;
  command: WireCommand;
}>;

type HttpOptions = Readonly<{
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}>;

function abortCause(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("preview development request timed out");
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(abortCause(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortCause(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    reader.read().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (cause) => {
        cleanup();
        reject(cause);
      },
    );
  });
}

async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
  parseJsonObject: boolean,
): Promise<Record<string, unknown> | null> {
  const declaredText = response.headers.get("content-length")?.trim();
  if (declaredText && /^\d+$/.test(declaredText)) {
    const declared = BigInt(declaredText);
    if (declared > BigInt(MAX_RESPONSE_BYTES)) {
      await response.body
        ?.cancel("response is oversized")
        .catch(() => undefined);
      throw new PreviewTargetDevelopmentError(
        "upstream-failure",
        "preview development response is oversized",
      );
    }
  }

  if (!response.body) {
    if (!parseJsonObject) return null;
    throw new PreviewTargetDevelopmentError(
      "upstream-failure",
      "preview development endpoint returned invalid JSON",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        throw new PreviewTargetDevelopmentError(
          "upstream-failure",
          "preview development response is oversized",
        );
      }
      if (parseJsonObject) chunks.push(value);
    }
  } catch (cause) {
    await reader.cancel(cause).catch(() => undefined);
    if (cause instanceof PreviewTargetDevelopmentError) throw cause;
    throw new PreviewTargetDevelopmentError(
      "upstream-failure",
      cause instanceof Error ? cause.message : String(cause),
    );
  } finally {
    reader.releaseLock();
  }

  if (signal.aborted) {
    throw new PreviewTargetDevelopmentError(
      "upstream-failure",
      abortCause(signal).message,
    );
  }

  if (!parseJsonObject) return null;
  try {
    const parsed = JSON.parse(
      Buffer.concat(chunks, totalBytes).toString("utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("non-object response");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new PreviewTargetDevelopmentError(
      "upstream-failure",
      "preview development endpoint returned invalid JSON",
    );
  }
}

type ErrorBodyTrust = "trusted" | "untrusted";

function errorCodeForHttpStatus(
  status: number,
): PreviewTargetDevelopmentError["code"] {
  switch (status) {
    case 400:
      return "invalid-request";
    case 401:
    case 403:
      return "unauthorized";
    case 404:
      return "not-found";
    case 409:
      return "contract-mismatch";
    case 425:
      return "not-ready";
    default:
      return "upstream-failure";
  }
}

async function request<T>(input: {
  baseUrl: string;
  headerName: string;
  token: string;
  body: WireRequest;
  options: HttpOptions;
  errorBodyTrust: ErrorBodyTrust;
}): Promise<T> {
  if (!input.baseUrl || !input.token) {
    throw new PreviewTargetDevelopmentError(
      "unauthorized",
      "preview development transport is not configured",
    );
  }
  const deadline = AbortSignal.timeout(
    input.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await (input.options.fetchImpl ?? fetch)(
      `${input.baseUrl.replace(/\/+$/, "")}${BROKER_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [input.headerName]: input.token,
        },
        body: JSON.stringify(input.body),
        signal: deadline,
      },
    );
  } catch (cause) {
    throw new PreviewTargetDevelopmentError(
      "upstream-failure",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const parsed = await readBoundedResponse(
    response,
    deadline,
    response.ok || input.errorBodyTrust === "trusted",
  );
  if (!response.ok) {
    let message = `preview development endpoint returned HTTP ${response.status}`;
    let code = errorCodeForHttpStatus(response.status);
    if (input.errorBodyTrust === "trusted" && parsed) {
      if (typeof parsed.error === "string") message = parsed.error;
      if (
        parsed.code === "invalid-request" ||
        parsed.code === "not-found" ||
        parsed.code === "not-ready" ||
        parsed.code === "unauthorized" ||
        parsed.code === "contract-mismatch" ||
        parsed.code === "upstream-failure"
      ) {
        code = parsed.code;
      }
    }
    throw new PreviewTargetDevelopmentError(code, message);
  }
  if (!parsed) {
    throw new PreviewTargetDevelopmentError(
      "upstream-failure",
      "preview development endpoint returned invalid JSON",
    );
  }
  return parsed as T;
}

function wireWorkflow(
  input: PreviewDevelopmentBrokerStatusInput,
  command: WorkflowCommand,
): WireRequest {
  return {
    parentExecutionId: input.parentExecutionId,
    command: {
      ...command,
      actorUserId: input.actorUserId,
      operationId: input.operationId,
      target: input.target,
      executionId: input.workflow.executionId,
      workflowSpecDigest: input.workflow.workflowSpecDigest,
    },
  };
}

function wirePromotion(
  input: PreviewDevelopmentBrokerVerifyPromotionInput,
): WireRequest {
  return {
    parentExecutionId: input.parentExecutionId,
    command: {
      kind: "verify-promotion",
      actorUserId: input.actorUserId,
      operationId: input.operationId,
      target: input.target,
      childExecutionId: input.childExecutionId,
      receiptId: input.receiptId,
      services: input.services,
    },
  };
}

export type HttpPreviewTargetDevelopmentBrokerOptions = HttpOptions &
  Readonly<{
    baseUrl?: () => string | null;
    token?: () => string | null;
  }>;

/** Persistent host BFF adapter to the physical preview-control broker. */
export class HttpPreviewTargetDevelopmentBrokerAdapter implements PreviewTargetDevelopmentBrokerPort {
  constructor(
    private readonly options: HttpPreviewTargetDevelopmentBrokerOptions = {},
  ) {}

  startWorkflow(input: PreviewDevelopmentBrokerStartInput) {
    return this.execute<PreviewDevelopmentStartResult>(input, {
      kind: "start-workflow",
      input: input.workflowInput,
    });
  }

  getWorkflowStatus(input: PreviewDevelopmentBrokerStatusInput) {
    return this.execute<PreviewDevelopmentStatusResult>(input, {
      kind: "get-workflow-status",
    });
  }

  signalWorkflow(input: PreviewDevelopmentBrokerSignalInput) {
    return this.execute<PreviewDevelopmentSignalResult>(input, {
      kind: "signal-workflow",
      action: input.action,
    });
  }

  verifyPromotion(input: PreviewDevelopmentBrokerVerifyPromotionInput) {
    return this.request<PreviewDevelopmentPromotionVerificationResult>(
      wirePromotion(input),
    );
  }

  private execute<T>(
    input: PreviewDevelopmentBrokerStatusInput,
    command: WorkflowCommand,
  ): Promise<T> {
    return this.request<T>(wireWorkflow(input, command));
  }

  private request<T>(body: WireRequest): Promise<T> {
    const baseUrl = (
      this.options.baseUrl?.() ??
      env.PREVIEW_CONTROL_BROKER_URL ??
      process.env.PREVIEW_CONTROL_BROKER_URL ??
      ""
    ).trim();
    const token = (
      this.options.token?.() ??
      env.PREVIEW_CONTROL_BROKER_TOKEN ??
      process.env.PREVIEW_CONTROL_BROKER_TOKEN ??
      ""
    ).trim();
    return request<T>({
      baseUrl,
      headerName: "x-preview-control-broker-token",
      token,
      body,
      options: this.options,
      errorBodyTrust: "trusted",
    });
  }
}

export type HttpPreviewTargetDevelopmentLeafOptions = HttpOptions;

/** Physical broker adapter to one capability-bound preview-local BFF. */
export class HttpPreviewTargetDevelopmentLeafAdapter implements PreviewTargetDevelopmentLeafTransportPort {
  constructor(
    private readonly options: HttpPreviewTargetDevelopmentLeafOptions = {},
  ) {}

  startWorkflow(
    input: PreviewDevelopmentBrokerStartInput & {
      targetUrl: string | null;
      capability: string;
    },
  ) {
    return this.execute<PreviewDevelopmentStartResult>(input, {
      kind: "start-workflow",
      input: input.workflowInput,
    });
  }

  getWorkflowStatus(
    input: PreviewDevelopmentBrokerStatusInput & {
      targetUrl: string | null;
      capability: string;
    },
  ) {
    return this.execute<PreviewDevelopmentStatusResult>(input, {
      kind: "get-workflow-status",
    });
  }

  signalWorkflow(
    input: PreviewDevelopmentBrokerSignalInput & {
      targetUrl: string | null;
      capability: string;
    },
  ) {
    return this.execute<PreviewDevelopmentSignalResult>(input, {
      kind: "signal-workflow",
      action: input.action,
    });
  }

  private execute<T>(
    input: PreviewDevelopmentBrokerStatusInput & {
      targetUrl: string | null;
      capability: string;
    },
    command: WorkflowCommand,
  ): Promise<T> {
    const baseUrl = previewApiBaseUrl({
      name: input.target.previewName,
      url: input.targetUrl,
      pool: null,
    });
    return request<T>({
      baseUrl: baseUrl ?? "",
      headerName: "x-preview-control-capability",
      token: input.capability,
      body: wireWorkflow(input, command),
      options: this.options,
      errorBodyTrust: "untrusted",
    });
  }
}
