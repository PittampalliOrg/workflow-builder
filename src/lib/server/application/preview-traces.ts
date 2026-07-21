import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import {
  PreviewRuntimeIdentityChangedError,
  PreviewTraceQueryTimeoutError,
} from "$lib/server/application/ports";
import type {
  PreviewAccessPolicyPort,
  PreviewControlIdentity,
  PreviewTraceQuery,
  PreviewTraceQueryPort,
  PreviewTraceQueryReceipt,
  PreviewTraceSourceAuthorityPort,
} from "$lib/server/application/ports";
import type { VclusterPreviewRecord } from "$lib/types/dev-previews";

const RANGES = new Set(["15m", "1h", "6h", "24h", "7d"]);
const STATUSES = new Set(["all", "ok", "error"]);
const QUERY_KEYS = new Set(["range", "status", "service", "search", "limit"]);

export class PreviewTraceQueryError extends Error {
  constructor(
    public readonly code: "invalid-request" | "contract-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "PreviewTraceQueryError";
  }
}

export class PreviewTraceQueryUnavailableError extends Error {
  constructor(message = "preview trace query is unavailable") {
    super(message);
    this.name = "PreviewTraceQueryUnavailableError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PreviewTraceQueryError(
      "invalid-request",
      "preview trace query must be an object",
    );
  }
  return value as Record<string, unknown>;
}

function optionalFilter(
  value: unknown,
  name: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new PreviewTraceQueryError(
      "invalid-request",
      `${name} must be a string`,
    );
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new PreviewTraceQueryError("invalid-request", `${name} is invalid`);
  }
  return normalized;
}

/** Normalize the only filters allowed to cross the physical trace-query boundary. */
export function normalizePreviewTraceQuery(value: unknown): PreviewTraceQuery {
  const input = object(value ?? {});
  if (Object.keys(input).some((key) => !QUERY_KEYS.has(key))) {
    throw new PreviewTraceQueryError(
      "invalid-request",
      "preview trace query has unknown fields",
    );
  }
  const range = input.range ?? "1h";
  const status = input.status ?? "all";
  const limit = input.limit ?? 25;
  if (typeof range !== "string" || !RANGES.has(range)) {
    throw new PreviewTraceQueryError(
      "invalid-request",
      "preview trace range is invalid",
    );
  }
  if (typeof status !== "string" || !STATUSES.has(status)) {
    throw new PreviewTraceQueryError(
      "invalid-request",
      "preview trace status is invalid",
    );
  }
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) {
    throw new PreviewTraceQueryError(
      "invalid-request",
      "preview trace limit must be between 1 and 100",
    );
  }
  return Object.freeze({
    range: range as PreviewTraceQuery["range"],
    status: status as PreviewTraceQuery["status"],
    service: optionalFilter(input.service, "preview trace service", 128),
    search: optionalFilter(input.search, "preview trace search", 160),
    limit: Number(limit),
  });
}

export function previewTraceIdentityFromRecord(
  preview: VclusterPreviewRecord,
): PreviewControlIdentity {
  try {
    return validatePreviewControlIdentity({
      previewName: preview.name,
      environmentRequestId:
        typeof preview.provenance?.requestId === "string"
          ? preview.provenance.requestId
          : "",
      environmentPlatformRevision: preview.platformRevision ?? "",
      environmentSourceRevision: preview.sourceRevision ?? "",
      catalogDigest: (preview.catalogDigest ?? "") as `sha256:${string}`,
    });
  } catch {
    throw new PreviewTraceQueryError(
      "contract-mismatch",
      "preview trace query requires a complete immutable identity",
    );
  }
}

function sameIdentity(
  left: PreviewControlIdentity,
  right: PreviewControlIdentity,
): boolean {
  return (
    left.previewName === right.previewName &&
    left.environmentRequestId === right.environmentRequestId &&
    left.environmentPlatformRevision === right.environmentPlatformRevision &&
    left.environmentSourceRevision === right.environmentSourceRevision &&
    left.catalogDigest === right.catalogDigest
  );
}

function assertReceipt(
  receipt: PreviewTraceQueryReceipt,
  expected: PreviewControlIdentity,
): PreviewTraceQueryReceipt {
  if (!sameIdentity(receipt.identity, expected)) {
    throw new PreviewTraceQueryError(
      "contract-mismatch",
      "preview trace query returned a mismatched generation",
    );
  }
  return receipt;
}

/** User-facing use case: owner/admin authorization followed by an exact-tuple query. */
export class ApplicationPreviewTraceService {
  constructor(
    private readonly deps: Readonly<{
      access: PreviewAccessPolicyPort;
      traces: PreviewTraceQueryPort;
    }>,
  ) {}

  async list(
    input: Readonly<{
      name: string;
      actorUserId: string;
      query: unknown;
    }>,
  ): Promise<PreviewTraceQueryReceipt> {
    const access = await this.deps.access.authorize({
      name: input.name,
      actorUserId: input.actorUserId,
    });
    const identity = previewTraceIdentityFromRecord(access.preview);
    const query = normalizePreviewTraceQuery(input.query);
    try {
      return assertReceipt(
        await this.deps.traces.query({ identity, query }),
        identity,
      );
    } catch (cause) {
      if (
        cause instanceof PreviewTraceQueryError ||
        cause instanceof PreviewTraceQueryTimeoutError ||
        cause instanceof PreviewRuntimeIdentityChangedError
      )
        throw cause;
      throw new PreviewTraceQueryUnavailableError(
        cause instanceof Error ? cause.message : undefined,
      );
    }
  }
}

/** Physical-broker use case: source authority remains outside the ClickHouse adapter. */
export class ApplicationPreviewTraceBrokerService {
  constructor(
    private readonly deps: Readonly<{
      authority: PreviewTraceSourceAuthorityPort;
      traces: PreviewTraceQueryPort;
    }>,
  ) {}

  async list(
    input: Readonly<{
      identity: PreviewControlIdentity;
      query: unknown;
    }>,
  ): Promise<PreviewTraceQueryReceipt> {
    const identity = validatePreviewControlIdentity(input.identity);
    const query = normalizePreviewTraceQuery(input.query);
    await this.deps.authority.authorizeTraceTuple(identity);
    try {
      return assertReceipt(
        await this.deps.traces.query({ identity, query }),
        identity,
      );
    } catch (cause) {
      if (
        cause instanceof PreviewTraceQueryError ||
        cause instanceof PreviewTraceQueryTimeoutError ||
        cause instanceof PreviewRuntimeIdentityChangedError
      )
        throw cause;
      throw new PreviewTraceQueryUnavailableError(
        cause instanceof Error ? cause.message : undefined,
      );
    }
  }
}
