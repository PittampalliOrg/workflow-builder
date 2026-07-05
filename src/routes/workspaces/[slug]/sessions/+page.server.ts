import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import {
	isSessionKind,
	type SessionKind,
} from "$lib/server/application/session-kind";
import type { SessionStatus } from "$lib/types/sessions";

/** One load-more page. Kept in sync with `data.remote.ts`. */
const SESSIONS_PAGE_SIZE = 50;

const SESSION_STATUSES: SessionStatus[] = [
	"rescheduling",
	"running",
	"idle",
	"paused",
	"terminated",
];

export type SessionsFilters = {
	kind: SessionKind | null;
	status: SessionStatus | null;
	agentId: string | null;
	q: string;
	includeArchived: boolean;
	source: "direct" | "workflow" | "api" | null;
	workflowId: string | null;
};

function parseSessionsFilters(url: URL): SessionsFilters {
	const kindParam = url.searchParams.get("kind");
	const statusParam = url.searchParams.get("status");
	const sourceParam = url.searchParams.get("source");
	return {
		kind: kindParam && isSessionKind(kindParam) ? kindParam : null,
		status:
			statusParam && SESSION_STATUSES.includes(statusParam as SessionStatus)
				? (statusParam as SessionStatus)
				: null,
		agentId: url.searchParams.get("agentId") || null,
		q: url.searchParams.get("q") ?? "",
		includeArchived: url.searchParams.get("includeArchived") === "true",
		source:
			sourceParam === "direct" ||
			sourceParam === "workflow" ||
			sourceParam === "api"
				? sourceParam
				: null,
		workflowId: url.searchParams.get("workflowId") || null,
	};
}

/**
 * SSR the first page of the dedicated Sessions list so the table paints with
 * rows (no client-fetch flash) and unauthenticated requests 401 pre-paint.
 * Filters come from URL params (shareable / editor deep-links); load-more and
 * live refresh continue through the `getSessionsPage` remote function.
 */
export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.session?.userId) error(401, "Authentication required");
	const filters = parseSessionsFilters(url);
	const page = await getApplicationAdapters().sessionCommands.getSessionListPage({
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
		kind: filters.kind ?? undefined,
		status: filters.status ?? undefined,
		agentId: filters.agentId ?? undefined,
		q: filters.q || undefined,
		includeArchived: filters.includeArchived,
		source: filters.source ?? undefined,
		workflowId: filters.workflowId ?? undefined,
		limit: SESSIONS_PAGE_SIZE,
		offset: 0,
	});
	return { page, pageSize: SESSIONS_PAGE_SIZE, filters };
};
