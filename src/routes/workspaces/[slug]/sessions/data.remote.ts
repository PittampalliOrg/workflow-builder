import { error } from "@sveltejs/kit";
import { getRequestEvent, query } from "$app/server";
import { getApplicationAdapters } from "$lib/server/application";
import {
	isSessionKind,
	type SessionKind,
} from "$lib/server/application/session-kind";
import type { SessionListPage } from "$lib/server/application/session-commands";
import type { SessionStatus } from "$lib/types/sessions";

export type { SessionListPage } from "$lib/server/application/session-commands";

export type SessionsPageInput = {
	kind?: string | null;
	status?: string | null;
	agentId?: string | null;
	q?: string | null;
	includeArchived?: boolean;
	source?: string | null;
	workflowId?: string | null;
	offset?: number;
	limit?: number;
};

/**
 * Load-more / refresh page for the Sessions list. Mirrors the SSR load in
 * `+page.server.ts`; the first page is SSR'd, this drives pagination and the
 * visibility-gated refresh tick. Project-scoped via the request session.
 */
export const getSessionsPage = query(
	"unchecked",
	async (input: SessionsPageInput): Promise<SessionListPage> => {
		const event = getRequestEvent();
		const userId = event.locals.session?.userId;
		if (!userId) error(401, "Authentication required");
		const kind: SessionKind | undefined =
			input.kind && isSessionKind(input.kind) ? input.kind : undefined;
		const source =
			input.source === "direct" ||
			input.source === "workflow" ||
			input.source === "api"
				? input.source
				: undefined;
		return getApplicationAdapters().sessionCommands.getSessionListPage({
			userId,
			projectId: event.locals.session?.projectId ?? null,
			kind,
			status: (input.status as SessionStatus | null) ?? undefined,
			agentId: input.agentId ?? undefined,
			q: input.q ?? undefined,
			includeArchived: !!input.includeArchived,
			source,
			workflowId: input.workflowId ?? undefined,
			limit: input.limit ?? 50,
			offset: input.offset ?? 0,
		});
	},
);
