export type BoundedJsonBodyErrorCode =
  | "unsupported-media-type"
  | "too-large"
  | "incomplete"
  | "invalid-json";

// Promotion accepts up to 64K UTF-16 code units of Markdown. Four-byte UTF-8
// plus the immutable artifact envelope still stays below this wire bound.
export const PREVIEW_CONTROL_JSON_MAX_BYTES = 384 * 1024;

export class BoundedJsonBodyError extends Error {
  constructor(
    public readonly code: BoundedJsonBodyErrorCode,
    public readonly statusCode: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = "BoundedJsonBodyError";
  }
}

/** Strict streaming JSON-object reader shared by the inbound HTTP adapters. */
export async function readBoundedJsonObject(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("bounded JSON maxBytes is invalid");
  }
  const mediaType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new BoundedJsonBodyError(
      "unsupported-media-type",
      415,
      "content-type must be application/json",
    );
  }

  const declaredHeader = request.headers.get("content-length");
  let declaredLength: number | null = null;
  if (declaredHeader !== null) {
    declaredLength = Number(declaredHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new BoundedJsonBodyError(
        "incomplete",
        400,
        "request content-length is invalid",
      );
    }
    if (declaredLength > maxBytes) {
      throw new BoundedJsonBodyError(
        "too-large",
        413,
        `request body exceeds ${maxBytes} bytes`,
      );
    }
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new BoundedJsonBodyError(
            "too-large",
            413,
            `request body exceeds ${maxBytes} bytes`,
          );
        }
        chunks.push(value);
      }
    } catch (cause) {
      await reader.cancel().catch(() => undefined);
      if (cause instanceof BoundedJsonBodyError) throw cause;
      throw new BoundedJsonBodyError(
        "incomplete",
        400,
        "request body is incomplete",
      );
    }
  }
  if (declaredLength !== null && declaredLength !== total) {
    throw new BoundedJsonBodyError(
      "incomplete",
      400,
      "request body is incomplete",
    );
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(decoded);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new BoundedJsonBodyError(
      "invalid-json",
      400,
      "request body must be a JSON object",
    );
  }
}
