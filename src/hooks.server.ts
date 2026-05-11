import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { projectMembers } from '$lib/server/db/schema';
import { getSession } from '$lib/server/auth';
import { ensureStartupReady } from '$lib/server/startup';
import { resolveWorkspaceProjectId } from '$lib/server/workspaces/resolve';

// Kick the boot sequence at module load (runs once per server process). We
// don't await at module level so request handling isn't blocked if the DB is
// slow to answer — the startupHandle below gates every request on it.
ensureStartupReady().catch(() => {
	/* already logged */
});

const startupHandle: Handle = async ({ event, resolve }) => {
	try {
		await ensureStartupReady();
	} catch {
		/* logged in startup.ts; let the request proceed so the error surfaces naturally */
	}
	return resolve(event);
};

const authHandle: Handle = async ({ event, resolve }) => {
	const session = await getSession(event.request, event.cookies);

	event.locals.session = session
		? {
				userId: session.user.id,
				email: session.user.email,
				projectId: session.user.projectId,
				platformId: session.user.platformId,
			}
		: null;

	// Stale-JWT healing: when the JWT's `projectId` no longer exists in
	// project_members for this user (e.g. the database was reseeded but
	// the browser still holds an older signed JWT), the membership check
	// in resolveWorkspaceProjectId silently returns null and every
	// /workspaces/[slug] page 404s, including the OAuth callback resume.
	// Detect this case once per request, look up any project the user is
	// currently a member of, and patch locals.session.projectId in-place.
	// The JWT itself isn't rotated here — that happens on the next
	// /api/v1/auth/refresh — but the rest of the request sees a valid
	// projectId so the user can actually use the app.
	if (event.locals.session && db) {
		try {
			const [row] = await db
				.select({ projectId: projectMembers.projectId })
				.from(projectMembers)
				.where(
					and(
						eq(projectMembers.projectId, event.locals.session.projectId),
						eq(projectMembers.userId, event.locals.session.userId),
					),
				)
				.limit(1);
			if (!row) {
				const [fallback] = await db
					.select({ projectId: projectMembers.projectId })
					.from(projectMembers)
					.where(eq(projectMembers.userId, event.locals.session.userId))
					.limit(1);
				if (fallback) {
					event.locals.session = {
						...event.locals.session,
						projectId: fallback.projectId,
					};
				}
			}
		} catch {
			/* membership check is best-effort — never block the request */
		}
	}

	// CMA-parity workspace scope: when a request carries an X-Workspace
	// header (attached by the client-side fetch wrapper for any URL
	// under /workspaces/{slug}/…), OR when the page URL itself is
	// workspace-scoped, resolve the slug to the authoritative projectId
	// via project_members and override locals.session.projectId for this
	// request. Bad slugs (non-member access) silently fall back to the
	// JWT default — the layout-level guard at /workspaces/[slug]/
	// converts that into a visible 404 for page requests.
	if (event.locals.session) {
		const headerSlug = event.request.headers.get('x-workspace')?.trim();
		const urlMatch = event.url.pathname.match(/^\/workspaces\/([^/]+)\/?/);
		const slug = headerSlug || urlMatch?.[1] || null;
		if (slug && slug !== event.locals.session.projectId) {
			try {
				const resolved = await resolveWorkspaceProjectId(
					slug,
					event.locals.session.userId,
					event.locals.session.projectId,
				);
				if (resolved && resolved !== event.locals.session.projectId) {
					event.locals.session = {
						...event.locals.session,
						projectId: resolved,
					};
				}
			} catch {
				/* ignore — membership check failures don't block the request */
			}
		}
	}

	return resolve(event);
};

const corsHandle: Handle = async ({ event, resolve }) => {
	// Handle preflight requests
	if (event.request.method === 'OPTIONS' && event.url.pathname.startsWith('/api/')) {
		return new Response(null, {
			status: 204,
			headers: {
				'access-control-allow-origin': '*',
				'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
				'access-control-allow-headers': 'Content-Type, Authorization',
				'access-control-max-age': '86400'
			}
		});
	}

	const response = await resolve(event);

	if (event.url.pathname.startsWith('/api/')) {
		response.headers.set('access-control-allow-origin', '*');
		response.headers.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
		response.headers.set('access-control-allow-headers', 'Content-Type, Authorization');
	}

	return response;
};

export const handle = sequence(startupHandle, authHandle, corsHandle);
