import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';

/**
 * GET /api/scm/issues?provider=github|gitea&owner=...&repo=...
 *
 * Lists issues for a repository from GitHub or Gitea.
 */
export const GET: RequestHandler = async ({ url }) => {
	const provider = url.searchParams.get('provider') || 'gitea';
	const owner = url.searchParams.get('owner') || '';
	const repo = url.searchParams.get('repo') || '';

	if (!owner || !repo) return json({ issues: [] });

	if (provider === 'gitea') {
		return getGiteaIssues(owner, repo);
	} else if (provider === 'github') {
		return getGitHubIssues(owner, repo);
	}

	return json({ issues: [] });
};

async function getGiteaIssues(owner: string, repo: string) {
	const giteaUrl =
		env.GITEA_API_URL || 'http://gitea-http.gitea.svc.cluster.local:3000';

	try {
		const res = await fetch(
			`${giteaUrl}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?limit=50&state=open&sort=updated&type=issues`
		);
		if (!res.ok) return json({ issues: [] });

		const data = await res.json();
		return json({
			issues: (data || []).map((i: Record<string, unknown>) => ({
				number: i.number as number,
				title: i.title as string,
				body: (i.body as string) || '',
				state: i.state as string,
				user: (i.user as Record<string, unknown>)?.login as string || '',
				createdAt: i.created_at as string,
				url: i.html_url as string
			}))
		});
	} catch {
		return json({ issues: [] });
	}
}

async function getGitHubIssues(owner: string, repo: string) {
	const token = env.GITHUB_TOKEN;
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28'
	};
	if (token) headers['Authorization'] = `Bearer ${token}`;

	try {
		const res = await fetch(
			`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?per_page=50&state=open&sort=updated`,
			{ headers }
		);
		if (!res.ok) return json({ issues: [] });

		const data = await res.json();
		return json({
			issues: data
				.filter((i: Record<string, unknown>) => !i.pull_request) // Exclude PRs
				.map((i: Record<string, unknown>) => ({
					number: i.number as number,
					title: i.title as string,
					body: (i.body as string) || '',
					state: i.state as string,
					user: (i.user as Record<string, unknown>)?.login as string || '',
					createdAt: i.created_at as string,
					url: i.html_url as string
				}))
		});
	} catch {
		return json({ issues: [] });
	}
}
