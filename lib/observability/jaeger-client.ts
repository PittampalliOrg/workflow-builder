import "server-only";

import { getJaegerQueryUrl } from "@/lib/config-service";
import type {
	JaegerSpan,
	JaegerTag,
	JaegerTrace,
	OtlpAnyValue,
	OtlpKeyValue,
	OtlpResourceSpans,
	OtlpSpan,
	TempoSearchResponse,
	TempoSearchTrace,
	TempoTraceResponse,
} from "./jaeger-types";

type SearchJaegerTracesParams = {
	service?: string;
	tags?: string[];
	from?: Date;
	to?: Date;
	limit: number;
};

const DEFAULT_TIMEOUT_MS = 7000;
const DEFAULT_TEMPO_QUERY_URL =
	"http://tempo.observability.svc.cluster.local:3200";
const DEFAULT_TEMPO_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const TEMPO_TRACE_FETCH_CONCURRENCY = 8;

class TempoApiError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "TempoApiError";
		this.status = status;
	}
}

function toUnixSeconds(date: Date): string {
	return Math.trunc(date.getTime() / 1000).toString();
}

function parseOptionalHeaders(raw: string | undefined): HeadersInit {
	if (!raw) {
		return {};
	}

	const headers: Record<string, string> = {};

	for (const pair of raw.split(",")) {
		const [k, ...rest] = pair.split("=");
		const key = k?.trim();
		const value = rest.join("=").trim();

		if (key && value) {
			headers[key] = value;
		}
	}

	return headers;
}

function normalizeBaseUrl(url: string): string {
	return url.trim().replace(/\/$/, "");
}

async function getTempoQueryUrl(): Promise<string> {
	const explicit = process.env.TEMPO_QUERY_URL?.trim();
	if (explicit) {
		return normalizeBaseUrl(explicit);
	}

	const configured = (await getJaegerQueryUrl()).trim();
	if (!configured || configured.includes("jaeger-query")) {
		return DEFAULT_TEMPO_QUERY_URL;
	}

	return normalizeBaseUrl(configured);
}

async function tempoGet<T>(path: string, params?: URLSearchParams): Promise<T> {
	const base = await getTempoQueryUrl();
	const qs = params?.toString();
	const url = `${base}${path}${qs ? `?${qs}` : ""}`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			method: "GET",
			cache: "no-store",
			headers: {
				Accept: "application/json",
				...parseOptionalHeaders(process.env.JAEGER_QUERY_HEADERS),
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new TempoApiError(
				`Tempo API error (${response.status})${body ? `: ${body}` : ""}`,
				response.status,
			);
		}

		return (await response.json()) as T;
	} finally {
		clearTimeout(timeout);
	}
}

function isHex(value: string): boolean {
	return /^[0-9a-fA-F]+$/.test(value);
}

function decodeBase64ToHex(value: string, bytes: number): string | null {
	try {
		const decoded = Buffer.from(value, "base64");
		if (decoded.length !== bytes) {
			return null;
		}
		return decoded.toString("hex");
	} catch {
		return null;
	}
}

function normalizeTraceId(value: string | undefined): string | null {
	if (!value || !value.trim()) {
		return null;
	}

	const trimmed = value.trim();
	if (isHex(trimmed)) {
		return trimmed.toLowerCase().padStart(32, "0");
	}

	const decoded = decodeBase64ToHex(trimmed, 16);
	if (decoded) {
		return decoded;
	}

	return trimmed;
}

function normalizeSpanId(value: string | undefined): string | null {
	if (!value || !value.trim()) {
		return null;
	}

	const trimmed = value.trim();
	if (isHex(trimmed)) {
		return trimmed.toLowerCase().padStart(16, "0");
	}

	const decoded = decodeBase64ToHex(trimmed, 8);
	if (decoded) {
		return decoded;
	}

	return trimmed;
}

function unixNanoToMicros(
	value: string | number | undefined,
): number | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}

	try {
		const asBigInt =
			typeof value === "number" ? BigInt(Math.trunc(value)) : BigInt(value);
		if (asBigInt < BigInt(0)) {
			return undefined;
		}
		const micros = asBigInt / BigInt(1000);
		if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
			return undefined;
		}
		return Number(micros);
	} catch {
		return undefined;
	}
}

