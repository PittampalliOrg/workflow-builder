import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

export const load: LayoutServerLoad = async ({ locals, url, cookies }) => {
	const theme = cookies.get('theme') || 'system';
	const application = getApplicationAdapters();
	const runtimeHandoff = application.runtimeHandoff.current();

	// Don't redirect on auth pages or API routes
	if (url.pathname.startsWith('/auth') || url.pathname.startsWith('/api')) {
		return {
			session: locals.session,
			theme,
			user: null,
			platformRole: 'MEMBER' as const,
			runtimeHandoff
		};
	}

	// Redirect unauthenticated users to sign-in
	if (!locals.session) {
		redirect(302, '/auth/sign-in');
	}

	// Load user profile for sidebar avatar + platformRole so the sidebar can
	// conditionally render the Admin strip and `(admin)/+layout.server.ts`
	// has a single authoritative source to gate on. Admin surfaces stay
	// behind the layout-level 403; this data is UX only.
	let user: { name: string | null; email: string | null; image: string | null } | null = null;
	let platformRole: 'ADMIN' | 'MEMBER' = 'MEMBER';
	if (locals.session?.userId) {
		try {
				const row = await application.workflowData.getUserProfile(
				locals.session.userId
			);
			if (row) {
				user = { name: row.name, email: row.email, image: row.image };
				platformRole = row.platformRole;
			}
		} catch {
			// DB not available
		}
	}

	return {
		session: locals.session,
		theme,
		user,
		platformRole,
		runtimeHandoff
	};
};
