import { env } from "$env/dynamic/private";
import { SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { daprFetch, getDaprSidecarUrl } from "$lib/server/dapr-client";
import {
	redactSecrets,
	setSpanValue,
} from "$lib/server/observability/content";

const DEFAULT_BINDING_NAME = "workflow-data-postgres";
const DEFAULT_DATABASE = "workflow_builder";
const MAX_SPAN_STRING_CHARS = 2_000;
const MAX_SPAN_JSON_CHARS = 4_000;
const MAX_SQL_TEXT_CHARS = 8_000;
const MAX_SAMPLE_ROWS = 10;
const REDACTED = "[REDACTED]";

type DaprPostgresOperation = "exec" | "query" | "close";

export type DaprPostgresBindingResult = {
	metadata: Record<string, string>;
	rows: unknown[][];
	rowsAffected: number | null;
};

export type DaprPostgresBindingCall = {
	operation: DaprPostgresOperation;
	sql?: string;
	params?: unknown[];
	/**
	 * Optional parameter values used only for span content. This lets callers pass
	 * driver-friendly values to Dapr while tracing richer pre-serialization values.
	 */
	spanParams?: unknown[];
	paramNames?: string[];
	summary?: string;
	collection?: string;
	database?: string;
	maxRetries?: number;
};

const tracer = trace.getTracer("workflow-builder.dapr-postgres-binding");

function truncateString(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`;
}

function spanSafeValue(value: unknown): unknown {
	const redacted = redactSecrets(value);
	if (typeof redacted === "string") return truncateString(redacted, MAX_SPAN_STRING_CHARS);
	if (
		redacted == null ||
		typeof redacted === "number" ||
		typeof redacted === "boolean"
	) {
		return redacted;
	}
	try {
		const serialized = JSON.stringify(redacted);
		if (serialized.length <= MAX_SPAN_JSON_CHARS) return redacted;
		return {
			truncated: true,
			preview: truncateString(serialized, MAX_SPAN_JSON_CHARS),
			originalLength: serialized.length,
		};
	} catch {
		return "[unserializable]";
	}
}

export function redactDbParamsForSpan(
	params: unknown[] = [],
	paramNames: string[] = [],
): unknown[] {
	return params.map((param, index) => {
		const key = paramNames[index] || String(index);
		const wrapped = redactSecrets({ [key]: param }) as Record<string, unknown>;
		const value = wrapped[key];
		return value === REDACTED ? REDACTED : spanSafeValue(value);
	});
}

function dbOperationName(sql: string | undefined, fallback: DaprPostgresOperation): string {
	if (!sql) return fallback.toUpperCase();
	const match = sql.trim().match(/^([a-zA-Z]+)/);
	return (match?.[1] || fallback).toUpperCase();
}

function querySummary(input: DaprPostgresBindingCall): string {
	if (input.summary?.trim()) return input.summary.trim();
	const operation = dbOperationName(input.sql, input.operation).toLowerCase();
	return input.collection ? `${input.collection}.${operation}` : operation;
}

function parseMetadata(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object") return {};
	const out: Record<string, string> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		out[key] = String(child ?? "");
	}
	return out;
}

function parseRows(value: unknown): unknown[][] {
	if (value == null || value === "") return [];
	let parsed = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.map((row) => (Array.isArray(row) ? row : [row]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readBindingResponse(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text.trim()) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return { body: text };
	}
}

function rowsAffected(metadata: Record<string, string>): number | null {
	const raw = metadata["rows-affected"];
	if (!raw) return null;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

function setDbAttributes(
	span: Span,
	input: DaprPostgresBindingCall,
	bindingName: string,
	redactedParams: unknown[],
): void {
	const database = input.database || DEFAULT_DATABASE;
	const operationName = dbOperationName(input.sql, input.operation);
	const summary = querySummary(input);
	span.setAttribute("db.system.name", "postgresql");
	// Keep the legacy key during the local service-graph migration.
	span.setAttribute("db.system", "postgresql");
	span.setAttribute("db.namespace", database);
	span.setAttribute("db.operation.name", operationName);
	span.setAttribute("db.query.summary", summary);
	if (input.sql) {
		span.setAttribute("db.query.text", truncateString(input.sql, MAX_SQL_TEXT_CHARS));
	}
	if (input.collection) span.setAttribute("db.collection.name", input.collection);
	span.setAttribute("dapr.operation", "dapr.binding.invoke");
	span.setAttribute("dapr.component", bindingName);
	span.setAttribute("dapr.binding.name", bindingName);
	for (let i = 0; i < redactedParams.length; i += 1) {
		const value = redactedParams[i];
		if (
			value == null ||
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			span.setAttribute(`db.query.parameter.${i}`, String(value));
		}
	}
}

export class DaprPostgresBindingClient {
	constructor(
		private readonly options: {
			bindingName?: string;
			database?: string;
		} = {},
	) {}

	private get bindingName(): string {
		return (
			this.options.bindingName ||
			env.WORKFLOW_DATA_POSTGRES_BINDING?.trim() ||
			DEFAULT_BINDING_NAME
		);
	}

	async invoke(input: DaprPostgresBindingCall): Promise<DaprPostgresBindingResult> {
		const bindingName = this.bindingName;
		const summary = querySummary(input);
		const database = input.database || this.options.database || DEFAULT_DATABASE;
		const params = input.params ?? [];
		const spanParams = input.spanParams ?? params;
		const redactedParams = redactDbParamsForSpan(spanParams, input.paramNames);
		const payload: Record<string, unknown> = { operation: input.operation };
		if (input.sql) {
			payload.metadata = {
				sql: input.sql,
				params: JSON.stringify(params),
			};
		}

		return tracer.startActiveSpan(
			summary,
			{ kind: SpanKind.CLIENT },
			async (span) => {
				setDbAttributes(
					span,
					{ ...input, database, summary },
					bindingName,
					redactedParams,
				);
				setSpanValue(span, "input", {
					operation: input.operation,
					component: bindingName,
					sql: input.sql,
					params: redactedParams,
					paramNames: input.paramNames,
				});

				try {
					const response = await daprFetch(
						`${getDaprSidecarUrl()}/v1.0/bindings/${encodeURIComponent(bindingName)}`,
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(payload),
							maxRetries: input.maxRetries ?? 0,
							captureResponseBodyForSpan: false,
							spanInput: {
								method: "POST",
								target: {
									operation: "dapr.binding.invoke",
									component: bindingName,
									path: "/v1.0/bindings/:name",
								},
								body: {
									operation: input.operation,
									metadata: input.sql
										? {
												sql: input.sql,
												params: redactedParams,
											}
										: undefined,
								},
							},
						},
					);
					const body = await readBindingResponse(response);
					if (!response.ok) {
						throw new Error(
							`Dapr PostgreSQL binding ${input.operation} failed: ${response.status} ${JSON.stringify(body)}`,
						);
					}

					const bodyRecord = isRecord(body) ? body : {};
					const metadata = parseMetadata(bodyRecord.metadata);
					const rows = parseRows("data" in bodyRecord ? bodyRecord.data : body);
					const affected = rowsAffected(metadata);
					if (rows.length > 0) {
						span.setAttribute("db.response.returned_rows", rows.length);
					}
					if (affected != null) {
						span.setAttribute("workflow.db.rows_affected", affected);
					}
					setSpanValue(span, "output", {
						status: response.status,
						metadata,
						rowsAffected: affected,
						returnedRows: rows.length,
						sampleRows: rows.slice(0, MAX_SAMPLE_ROWS).map((row) => spanSafeValue(row)),
					});
					return { metadata, rows, rowsAffected: affected };
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));
					span.recordException(err);
					span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
					setSpanValue(span, "output", {
						ok: false,
						error: err.message,
					});
					throw error;
				} finally {
					span.end();
				}
			},
		);
	}

	query(input: Omit<DaprPostgresBindingCall, "operation">): Promise<DaprPostgresBindingResult> {
		return this.invoke({ ...input, operation: "query" });
	}

	exec(input: Omit<DaprPostgresBindingCall, "operation">): Promise<DaprPostgresBindingResult> {
		return this.invoke({ ...input, operation: "exec" });
	}
}
