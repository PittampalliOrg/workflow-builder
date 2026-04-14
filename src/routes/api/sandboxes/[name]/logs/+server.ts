import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listSandboxAgentEvents } from '$lib/server/execution-read-model';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';

export const GET: RequestHandler = async ({ params, url }) => {
	const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100);
	const includeOpenShell = url.searchParams.get('openshell') !== 'false';
	const events = await listSandboxAgentEvents(params.name, 0, limit);

	const agentLogs = events.map((e) => ({
			type: e.type,
			source: (e.data?.toolName as string) ?? e.type,
			message:
				e.type === 'tool_call_start'
					? `Tool: ${(e.data?.toolName as string) ?? 'unknown'}`
					: e.type === 'run_complete'
						? 'Run completed'
						: e.type === 'run_error'
							? `Error: ${(e.data?.error as string) ?? 'unknown'}`
							: e.type,
			timestamp: e.timestamp,
			level: e.type.includes('error') ? 'ERROR' : 'INFO'
		}));

	if (!includeOpenShell) return json(agentLogs);

	try {
		const runtimeRes = await openshellRuntimeFetch(
			`/api/v1/sandboxes/${encodeURIComponent(params.name)}/logs?limit=${limit}&source=all&level=info`
		);
		if (!runtimeRes.ok) return json(agentLogs);
		const runtime = await runtimeRes.json();
		return json([...agentLogs, ...((runtime.logs ?? []) as unknown[])]);
	} catch {
		return json(agentLogs);
	}
};
