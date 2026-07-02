import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { TraceLinkTarget } from "$lib/server/application/ports";
import { requireInternal } from "$lib/server/internal-auth";

type TraceLineageBody = {
	traceId?: string;
	targets?: TraceLinkTarget[];
	source?: string;
	attrs?: Record<string, string>;
};

function normalizeString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isTraceTarget(value: unknown): value is TraceLinkTarget {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const target = value as Partial<TraceLinkTarget>;
	return (
		(target.entityType === "workflow_execution" || target.entityType === "session") &&
		typeof target.entityId === "string"
	);
}

function normalizeAttrs(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!key || raw == null) continue;
		const text = String(raw);
		if (text.trim()) out[key] = text;
	}
	return out;
}

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => null)) as TraceLineageBody | null;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return error(400, "JSON object body required");
	}
	const traceId = normalizeString(body.traceId);
	if (!traceId) return error(400, "traceId is required");
	const targets = Array.isArray(body.targets) ? body.targets.filter(isTraceTarget) : [];
	if (targets.length === 0) return error(400, "at least one valid target is required");

	const result = await getApplicationAdapters().workflowData.upsertTraceLineageLinks({
		traceId,
		targets,
		source: normalizeString(body.source) ?? "primary",
		attrs: normalizeAttrs(body.attrs),
	});
	return json({ ok: true, ...result });
};
