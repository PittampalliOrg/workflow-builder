import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';

/**
 * File operations on a sandbox.
 * Proxies to agent-runtime's /api/v1/sandboxes/{name}/files endpoint,
 * which uses OpenShell exec() for file operations.
 *
 * POST body: { action: 'list' | 'read' | 'write', path?: string, content?: string }
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const body = await request.json();
	const sandboxName = params.name;

	const res = await openshellRuntimeFetch(
		`/api/v1/sandboxes/${encodeURIComponent(sandboxName)}/files`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}
	);

	if (!res.ok) {
		// Fallback: try exec endpoint directly for backward compatibility
		const action = body.action;
		if (action === 'list') {
			const path = body.path ?? '/sandbox';
			const maxDepth = body.maxDepth ?? 3;
			const execRes = await openshellRuntimeFetch(
				`/api/v1/sandboxes/${encodeURIComponent(sandboxName)}/exec`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						command: `find ${path} -maxdepth ${maxDepth} -not -path '*/node_modules/*' -not -path '*/.git/*' | head -500`,
						timeout: 10
					})
				}
			);
			if (!execRes.ok) return error(502, 'Failed to list files');
			const data = await execRes.json();
			const entries = (data.stdout ?? '')
				.split('\n')
				.filter((l: string) => l.trim() && l.trim() !== path)
				.map((fullPath: string) => ({
					path: fullPath.trim(),
					name: fullPath.trim().split('/').pop() ?? fullPath.trim()
				}));
			return json({ ok: true, entries });
		}

		if (action === 'read') {
			if (!body.path) return error(400, 'Missing path');
			const execRes = await openshellRuntimeFetch(
				`/api/v1/sandboxes/${encodeURIComponent(sandboxName)}/exec`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ command: `cat "${body.path}" 2>/dev/null | head -1000`, timeout: 10 })
				}
			);
			if (!execRes.ok) return error(502, 'Failed to read file');
			const data = await execRes.json();
			return json({ ok: true, content: data.stdout ?? '', exitCode: data.exitCode ?? 0 });
		}

		return error(502, 'File operation failed');
	}

	return json(await res.json());
};
