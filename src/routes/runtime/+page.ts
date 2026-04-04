import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, depends }) => {
	depends('app:runtime-introspect');

	const res = await fetch('/api/runtime/introspect');
	if (!res.ok) {
		return {
			introspection: null,
			error: `HTTP ${res.status}`
		};
	}

	return {
		introspection: await res.json(),
		error: null
	};
};
