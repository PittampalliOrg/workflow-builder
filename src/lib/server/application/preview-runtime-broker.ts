import type {
  PreviewControlSourceAuthorityPort,
  PreviewRuntimeBrokerPort,
  PreviewRuntimeBudgetDenialReason,
  PreviewRuntimeBudgetLimits,
  PreviewRuntimeBudgetReservationPort,
  PreviewRuntimeCapabilityVerificationPort,
  PreviewRuntimeCompletionRequest,
  PreviewRuntimeUpstreamPort,
} from "$lib/server/application/ports";

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MESSAGE_ROLES = new Set([
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
]);
const TOP_LEVEL_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "temperature",
  "top_p",
  "n",
  "best_of",
  "max_tokens",
  "max_completion_tokens",
  "frequency_penalty",
  "presence_penalty",
  "stop",
  "seed",
  "user",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "reasoning_effort",
  "thinking",
]);
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 25_000;
const MAX_OBJECT_KEYS = 128;
const MAX_CONTENT_PARTS = 32;
const MAX_TOOL_CALLS_PER_MESSAGE = 32;
const KIMI_INLINE_IMAGE_PREFIXES = new Set([
  "data:image/png;base64,",
  "data:image/jpeg;base64,",
  "data:image/webp;base64,",
  "data:image/gif;base64,",
]);
const encoder = new TextEncoder();

export const KIMI_K3_MODEL = "kimi-k3";
export const KIMI_K3_CONTEXT_TOKENS = 1_048_576;
export const KIMI_K3_MAX_COMPLETION_TOKENS = 131_072;
const KIMI_K3_REASONING_EFFORTS = new Set(["low", "high", "max"]);
// A transport byte bound cannot predict provider tokenization. Sixteen bytes
// per context token leaves room for the full K3 window while staying below the
// preview broker's BODY_SIZE_LIMIT=25M process ceiling.
export const PREVIEW_RUNTIME_DEFAULT_MAX_PAYLOAD_BYTES =
  KIMI_K3_CONTEXT_TOKENS * 16;
export const PREVIEW_RUNTIME_ABSOLUTE_MAX_PAYLOAD_BYTES = 24_000_000;

export type PreviewRuntimeBrokerErrorCode =
  | "unauthorized"
  | "invalid-request"
  | "model-forbidden"
  | "capacity"
  | "budget-exhausted"
  | "budget-unavailable";

export class PreviewRuntimeBrokerError extends Error {
  constructor(
    public readonly code: PreviewRuntimeBrokerErrorCode,
    message: string,
    public readonly budgetReason?: PreviewRuntimeBudgetDenialReason,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "PreviewRuntimeBrokerError";
  }
}

/** Adapter-facing failure taxonomy; no upstream response body crosses the port. */
export class PreviewRuntimeUpstreamError extends Error {
  constructor(
    public readonly code: "configuration" | "timeout" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PreviewRuntimeUpstreamError";
  }
}

export type PreviewRuntimeRequestLimits = Readonly<{
  maxPayloadBytes: number;
  maxMessages: number;
  maxContentBytes: number;
  maxTools: number;
  maxToolBytes: number;
  maxCompletionTokens: number;
  defaultCompletionTokens: number;
}>;

export type PreviewRuntimeAuditRecord = Readonly<{
  previewName: string;
  requestId: string;
  platformRevision: string;
  sourceRevision: string;
  catalogDigest: string;
  model: string;
  status: "accepted" | "completed" | "failed" | "budget-denied";
  upstreamStatus?: number;
  budgetReason?: PreviewRuntimeBudgetDenialReason;
  durationMs?: number;
}>;

type PreviewRuntimeBrokerDeps = Readonly<{
  authority: Pick<PreviewControlSourceAuthorityPort, "authorizeRuntimeTuple">;
  capabilities: PreviewRuntimeCapabilityVerificationPort;
  upstream: PreviewRuntimeUpstreamPort;
  budget: PreviewRuntimeBudgetReservationPort;
  budgetLimits: PreviewRuntimeBudgetLimits;
  requestLimits: PreviewRuntimeRequestLimits;
  allowedModels: readonly string[];
  maxConcurrency: number;
  audit?: (record: PreviewRuntimeAuditRecord) => void;
  now?: () => number;
}>;

type ValidatedPayload = Readonly<{
  model: string;
  reservedTokens: number;
  payload: Readonly<Record<string, unknown>>;
}>;