function otlpAnyValueToUnknown(value: OtlpAnyValue | undefined): unknown {
	if (!value || typeof value !== "object") {
		return null;
	}

	if (typeof value.stringValue === "string") {
		return value.stringValue;
	}

	if (typeof value.boolValue === "boolean") {
		return value.boolValue;
	}

	if (
		typeof value.intValue === "string" ||
		typeof value.intValue === "number"
	) {
		return value.intValue;
	}

	if (typeof value.doubleValue === "number") {
		return value.doubleValue;
	}

	if (Array.isArray(value.arrayValue?.values)) {
		return value.arrayValue.values.map((entry) => otlpAnyValueToUnknown(entry));
	}

	if (Array.isArray(value.kvlistValue?.values)) {
		return Object.fromEntries(
			value.kvlistValue.values
				.map((entry) => {
					if (!entry.key) {
						return null;
					}
					return [entry.key, otlpAnyValueToUnknown(entry.value)] as const;
				})
				.filter((entry): entry is readonly [string, unknown] => Boolean(entry)),
		);
	}

	if (typeof value.bytesValue === "string") {
		return value.bytesValue;
	}

	return null;
}

function otlpAttributesToTags(
	attributes: OtlpKeyValue[] | undefined,
): JaegerTag[] {
	if (!Array.isArray(attributes)) {
		return [];
	}

	return attributes.reduce<JaegerTag[]>((tags, attribute) => {
		if (!attribute.key) {
			return tags;
		}
		tags.push({
			key: attribute.key,
			value: otlpAnyValueToUnknown(attribute.value),
		});
		return tags;
	}, []);
}

function getResourceStringAttribute(
	attributes: OtlpKeyValue[] | undefined,
	key: string,
): string | null {
	if (!Array.isArray(attributes)) {
		return null;
	}

	const value = attributes.find((attribute) => attribute.key === key)?.value;
	if (typeof value?.stringValue === "string" && value.stringValue.trim()) {
		return value.stringValue;
	}

	return null;
}

function spanKindToTag(kind: string | number | undefined): string | null {
	if (typeof kind === "string" && kind.trim()) {
		const normalized = kind.trim().toUpperCase();
		if (normalized.startsWith("SPAN_KIND_")) {
			return normalized.replace("SPAN_KIND_", "").toLowerCase();
		}
		return normalized.toLowerCase();
	}

	if (typeof kind !== "number") {
		return null;
	}

	switch (kind) {
		case 1:
			return "internal";
		case 2:
			return "server";
		case 3:
			return "client";
		case 4:
			return "producer";
		case 5:
			return "consumer";
		default:
			return null;
	}
}

function statusCodeToTag(
	code: string | number | undefined,
): "OK" | "ERROR" | null {
	if (typeof code === "string" && code.trim()) {
		const normalized = code.trim().toUpperCase();
		if (normalized.includes("ERROR")) {
			return "ERROR";
		}
		if (normalized.includes("OK")) {
			return "OK";
		}
	}

	if (typeof code === "number") {
		if (code === 2) {
			return "ERROR";
		}
		if (code === 1) {
			return "OK";
		}
	}

	return null;
}

function getTempoResourceSpans(
	response: TempoTraceResponse,
): OtlpResourceSpans[] {
	if (Array.isArray(response.trace?.resourceSpans)) {
		return response.trace.resourceSpans;
	}

	if (Array.isArray(response.batches)) {
		return response.batches;
	}

	return [];
}

function convertTempoTraceToJaeger(
	response: TempoTraceResponse,
	traceIdHint: string,
): JaegerTrace | null {
	const resourceSpans = getTempoResourceSpans(response);
	if (resourceSpans.length === 0) {
		return null;
	}

	const processes: Record<string, { serviceName: string; tags: JaegerTag[] }> =
		{};
	const processIdByService = new Map<string, string>();
	const spans: NonNullable<JaegerTrace["spans"]> = [];
	const normalizedHint = normalizeTraceId(traceIdHint);

	for (const resourceSpan of resourceSpans) {
		const resourceAttributes = resourceSpan.resource?.attributes;
		const serviceName =
			getResourceStringAttribute(resourceAttributes, "service.name") ??
			"unknown-service";

		let processId = processIdByService.get(serviceName);
		if (!processId) {
			processId = `p${processIdByService.size + 1}`;
			processIdByService.set(serviceName, processId);
			processes[processId] = {
				serviceName,
				tags: otlpAttributesToTags(resourceAttributes),
			};
		}

		for (const scope of resourceSpan.scopeSpans ?? []) {
			for (const span of scope.spans ?? []) {
				const converted = convertTempoSpan(span, normalizedHint, processId);
				if (converted) {
					spans.push(converted);
				}
			}
		}
	}

	if (spans.length === 0) {
		return null;
	}

	const traceId =
		normalizeTraceId(spans[0]?.traceID ?? undefined) ??
		normalizedHint ??
		spans[0]?.traceID ??
		traceIdHint;

	return {
		traceID: traceId,
		spans,
		processes,
	};
}

