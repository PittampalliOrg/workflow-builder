import { query } from '$app/server';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';
import { normalizeSandboxResponse } from '$lib/utils/sandbox-parse';
import type { Sandbox } from '$lib/types/sandbox';

export const getSandboxes = query(async (): Promise<Sandbox[]> => {
	const response = await openshellRuntimeFetch('/api/v1/sandboxes');
	if (!response.ok) return [];
	const data = await response.json();
	return normalizeSandboxResponse(data);
});