type PreviewRuntimeTerminalAudit = Readonly<{
  status: "completed" | "failed" | "budget-denied";
  upstreamStatus?: number;
  budgetReason?: PreviewRuntimeBudgetDenialReason;
}>;

/**
 * Tuple-authorized runtime egress for preview agents. Provider credentials and
 * HTTP routing remain behind outbound ports; this service owns only policy.
 */
export class ApplicationPreviewRuntimeBrokerService implements PreviewRuntimeBrokerPort {
  private readonly allowedModels: ReadonlySet<string>;
  private readonly maxConcurrency: number;
  private readonly now: () => number;
  private active = 0;

  constructor(private readonly deps: PreviewRuntimeBrokerDeps) {
    this.allowedModels = new Set(
      deps.allowedModels.map((model) => model.trim()).filter(Boolean),
    );
    this.maxConcurrency = positiveInteger(
      deps.maxConcurrency,
      "maxConcurrency",
    );
    this.now = deps.now ?? Date.now;
    validateRequestLimits(deps.requestLimits);
    validateBudgetLimits(deps.budgetLimits);
  }

  async complete(input: PreviewRuntimeCompletionRequest) {
    if (!this.deps.capabilities.verify(input)) {
      throw new PreviewRuntimeBrokerError(
        "unauthorized",
        "preview runtime capability is invalid or mismatched",
      );
    }

    const validated = this.validatePayload(input.payload);
    if (!this.allowedModels.has(validated.model)) {
      throw new PreviewRuntimeBrokerError(
        "model-forbidden",
        "preview runtime model is not allowlisted",
      );
    }
    if (this.active >= this.maxConcurrency) {
      throw new PreviewRuntimeBrokerError(
        "capacity",
        "preview runtime concurrency limit reached",
      );
    }
    const auditBase = {
      previewName: input.identity.previewName,
      requestId: input.identity.environmentRequestId,
      platformRevision: input.identity.environmentPlatformRevision,
      sourceRevision: input.identity.environmentSourceRevision,
      catalogDigest: input.identity.catalogDigest,
      model: validated.model,
    } as const;
    this.active += 1;
    const startedAt = this.now();
    let finalized = false;
    const finalize = (terminal: PreviewRuntimeTerminalAudit) => {
      if (finalized) return;
      finalized = true;
      this.active -= 1;
      this.deps.audit?.({
        ...auditBase,
        ...terminal,
        durationMs: Math.max(0, Math.round(this.now() - startedAt)),
      });
    };
    try {
      await this.deps.authority.authorizeRuntimeTuple(input.identity);

      let reservation;
      try {
        reservation = await this.deps.budget.reserve({
          identity: input.identity,
          reservedTokens: validated.reservedTokens,
          limits: this.deps.budgetLimits,
        });
      } catch {
        throw new PreviewRuntimeBrokerError(
          "budget-unavailable",
          "preview runtime budget authority is unavailable",
        );
      }
      if (!reservation.ok) {
        finalize({
          status: "budget-denied",
          budgetReason: reservation.reason,
        });
        throw new PreviewRuntimeBrokerError(
          "budget-exhausted",
          "preview runtime budget is exhausted",
          reservation.reason,
          reservation.retryAfterSeconds,
        );
      }

      this.deps.audit?.({ ...auditBase, status: "accepted" });
      // Reservations are deliberately not refunded: upstream failures still
      // consume capacity and cannot be retried into an unbounded spend loop.
      const response = await this.deps.upstream.complete({
        identity: input.identity,
        payload: validated.payload,
      });
      if (
        response.body &&
        response.contentType.toLowerCase().startsWith("text/event-stream")
      ) {
        return Object.freeze({
          ...response,
          body: wrapPreviewRuntimeStream(response.body, {
            complete: () =>
              finalize({
                status: "completed",
                upstreamStatus: response.status,
              }),
            fail: () =>
              finalize({
                status: "failed",
                upstreamStatus: response.status,
              }),
          }),
        });
      }
      finalize({
        status: "completed",
        upstreamStatus: response.status,
      });
      return response;
    } catch (cause) {
      finalize({ status: "failed" });
      throw cause;
    }
  }

