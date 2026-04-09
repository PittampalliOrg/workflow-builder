import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getScmConnection, scmFetchJson } from '$lib/server/scm-connections';

/**
 * GET /api/scm/issues?connectionExternalId=...&owner=...&repo=...
 *
 * Lists issues visible through the selected app connection.
 */
export const GET: RequestHandler = async ({ url }) => {
	const connectionExternalId = url.searchParams.get('connectionExternalId') || '';
	const owner = url.searchParams.get('owner') || '';
	const repo = url.searchParams.get('repo') || '';

	if (!connectionExternalId || !owner || !repo) {
		return json({ provider: null, issues: [] });
	}

	const connection = await getScmConnection(connectionExternalId);
	if (!connection) return json({ provider: null, issues: [] });

	const issues =
		connection.provider === 'github'
			? await getGitHubIssues(connection, owner, repo)
			: await getGiteaIssues(connection, owner, repo);

	return json({ provider: connection.provider, issues });
};

async function getGiteaIssues(
	connection: NonNullable<Awaited<ReturnType<typeof getScmConnection>>>,
	owner: string,
	repo: string
) {
	const data = await scmFetchJson<Array<Record<string, unknown>>>(
		connection,
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?limit=50&state=open&sort=updated&type=issues`
	);

	return (data || []).map((issue) => ({
		number: issue.number as number,
		title: String(issue.title || ''),
		body: String(issue.body || ''),
		state: String(issue.state || ''),
		user: String((issue.user as Record<string, unknown> | undefined)?.login || ''),
		createdAt: String(issue.created_at || ''),
		url: String(issue.html_url || '')
	}));
}

async function getGitHubIssues(
	connection: NonNullable<Awaited<ReturnType<typeof getScmConnection>>>,
	owner: string,
	repo: string
) {
	const data = await scmFetchJson<Array<Record<string, unknown>>>(
		connection,
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?per_page=50&state=open&sort=updated`
	);

	return (data || [])
		.filter((issue) => !issue.pull_request)
		.map((issue) => ({
			number: issue.number as number,
			title: String(issue.title || ''),
			body: String(issue.body || ''),
			state: String(issue.state || ''),
			user: String((issue.user as Record<string, unknown> | undefined)?.login || ''),
			createdAt: String(issue.created_at || ''),
			url: String(issue.html_url || '')
		}));
}
