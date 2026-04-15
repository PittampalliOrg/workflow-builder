import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { getSession } from '$lib/server/auth';

const authHandle: Handle = async ({ event, resolve }) => {
	const session = await getSession(event.request, event.cookies);

	event.locals.session = session
		? { userId: session.user.id, email: session.user.email, projectId: session.user.projectId }
		: null;

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

export const handle = sequence(authHandle, corsHandle);