  private validatePayload(
    payload: Readonly<Record<string, unknown>>,
  ): ValidatedPayload {
    if (!isPlainRecord(payload))
      return invalid("request must be a JSON object");
    const limits = this.deps.requestLimits;
    let encoded: string;
    try {
      const serialized = JSON.stringify(payload);
      if (typeof serialized !== "string") {
        return invalid("request must be JSON serializable");
      }
      encoded = serialized;
    } catch {
      return invalid("request must be JSON serializable");
    }
    const encodedBytes = utf8Bytes(encoded);
    if (encodedBytes > limits.maxPayloadBytes) {
      return invalid("preview runtime request payload is too large");
    }
    validateJsonShape(payload, limits.maxContentBytes);
    assertOnlyKeys(payload, TOP_LEVEL_KEYS, "request");

    const model = typeof payload.model === "string" ? payload.model.trim() : "";
    if (!MODEL.test(model)) return invalid("request requires a valid model");
    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
      return invalid("request requires messages");
    }
    if (payload.messages.length > limits.maxMessages) {
      return invalid("request has too many messages");
    }
    for (const message of payload.messages) validateMessage(message, limits);

    optionalBoolean(payload.stream, "stream");
    optionalBoolean(payload.parallel_tool_calls, "parallel_tool_calls");
    validateStreamOptions(payload.stream_options);
    validateBoundedNumber(payload.temperature, "temperature", 0, 2);
    validateBoundedNumber(payload.top_p, "top_p", 0, 1);
    validateBoundedNumber(
      payload.frequency_penalty,
      "frequency_penalty",
      -2,
      2,
    );
    validateBoundedNumber(payload.presence_penalty, "presence_penalty", -2, 2);
    if (
      payload.seed !== undefined &&
      (!Number.isSafeInteger(payload.seed) ||
        (payload.seed as number) < -9_007_199_254_740_991 ||
        (payload.seed as number) > 9_007_199_254_740_991)
    ) {
      return invalid("seed must be a safe integer");
    }
    validateSingleChoice(payload.n, "n");
    validateSingleChoice(payload.best_of, "best_of");
    validateStop(payload.stop, limits.maxContentBytes);
    if (payload.user !== undefined) {
      validateSafeString(payload.user, "user", 256);
    }
    validateTools(payload.tools, limits);
    validateToolChoice(payload.tool_choice);
    validateResponseFormat(payload.response_format, limits.maxToolBytes);
    let kimiReasoningEffort: string | undefined;
    if (model === KIMI_K3_MODEL) {
      kimiReasoningEffort = normalizeKimiK3ReasoningEffort(
        payload.reasoning_effort,
      );
    } else {
      validateReasoningEffort(payload.reasoning_effort);
    }
    if (model === KIMI_K3_MODEL && payload.thinking !== undefined) {
      return invalid("kimi-k3 does not accept the legacy thinking field");
    }
    validateThinking(payload.thinking);

    if (
      payload.max_tokens !== undefined &&
      payload.max_completion_tokens !== undefined
    ) {
      return invalid("set only one completion token limit");
    }
    const tokenKey =
      payload.max_tokens !== undefined
        ? "max_tokens"
        : payload.max_completion_tokens !== undefined
          ? "max_completion_tokens"
          : null;
    const requestedTokens = tokenKey
      ? validatePositiveInteger(payload[tokenKey], tokenKey)
      : limits.defaultCompletionTokens;
    const modelCompletionLimit =
      model === KIMI_K3_MODEL
        ? Math.min(limits.maxCompletionTokens, KIMI_K3_MAX_COMPLETION_TOKENS)
        : limits.maxCompletionTokens;
    const outputTokens = Math.min(requestedTokens, modelCompletionLimit);
    const normalized: Record<string, unknown> = { ...payload, model };
    normalized[tokenKey ?? "max_completion_tokens"] = outputTokens;
    if (model === KIMI_K3_MODEL) {
      normalized.reasoning_effort = kimiReasoningEffort;
      delete normalized.thinking;
    }
    // One token per encoded UTF-8 byte is deliberately conservative for every
    // tokenizer family. JSON syntax and tool schemas are included, not merely
    // visible message text.
    const inputTokenUpperBound = Math.max(
      encodedBytes,
      utf8Bytes(JSON.stringify(normalized)),
    );
    const reservedTokens = inputTokenUpperBound + outputTokens;
    return Object.freeze({
      model,
      reservedTokens,
      payload: Object.freeze(normalized),
    });
  }
}

function wrapPreviewRuntimeStream(
  body: ReadableStream<Uint8Array>,
  lifecycle: Readonly<{
    complete: () => void;
    fail: () => void;
  }>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            try {
              controller.close();
            } finally {
              lifecycle.complete();
            }
            return;
          }
          controller.enqueue(result.value);
        } catch (cause) {
          try {
            controller.error(cause);
          } finally {
            lifecycle.fail();
          }
        }
      },
      async cancel(reason) {
        try {
          // Consumers may cancel after SSE [DONE] without reading transport EOF.
          lifecycle.complete();
        } finally {
          await reader.cancel(reason);
        }
      },
    },
    { highWaterMark: 0 },
  );
}

