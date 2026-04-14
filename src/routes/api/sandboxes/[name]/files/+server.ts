import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';

function shellQuote(value: unknown): string {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * File operations on a sandbox.
 * Proxies to agent-runtime's /api/v1/sandboxes/{name}/files endpoint,
 * which uses OpenShell exec() for file operations.
 *
 * POST body:
 *   { action: 'list' | 'read' | 'write', scope?: 'workspace' | 'container', path?: string, content?: string }
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const body = await request.json();
	const sandboxName = params.name;
	const scope = String(body.scope ?? 'workspace');

	const res = await openshellRuntimeFetch(
		`/api/v1/sandboxes/${encodeURIComponent(sandboxName)}/files`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}
	);

	if (!res.ok) {
		if (scope !== 'workspace') {
			return json(await res.json().catch(() => ({ ok: false, error: 'File operation failed' })), {
				status: res.status
			});
		}

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
						command: `find ${shellQuote(path)} -maxdepth ${Number(maxDepth) || 3} -not -path '*/node_modules/*' -not -path '*/.git/*' -printf '%y\\t%s\\t%m\\t%p\\n' | head -500`,
						timeout: 10
					})
				}
			);
			if (!execRes.ok) return error(502, 'Failed to list files');
			const data = await execRes.json();
			const entries = (data.stdout ?? '')
				.split('\n')
				.filter((l: string) => l.trim() && l.trim() !== path)
				.map((line: string) => {
					const [type, size, mode, fullPathRaw] = line.trim().split('\t');
					const fullPath = fullPathRaw ?? line.trim();
					return {
						path: fullPath,
						name: fullPath.split('/').pop() ?? fullPath,
						isDirectory: type === 'd',
						type: type === 'd' ? 'directory' : 'file',
						size: Number.isFinite(Number(size)) ? Number(size) : null,
						mode: mode || null,
						scope: 'workspace'
					};
				});
			return json({ ok: true, entries });
		}

		if (action === 'read') {
			if (!body.path) return error(400, 'Missing path');
			const execRes = await openshellRuntimeFetch(
				`/api/v1/sandboxes/${encodeURIComponent(sandboxName)}/exec`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ command: `cat ${shellQuote(body.path)} 2>/dev/null | head -1000`, timeout: 10 })
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
