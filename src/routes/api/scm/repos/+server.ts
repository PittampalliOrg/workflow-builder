import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';

/**
 * GET /api/scm/repos?provider=github|gitea&owner=...
 *
 * Lists repositories from GitHub or Gitea.
 * GitHub: uses GITHUB_TOKEN env or falls back to public API
 * Gitea: uses internal cluster service (no auth needed for local)
 */
export const GET: RequestHandler = async ({ url }) => {
	const provider = url.searchParams.get('provider') || 'gitea';
	const owner = url.searchParams.get('owner') || '';

	if (provider === 'gitea') {
		return getGiteaRepos(owner);
	} else if (provider === 'github') {
		return getGitHubRepos(owner);
	}

	return json({ repos: [] });
};

async function getGiteaRepos(owner: string) {
	const giteaUrl =
		env.GITEA_API_URL || 'http://gitea-http.gitea.svc.cluster.local:3000';

	try {
		const endpoint = owner
			? `${giteaUrl}/api/v1/repos/search?q=&owner=${encodeURIComponent(owner)}&limit=50`
			: `${giteaUrl}/api/v1/repos/search?limit=50&sort=updated`;

		const res = await fetch(endpoint);
		if (!res.ok) return json({ repos: [] });

		const data = await res.json();
		const repos = (data.data || []).map((r: Record<string, unknown>) => ({
			name: r.name as string,
			fullName: r.full_name as string,
			owner: (r.owner as Record<string, unknown>)?.login as string,
			description: r.description as string || '',
			provider: 'gitea',
			url: r.html_url as string
		}));

		return json({ repos });
	} catch {
		return json({ repos: [] });
	}
}

async function getGitHubRepos(owner: string) {
	const token = env.GITHUB_TOKEN;
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28'
	};
	if (token) headers['Authorization'] = `Bearer ${token}`;

	try {
		let endpoint: string;
		if (owner) {
			endpoint = `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos?per_page=50&sort=updated`;
		} else if (token) {
			endpoint = 'https://api.github.com/user/repos?per_page=50&sort=updated&type=all';
		} else {
			return json({ repos: [], error: 'No GitHub token configured' });
		}

		const res = await fetch(endpoint, { headers });
		if (!res.ok) {
			// Try as user repos if org endpoint fails
			if (owner) {
				const fallback = await fetch(
					`https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=50&sort=updated`,
					{ headers }
				);
				if (fallback.ok) {
					const data = await fallback.json();
					return json({
						repos: data.map((r: Record<string, unknown>) => ({
							name: r.name as string,
							fullName: r.full_name as string,
							owner: (r.owner as Record<string, unknown>)?.login as string,
							description: r.description as string || '',
							provider: 'github',
							url: r.html_url as string
						}))
					});
				}
			}
			return json({ repos: [] });
		}

		const data = await res.json();
		return json({
			repos: data.map((r: Record<string, unknown>) => ({
				name: r.name as string,
				fullName: r.full_name as string,
				owner: (r.owner as Record<string, unknown>)?.login as string,
				description: r.description as string || '',
				provider: 'github',
				url: r.html_url as string
			}))
		});
	} catch {
		return json({ repos: [] });
	}
}
