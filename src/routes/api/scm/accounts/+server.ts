import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getScmConnection, scmFetchJson } from '$lib/server/scm-connections';

type OwnerOption = {
	login: string;
	type: 'user' | 'org';
	label: string;
};

export const GET: RequestHandler = async ({ url }) => {
	const connectionExternalId = url.searchParams.get('connectionExternalId') || '';
	if (!connectionExternalId) return json({ provider: null, owners: [] });

	const connection = await getScmConnection(connectionExternalId);
	if (!connection) return json({ provider: null, owners: [] });

	const owners =
		connection.provider === 'github'
			? await loadGitHubOwners(connection)
			: await loadGiteaOwners(connection);

	return json({
		provider: connection.provider,
		owners
	});
};

async function loadGitHubOwners(
	connection: NonNullable<Awaited<ReturnType<typeof getScmConnection>>>
): Promise<OwnerOption[]> {
	const [user, orgs] = await Promise.all([
		scmFetchJson<Record<string, unknown>>(connection, '/user'),
		scmFetchJson<Array<Record<string, unknown>>>(connection, '/user/orgs?per_page=100')
	]);

	const owners = new Map<string, OwnerOption>();
	const login = typeof user?.login === 'string' ? user.login : null;
	if (login) {
		owners.set(login, { login, type: 'user', label: login });
	}

	for (const org of orgs || []) {
		const orgLogin = typeof org.login === 'string' ? org.login : null;
		if (!orgLogin) continue;
		owners.set(orgLogin, { login: orgLogin, type: 'org', label: orgLogin });
	}

	return [...owners.values()].sort((a, b) => a.label.localeCompare(b.label));
}

async function loadGiteaOwners(
	connection: NonNullable<Awaited<ReturnType<typeof getScmConnection>>>
): Promise<OwnerOption[]> {
	const [user, orgs] = await Promise.all([
		scmFetchJson<Record<string, unknown>>(connection, '/user'),
		scmFetchJson<Array<Record<string, unknown>>>(connection, '/user/orgs?limit=100')
	]);

	const owners = new Map<string, OwnerOption>();
	const login = typeof user?.login === 'string' ? user.login : null;
	if (login) {
		owners.set(login, { login, type: 'user', label: login });
	}

	for (const org of orgs || []) {
		const orgLogin = typeof org.username === 'string' ? org.username : typeof org.name === 'string' ? org.name : null;
		if (!orgLogin) continue;
		owners.set(orgLogin, { login: orgLogin, type: 'org', label: orgLogin });
	}

	return [...owners.values()].sort((a, b) => a.label.localeCompare(b.label));
}