function validateRequestLimits(limits: PreviewRuntimeRequestLimits): void {
  for (const [name, value] of Object.entries(limits))
    positiveInteger(value, name);
  if (limits.defaultCompletionTokens > limits.maxCompletionTokens) {
    throw new Error(
      "preview runtime defaultCompletionTokens exceeds maxCompletionTokens",
    );
  }
}

function validateBudgetLimits(limits: PreviewRuntimeBudgetLimits): void {
  for (const [name, value] of Object.entries(limits))
    positiveInteger(value, name);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`preview runtime ${name} must be a positive integer`);
  }
  return value;
}

function invalid(message: string): never {
  throw new PreviewRuntimeBrokerError("invalid-request", message);
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return invalid(`${label} contains unsupported fields`);
  }
}

function validateJsonShape(value: unknown, maxStringBytes: number): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      return invalid("request JSON shape is too complex");
    }
    if (
      current === null ||
      typeof current === "boolean" ||
      typeof current === "number"
    ) {
      if (typeof current === "number" && !Number.isFinite(current)) {
        return invalid("request contains a non-finite number");
      }
      return;
    }
    if (typeof current === "string") {
      if (utf8Bytes(current) > maxStringBytes) {
        return invalid("request contains an oversized string");
      }
      return;
    }
    if (Array.isArray(current)) {
      if (current.length > 512) return invalid("request array is too large");
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (!isPlainRecord(current))
      return invalid("request contains a non-JSON value");
    if (Object.keys(current).length > MAX_OBJECT_KEYS) {
      return invalid("request object has too many fields");
    }
    for (const item of Object.values(current)) visit(item, depth + 1);
  };
  visit(value, 0);
}

function validateMessage(
  value: unknown,
  limits: PreviewRuntimeRequestLimits,
): void {
  if (!isPlainRecord(value)) return invalid("message must be an object");
  assertOnlyKeys(
    value,
    new Set([
      "role",
      "content",
      "name",
      "tool_call_id",
      "tool_calls",
      "reasoning_content",
    ]),
    "message",
  );
  if (typeof value.role !== "string" || !MESSAGE_ROLES.has(value.role)) {
    return invalid("message role is invalid");
  }
  if (value.name !== undefined)
    validateSafeString(value.name, "message name", 128);
  if (value.tool_call_id !== undefined) {
    validateSafeString(value.tool_call_id, "tool_call_id", 128);
  }
  if (value.role === "tool" && value.tool_call_id === undefined) {
    return invalid("tool message requires tool_call_id");
  }
  if (value.role !== "tool" && value.tool_call_id !== undefined) {
    return invalid("tool_call_id is valid only on tool messages");
  }
  if (value.reasoning_content !== undefined) {
    if (value.role !== "assistant") {
      return invalid("reasoning_content is valid only on assistant messages");
    }
    if (
      typeof value.reasoning_content !== "string" ||
      utf8Bytes(value.reasoning_content) > limits.maxContentBytes
    ) {
      return invalid("assistant reasoning_content is invalid or too large");
    }
  }
  const toolCalls = value.tool_calls;
  if (toolCalls !== undefined) {
    if (value.role !== "assistant") {
      return invalid("tool_calls is valid only on assistant messages");
    }
    if (
      !Array.isArray(toolCalls) ||
      toolCalls.length === 0 ||
      toolCalls.length > MAX_TOOL_CALLS_PER_MESSAGE
    ) {
      return invalid("assistant tool_calls is invalid");
    }
    for (const call of toolCalls)
      validateToolCall(call, limits.maxContentBytes);
  }
  if (value.content === null) {
    if (value.role !== "assistant" || toolCalls === undefined) {
      return invalid("null content requires assistant tool_calls");
    }
    return;
  }
  validateMessageContent(
    value.content,
    limits.maxContentBytes,
    value.role === "user",
  );
}