function convertTempoSpan(
	span: OtlpSpan,
	traceIdHint: string | null,
	processId: string,
): JaegerSpan | null {
	const traceId = normalizeTraceId(span.traceId) ?? traceIdHint;
	const spanId = normalizeSpanId(span.spanId);
	if (!traceId || !spanId) {
		return null;
	}

	const startTime = unixNanoToMicros(span.startTimeUnixNano);
	const endTime = unixNanoToMicros(span.endTimeUnixNano);
	const duration =
		typeof startTime === "number" && typeof endTime === "number"
			? Math.max(0, endTime - startTime)
			: 0;

	const tags = otlpAttributesToTags(span.attributes);

	const kind = spanKindToTag(span.kind);
	if (kind) {
		tags.push({ key: "span.kind", value: kind });
	}

	const status = statusCodeToTag(span.status?.code);
	if (status) {
		tags.push({ key: "otel.status_code", value: status });
		if (status === "ERROR") {
			tags.push({ key: "error", value: true });
		}
	}

	const parentSpanId = normalizeSpanId(span.parentSpanId);

	return {
		traceID: traceId,
		spanID: spanId,
		operationName: span.name ?? "span",
		startTime,
		duration,
		processID: processId,
		tags,
		references: parentSpanId
			? [
					{
						refType: "CHILD_OF",
						traceID: traceId,
						spanID: parentSpanId,
					},
				]
			: [],
	};
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	mapper: (item: T) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) {
		return [];
	}

	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		async () => {
			while (nextIndex < items.length) {
				const currentIndex = nextIndex;
				nextIndex += 1;
				results[currentIndex] = await mapper(items[currentIndex] as T);
			}
		},
	);

	await Promise.all(workers);
	return results;
}

function extractSearchTraceId(trace: TempoSearchTrace): string | null {
	const id = trace.traceID ?? trace.traceId;
	if (typeof id === "string" && id.trim()) {
		return id.trim();
	}
	return null;
}

function buildTempoSearchParams({
	service,
	tags,
	from,
	to,
	limit,
}: SearchJaegerTracesParams): URLSearchParams {
	const params = new URLSearchParams();
	params.set("limit", String(limit));

	const tagFilters: string[] = [];
	if (service) {
		tagFilters.push(`service.name=${service}`);
	}
	for (const tag of tags ?? []) {
		if (typeof tag !== "string") {
			continue;
		}
		const trimmed = tag.trim();
		if (trimmed.length > 0) {
			tagFilters.push(trimmed);
		}
	}
	if (tagFilters.length > 0) {
		params.set("tags", tagFilters.join(" "));
	}

	if (from || to) {
		const end = to ?? new Date();
		let start = from ?? new Date(end.getTime() - DEFAULT_TEMPO_LOOKBACK_MS);

		if (start.getTime() >= end.getTime()) {
			start = new Date(Math.max(0, end.getTime() - 1000));
		}

		params.set("start", toUnixSeconds(start));
		params.set("end", toUnixSeconds(end));
	}

	return params;
}

export async function searchJaegerTraces({
	service,
	tags,
	from,
	to,
	limit,
}: SearchJaegerTracesParams): Promise<JaegerTrace[]> {
	const searchResponse = await tempoGet<TempoSearchResponse>(
		"/api/search",
		buildTempoSearchParams({ service, tags, from, to, limit }),
	);

	const traceIds = Array.from(
		new Set(
			(searchResponse.traces ?? [])
				.map(extractSearchTraceId)
				.filter((traceId): traceId is string => Boolean(traceId)),
		),
	);

	const traces = await mapWithConcurrency(
		traceIds,
		TEMPO_TRACE_FETCH_CONCURRENCY,
		async (traceId) => {
			try {
				const response = await tempoGet<TempoTraceResponse>(
					`/api/traces/${encodeURIComponent(traceId)}`,
				);
				return convertTempoTraceToJaeger(response, traceId);
			} catch (error) {
				if (error instanceof TempoApiError && error.status === 404) {
					return null;
				}
				throw error;
			}
		},
	);

	return traces.filter((trace): trace is JaegerTrace => Boolean(trace));
}

export async function getJaegerTraceById(
	traceId: string,
): Promise<JaegerTrace | null> {
	const response = await tempoGet<TempoTraceResponse>(
		`/api/traces/${encodeURIComponent(traceId)}`,
	);

	return convertTempoTraceToJaeger(response, traceId);
}
