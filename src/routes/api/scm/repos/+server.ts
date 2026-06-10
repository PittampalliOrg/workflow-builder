import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getScmConnection, scmFetchJson } from '$lib/server/scm-connections';

type RepoSummary = {
	name: string;
	fullName: string;
	owner: string;
	description: string;
	provider: 'github' | 'gitea';
	url: string;
};

/**
 * GET /api/scm/repos?connectionExternalId=...&owner=...
 *
 * Lists repositories visible through the selected app connection.
 */
export const GET: RequestHandler = async ({ url }) => {
	const connectionExternalId = url.searchParams.get('connectionExternalId') || '';
	const owner = url.searchParams.get('owner') || '';

	if (!connectionExternalId) return json({ provider: null, repos: [] });

	const connection = await getScmConnection(connectionExternalId);
	if (!connection) return json({ provider: null, repos: [] });

	const repos =
		connection.provider === 'github'
			? await getGitHubRepos(connection, owner)
			: await getGiteaRepos(connection, owner);

	return json({ provider: connection.provider, repos });
};

// Page through the provider's repo list. A single 100-repo page silently
// truncates as soon as personal + org repos exceed it (observed: granting a
// GitHub org dropped 64 personal repos out of the picker). Cap at 5 pages
// (500 repos) to bound latency on giant accounts.
const MAX_REPO_PAGES = 5;

async function getGitHubRepos(
	connection: NonNullable<Awaited<ReturnType<typeof getScmConnection>>>,
	owner: string
): Promise<RepoSummary[]> {
	const data: Array<Record<string, unknown>> = [];
	for (let page = 1; page <= MAX_REPO_PAGES; page++) {
		const batch = await scmFetchJson<Array<Record<string, unknown>>>(
			connection,
			`/user/repos?per_page=100&sort=updated&type=all&page=${page}`
		);
		data.push(...(batch || []));
		if (!batch || batch.length < 100) break;
	}

	return (data || [])
		.map((repo) => ({
			name: String(repo.name || ''),
			fullName: String(repo.full_name || ''),
			owner: String((repo.owner as Record<string, unknown> | undefined)?.login || ''),
			description: String(repo.description || ''),
			provider: 'github' as const,
			url: String(repo.html_url || '')
		}))
		.filter((repo) => repo.name && (!owner || repo.owner === owner))
		.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

async function getGiteaRepos(
	connection: NonNullable<Awaited<ReturnType<typeof getScmConnection>>>,
	owner: string
): Promise<RepoSummary[]> {
	const data: Array<Record<string, unknown>> = [];
	for (let page = 1; page <= MAX_REPO_PAGES; page++) {
		const batch = await scmFetchJson<Array<Record<string, unknown>>>(
			connection,
			`/user/repos?limit=50&page=${page}`
		);
		data.push(...(batch || []));
		if (!batch || batch.length < 50) break;
	}

	return (data || [])
		.map((repo) => ({
			name: String(repo.name || ''),
			fullName: String(repo.full_name || ''),
			owner: String((repo.owner as Record<string, unknown> | undefined)?.login || ''),
			description: String(repo.description || ''),
			provider: 'gitea' as const,
			url: String(repo.html_url || '')
		}))
		.filter((repo) => repo.name && (!owner || repo.owner === owner))
		.sort((a, b) => a.fullName.localeCompare(b.fullName));
}