function validateMessageContent(
  value: unknown,
  maxBytes: number,
  allowImages: boolean,
): void {
  if (typeof value === "string") {
    if (utf8Bytes(value) > maxBytes)
      return invalid("message content is too large");
    return;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_CONTENT_PARTS
  ) {
    return invalid("message content must be text or bounded text parts");
  }
  let bytes = 0;
  for (const part of value) {
    if (!isPlainRecord(part)) return invalid("message content part is invalid");
    if (["text", "input_text", "output_text"].includes(String(part.type))) {
      assertOnlyKeys(part, new Set(["type", "text"]), "message content part");
      if (typeof part.text !== "string") {
        return invalid("message text content part is invalid");
      }
      bytes += utf8Bytes(part.text);
      continue;
    }
    if (part.type === "image_url") {
      if (!allowImages) {
        return invalid("image_url content is valid only on user messages");
      }
      assertOnlyKeys(
        part,
        new Set(["type", "image_url"]),
        "message image content part",
      );
      bytes += validateInlineImageUrl(part.image_url, maxBytes);
      continue;
    }
    return invalid("message content part type is unsupported");
  }
  if (bytes > maxBytes) return invalid("message content is too large");
}

function validateInlineImageUrl(value: unknown, maxBytes: number): number {
  if (!isPlainRecord(value)) return invalid("image_url must be an object");
  assertOnlyKeys(value, new Set(["url"]), "image_url");
  if (typeof value.url !== "string") {
    return invalid("image_url requires a URL string");
  }
  const url = value.url;
  const bytes = utf8Bytes(url);
  if (bytes > maxBytes) return invalid("image_url is too large");
  const prefix = [...KIMI_INLINE_IMAGE_PREFIXES].find((candidate) =>
    url.startsWith(candidate),
  );
  if (!prefix || !hasCanonicalStandardBase64(url.slice(prefix.length))) {
    return invalid("image_url must be a supported base64 data URI");
  }
  return bytes;
}

function hasCanonicalStandardBase64(value: string): boolean {
  // Repeated-group regexes can exhaust V8's stack on multi-megabyte images.
  if (value.length < 4 || value.length % 4 !== 0) return false;
  let padding = 0;
  if (value.charCodeAt(value.length - 1) === 0x3d) padding += 1;
  if (value.charCodeAt(value.length - 2) === 0x3d) padding += 1;
  const contentLength = value.length - padding;
  let finalValue = 0;
  for (let index = 0; index < contentLength; index += 1) {
    const character = value.charCodeAt(index);
    if (character >= 0x41 && character <= 0x5a) finalValue = character - 0x41;
    else if (character >= 0x61 && character <= 0x7a)
      finalValue = character - 0x61 + 26;
    else if (character >= 0x30 && character <= 0x39)
      finalValue = character - 0x30 + 52;
    else if (character === 0x2b) finalValue = 62;
    else if (character === 0x2f) finalValue = 63;
    else return false;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return false;
  }
  return (
    (padding === 0 && contentLength % 4 === 0) ||
    (padding === 1 && contentLength % 4 === 3 && (finalValue & 0x03) === 0) ||
    (padding === 2 && contentLength % 4 === 2 && (finalValue & 0x0f) === 0)
  );
}

function validateToolCall(value: unknown, maxBytes: number): void {
  if (!isPlainRecord(value)) return invalid("tool call must be an object");
  assertOnlyKeys(value, new Set(["id", "type", "function"]), "tool call");
  validateSafeString(value.id, "tool call id", 128);
  if (value.type !== "function" || !isPlainRecord(value.function)) {
    return invalid("tool call must be a function call");
  }
  assertOnlyKeys(
    value.function,
    new Set(["name", "arguments"]),
    "tool call function",
  );
  validateFunctionName(value.function.name);
  if (
    typeof value.function.arguments !== "string" ||
    utf8Bytes(value.function.arguments) > maxBytes
  ) {
    return invalid("tool call arguments are invalid or too large");
  }
}

function validateTools(
  value: unknown,
  limits: PreviewRuntimeRequestLimits,
): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > limits.maxTools
  ) {
    return invalid("tools must be a non-empty bounded array");
  }
  for (const tool of value) {
    if (!isPlainRecord(tool)) return invalid("tool must be an object");
    if (utf8Bytes(JSON.stringify(tool)) > limits.maxToolBytes) {
      return invalid("tool definition is too large");
    }
    assertOnlyKeys(tool, new Set(["type", "function"]), "tool");
    if (tool.type !== "function" || !isPlainRecord(tool.function)) {
      return invalid("only function tools are supported");
    }
    assertOnlyKeys(
      tool.function,
      new Set(["name", "description", "parameters", "strict"]),
      "tool function",
    );
    validateFunctionName(tool.function.name);
    if (tool.function.description !== undefined) {
      if (
        typeof tool.function.description !== "string" ||
        utf8Bytes(tool.function.description) > limits.maxContentBytes
      ) {
        return invalid("tool description is invalid or too large");
      }
    }
    if (!isPlainRecord(tool.function.parameters)) {
      return invalid("tool parameters must be a JSON schema object");
    }
    optionalBoolean(tool.function.strict, "tool function strict");
  }
}

