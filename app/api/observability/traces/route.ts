import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import {
	extractTraceCorrelation,
	getProjectExecutionIndex,
	resolveTraceContextFromIndex,
} from "@/lib/observability/correlation";
import { searchJaegerTraces } from "@/lib/observability/jaeger-client";
import { normalizeJaegerTraceSummary } from "@/lib/observability/normalization";
import type {
	ObservabilityTraceFilters,
	ObservabilityTraceListResponse,
} from "@/lib/types/observability";

export const dynamic = "force-dynamic";

type CursorPayload = {
	to: string;
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_JAEGER_FETCH_LIMIT = 250;
const TRACE_LOOKBACK_LIMIT = 3000;

function parseDate(raw: string | null): Date | undefined {
	if (!raw) {
		return undefined;
	}
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) {
		return undefined;
	}
	return parsed;
}

function parseLimit(raw: string | null): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	if (Number.isNaN(parsed) || parsed <= 0) {
		return DEFAULT_LIMIT;
	}
	return Math.min(parsed, MAX_LIMIT);
}

function encodeCursor(payload: CursorPayload): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(raw: string | null): CursorPayload | null {
	if (!raw) {
		return null;
	}

	try {
		const decoded = Buffer.from(raw, "base64url").toString("utf8");
		const parsed = JSON.parse(decoded) as CursorPayload;
		if (typeof parsed.to === "string" && parsed.to.length > 0) {
			return parsed;
		}
	} catch {
		return null;
	}

	return null;
}

function getTraceStartMicros(trace: {
	spans?: Array<{ startTime?: number }>;
}): number | null {
	const starts =
		trace.spans
			?.map((span) => span.startTime)
			.filter(
				(value): value is number =>
					typeof value === "number" && Number.isFinite(value),
			) ?? [];

	if (starts.length === 0) {
		return null;
	}

	return Math.min(...starts);
}

function matchesSearch(
	search: string | undefined,
	candidate: {
		traceId: string;
		name: string;
		workflowName: string | null;
		workflowId: string | null;
		executionId: string | null;
		daprInstanceId: string | null;
	},
): boolean {
	if (!search) {
		return true;
	}

	const value = search.trim().toLowerCase();
	if (!value) {
		return true;
	}

	return [
		candidate.traceId,
		candidate.name,
		candidate.workflowName,
		candidate.workflowId,
		candidate.executionId,
		candidate.daprInstanceId,
	].some(
		(field) => typeof field === "string" && field.toLowerCase().includes(value),
	);
}

export async function GET(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const searchParams = new URL(request.url).searchParams;
		const cursor = decodeCursor(searchParams.get("cursor"));
		const entityType = searchParams.get("entityType");
		const entityId = searchParams.get("entityId");
		const search = searchParams.get("search") ?? undefined;
		const limit = parseLimit(searchParams.get("limit"));

		const filters: ObservabilityTraceFilters = {
			entityType:
				entityType === "workflow"
					? ("workflow" as ObservabilityTraceFilters["entityType"])
					: undefined,
			entityId: entityId || undefined,
			from: searchParams.get("from") ?? undefined,
			to: searchParams.get("to") ?? cursor?.to ?? undefined,
			limit,
			search,
			cursor: searchParams.get("cursor") ?? undefined,
		};

		const from = parseDate(filters.from ?? null);
		const to = parseDate(filters.to ?? null);
		const jaegerService =
			searchParams.get("service") ??
			process.env.JAEGER_QUERY_SERVICE ??
			undefined;

		const index = await getProjectExecutionIndex(
			{
				projectId: session.user.projectId,
				userId: session.user.id,
			},
			{
				from,
				to,
				limit: TRACE_LOOKBACK_LIMIT,
			},
		);

		const jaegerLimit = Math.min(
			Math.max(limit * 4, limit + 10),
			MAX_JAEGER_FETCH_LIMIT,
		);

		const traces = await searchJaegerTraces({
			service: jaegerService,
			from,
			to,
			limit: jaegerLimit,
		});

		const items: ObservabilityTraceListResponse["traces"] = [];

		for (const trace of traces) {
			const correlation = extractTraceCorrelation(trace);
			const context = resolveTraceContextFromIndex(correlation, index);

			const hasContext = Boolean(
				context.workflowId || context.executionId || context.daprInstanceId,
			);

			// Hide unmatched traces by default.
			if (!hasContext) {
				continue;
			}

			if (
				filters.entityType === "workflow" &&
				filters.entityId &&
				context.workflowId !== filters.entityId
			) {
				continue;
			}

			const summary = normalizeJaegerTraceSummary(trace, context);
			if (!summary) {
				continue;
			}

			if (!matchesSearch(filters.search, summary)) {
				continue;
			}

			items.push(summary);
		}

		items.sort(
			(a, b) =>
				new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
		);

		const page = items.slice(0, limit);

		const oldestStartMicros = traces
			.map((trace) => getTraceStartMicros(trace))
			.filter((value): value is number => value !== null)
			.sort((a, b) => a - b)[0];

		let nextCursor: string | null = null;
		if (traces.length >= jaegerLimit && oldestStartMicros) {
			const nextTo = new Date(
				Math.max(0, Math.floor(oldestStartMicros / 1000) - 1),
			);
			nextCursor = encodeCursor({ to: nextTo.toISOString() });
		}

		return NextResponse.json<ObservabilityTraceListResponse>({
			traces: page,
			nextCursor,
		});
	} catch (error) {
		console.error("Failed to fetch observability traces:", error);
		return NextResponse.json(
			{ error: "Failed to fetch observability traces" },
			{ status: 500 },
		);
	}
}
