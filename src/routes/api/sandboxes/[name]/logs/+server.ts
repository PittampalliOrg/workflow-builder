import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listSandboxAgentEvents } from '$lib/server/execution-read-model';

export const GET: RequestHandler = async ({ params, url }) => {
	const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100);
	const events = await listSandboxAgentEvents(params.name, 0, limit);

	return json(
		events.map((e) => ({
			type: e.type,
			message:
				e.type === 'tool_call_start'
					? `Tool: ${(e.data?.toolName as string) ?? 'unknown'}`
					: e.type === 'run_complete'
						? 'Run completed'
						: e.type === 'run_error'
							? `Error: ${(e.data?.error as string) ?? 'unknown'}`
							: e.type,
			timestamp: e.timestamp
		}))
	);
};
