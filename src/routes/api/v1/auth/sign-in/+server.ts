import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { users, userIdentities, platforms, projects } from '$lib/server/db/schema';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, generateTokens, shouldUseSecureCookies } from '$lib/server/auth';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const body = await request.json();
	const { email, password } = body;

	if (!email || !password) {
		return error(400, 'Email and password are required');
	}

	if (!db) {
		return json({ message: 'Database not configured' }, { status: 503 });
	}

	// Find user by email
	const [user] = await db
		.select()
		.from(users)
		.where(eq(users.email, email))
		.limit(1);

	if (!user) {
		return json({ message: 'Invalid email or password' }, { status: 400 });
	}

	// Find identity with password
	const [identity] = await db
		.select()
		.from(userIdentities)
		.where(eq(userIdentities.userId, user.id))
		.limit(1);

	if (!identity?.password) {
		return json({ message: 'Invalid email or password' }, { status: 400 });
	}

	// Verify password (bcrypt)
	const bcrypt = await import('bcryptjs');
	let valid = false;
	try {
		valid = await bcrypt.compare(password, identity.password);
	} catch {
		// Not a valid bcrypt hash — try scrypt fallback (Better Auth legacy)
		if (identity.password.includes(':')) {
			try {
				const { scryptSync } = await import('node:crypto');
				const [salt, storedHash] = identity.password.split(':');
				const derivedHash = scryptSync(password, salt, 64).toString('hex');
				valid = derivedHash === storedHash;
			} catch {
				// scrypt failed
			}
		}
	}

	if (!valid) {
		return json({ message: 'Invalid email or password' }, { status: 400 });
	}

	// Get platform and project
	const platformId = user.platformId || (await db.select().from(platforms).limit(1))?.[0]?.id;
	const [project] = await db
		.select()
		.from(projects)
		.where(eq(projects.ownerId, user.id))
		.limit(1);

	if (!platformId) {
		return json({ message: 'Platform not configured' }, { status: 500 });
	}

	// Generate JWT tokens
	const tokenVersion = identity.tokenVersion;
	const projectId = project?.id || 'default';

	let accessToken: string;
	let refreshToken: string;
	try {
		({ accessToken, refreshToken } = await generateTokens(
			user.id,
			user.email!,
			platformId,
			projectId,
			tokenVersion
		));
	} catch (err) {
		return json({ message: 'JWT signing key not configured' }, { status: 500 });
	}

	// Set cookies
	const secure = shouldUseSecureCookies(request);
	cookies.set(ACCESS_TOKEN_COOKIE, accessToken, {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'lax',
		maxAge: 60 * 15
	});
	cookies.set(REFRESH_TOKEN_COOKIE, refreshToken, {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'lax',
		maxAge: 60 * 60 * 24 * 7
	});

	return json({
		user: {
			id: user.id,
			email: user.email,
			name: user.name,
			image: user.image
		},
		accessToken
	});
};