function validateToolChoice(value: unknown): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    if (!["none", "auto", "required"].includes(value)) {
      return invalid("tool_choice is invalid");
    }
    return;
  }
  if (!isPlainRecord(value)) return invalid("tool_choice is invalid");
  assertOnlyKeys(value, new Set(["type", "function"]), "tool_choice");
  if (value.type !== "function" || !isPlainRecord(value.function)) {
    return invalid("tool_choice function is invalid");
  }
  assertOnlyKeys(value.function, new Set(["name"]), "tool_choice function");
  validateFunctionName(value.function.name);
}

function validateResponseFormat(value: unknown, maxBytes: number): void {
  if (value === undefined) return;
  if (!isPlainRecord(value) || utf8Bytes(JSON.stringify(value)) > maxBytes) {
    return invalid("response_format is invalid or too large");
  }
  if (value.type === "text" || value.type === "json_object") {
    assertOnlyKeys(value, new Set(["type"]), "response_format");
    return;
  }
  if (value.type !== "json_schema" || !isPlainRecord(value.json_schema)) {
    return invalid("response_format type is invalid");
  }
  assertOnlyKeys(value, new Set(["type", "json_schema"]), "response_format");
  assertOnlyKeys(
    value.json_schema,
    new Set(["name", "description", "schema", "strict"]),
    "response_format json_schema",
  );
  validateFunctionName(value.json_schema.name);
  if (!isPlainRecord(value.json_schema.schema)) {
    return invalid("response_format schema must be an object");
  }
  if (value.json_schema.description !== undefined) {
    validateSafeString(
      value.json_schema.description,
      "response format description",
      1024,
    );
  }
  optionalBoolean(value.json_schema.strict, "response format strict");
}

function validateStreamOptions(value: unknown): void {
  if (value === undefined) return;
  if (!isPlainRecord(value)) return invalid("stream_options must be an object");
  assertOnlyKeys(value, new Set(["include_usage"]), "stream_options");
  optionalBoolean(value.include_usage, "stream_options.include_usage");
}

function validateStop(value: unknown, maxBytes: number): void {
  if (value === undefined || value === null) return;
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || values.length === 0 || values.length > 4) {
    return invalid("stop must contain one to four strings");
  }
  if (
    values.some(
      (item) => typeof item !== "string" || utf8Bytes(item) > maxBytes,
    )
  ) {
    return invalid("stop contains an invalid or oversized string");
  }
}

function validateReasoningEffort(value: unknown): void {
  if (
    value !== undefined &&
    !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      String(value),
    )
  ) {
    return invalid("reasoning_effort is invalid");
  }
}

function normalizeKimiK3ReasoningEffort(value: unknown): string {
  if (value === undefined) return "max";
  // This is a provider-wire trust boundary, so invalid direct payloads are
  // rejected instead of receiving the agent-config fallback used upstream.
  if (typeof value !== "string" || !KIMI_K3_REASONING_EFFORTS.has(value)) {
    return invalid("kimi-k3 reasoning_effort must be low, high, or max");
  }
  return value;
}

function validateThinking(value: unknown): void {
  if (value === undefined) return;
  if (!isPlainRecord(value)) return invalid("thinking must be an object");
  assertOnlyKeys(value, new Set(["type"]), "thinking");
  if (value.type !== "disabled") {
    return invalid("preview runtime thinking must be disabled");
  }
}

function optionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    return invalid(`${name} must be boolean`);
  }
}

function validateSingleChoice(value: unknown, name: string): void {
  if (value !== undefined && value !== 1) {
    return invalid(`${name} must equal 1`);
  }
}

function validateBoundedNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum)
  ) {
    return invalid(`${name} is outside its supported range`);
  }
}

function validatePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return invalid(`${name} must be a positive integer`);
  }
  return value as number;
}

function validateSafeString(
  value: unknown,
  name: string,
  maxBytes: number,
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8Bytes(value) > maxBytes ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return invalid(`${name} is invalid or too large`);
  }
}

function validateFunctionName(value: unknown): void {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) {
    return invalid("function name is invalid");
  }
}
