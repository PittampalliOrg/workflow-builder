import "server-only";

import { getJaegerQueryUrl } from "@/lib/config-service";
import type {
	JaegerTrace,
	JaegerTraceListResponse,
	JaegerTraceResponse,
} from "./jaeger-types";

type SearchJaegerTracesParams = {
	service?: string;
	from?: Date;
	to?: Date;
	limit: number;
};

const DEFAULT_TIMEOUT_MS = 7000;

function toMicros(date: Date): string {
	return Math.trunc(date.getTime() * 1000).toString();
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

async function jaegerGet<T>(
	path: string,
	params?: URLSearchParams,
): Promise<T> {
	const base = (await getJaegerQueryUrl()).trim().replace(/\/$/, "");
	if (!base) {
		throw new Error("Jaeger query URL is not configured");
	}

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
			throw new Error(
				`Jaeger API error (${response.status})${body ? `: ${body}` : ""}`,
			);
		}

		return (await response.json()) as T;
	} finally {
		clearTimeout(timeout);
	}
}

export async function searchJaegerTraces({
	service,
	from,
	to,
	limit,
}: SearchJaegerTracesParams): Promise<JaegerTrace[]> {
	const params = new URLSearchParams();
	if (service) {
		params.set("service", service);
	}

	params.set("limit", String(limit));
	if (from) {
		params.set("start", toMicros(from));
	}
	if (to) {
		params.set("end", toMicros(to));
	}

	const response = await jaegerGet<JaegerTraceListResponse>(
		"/api/traces",
		params,
	);
	return Array.isArray(response.data) ? response.data : [];
}

export async function getJaegerTraceById(
	traceId: string,
): Promise<JaegerTrace | null> {
	const response = await jaegerGet<JaegerTraceResponse>(
		`/api/traces/${encodeURIComponent(traceId)}`,
	);

	if (!Array.isArray(response.data) || response.data.length === 0) {
		return null;
	}

	return response.data[0] ?? null;
}
