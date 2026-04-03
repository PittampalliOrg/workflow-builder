import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export const load: LayoutServerLoad = async ({ locals, url, cookies }) => {
	const theme = cookies.get('theme') || 'system';

	// Don't redirect on auth pages or API routes
	if (url.pathname.startsWith('/auth') || url.pathname.startsWith('/api')) {
		return { session: locals.session, theme, user: null };
	}

	// Redirect unauthenticated users to sign-in
	if (!locals.session) {
		redirect(302, '/auth/sign-in');
	}

	// Load user profile for sidebar avatar
	let user: { name: string | null; email: string | null; image: string | null } | null = null;
	if (locals.session?.userId && db) {
		try {
			const [row] = await db
				.select({ name: users.name, email: users.email, image: users.image })
				.from(users)
				.where(eq(users.id, locals.session.userId))
				.limit(1);
			user = row || null;
		} catch {
			// DB not available
		}
	}

	return {
		session: locals.session,
		theme,
		user
	};
};
