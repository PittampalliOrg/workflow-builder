import { type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { streamText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { buildSystemPrompt } from '$lib/server/ai-assistant/system-prompt';
import { loadActionCatalogSnapshot } from '$lib/server/action-catalog';

export const POST: RequestHandler = async ({ request, locals, fetch: skFetch }) => {
	const body = await request.json();

	const messages = body.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
	const workflowContext = body.workflowContext as {
		workflowId: string | null;
		workflowName: string;
		spec: Record<string, unknown> | null;
	} | undefined;

	if (!messages || !Array.isArray(messages)) {
		return new Response('Missing messages', { status: 400 });
	}

	const anthropicKey = env.ANTHROPIC_API_KEY;
	const openaiKey = env.OPENAI_API_KEY;

	if (!anthropicKey && !openaiKey) {
		return new Response('No AI API key configured', { status: 503 });
	}

	const userId = locals.session?.userId;

	// Load action catalog + connections for rich context
	let catalogContext = '';
	try {
		const [catalogSnapshot, connectionsRes] = await Promise.all([
			loadActionCatalogSnapshot(userId).catch(() => ({ items: [], services: [] })),
			skFetch('/api/app-connections').then(r => r.json()).catch(() => []),
		]);

		const connections = (Array.isArray(connectionsRes) ? connectionsRes : connectionsRes.connections || [])
			.filter((c: Record<string, unknown>) => c.status === 'ACTIVE')
			.map((c: Record<string, unknown>) => ({
				pieceName: ((c.pieceName as string) || '').replace('@activepieces/piece-', ''),
				externalId: c.externalId as string,
				displayName: (c.displayName || c.pieceName) as string,
			}));

		const connectedPieces = new Set(connections.map((c: { pieceName: string }) => c.pieceName));
		const items = (catalogSnapshot.items || []).filter((i: Record<string, unknown>) => i.insertable);

		// Build rich context: connected actions with schemas
		const lines: string[] = [];
		if (connections.length > 0) {
			lines.push('## Available Connections');
			for (const c of connections) {
				lines.push(`- **${c.pieceName}**: \`${c.externalId}\``);
			}
			lines.push('');
		}

		// Show connected actions with full schemas
		const connected = items.filter((i: Record<string, unknown>) => connectedPieces.has(i.pieceName as string));
		if (connected.length > 0) {
			lines.push('## Connected Actions (ready to use)');
			for (const item of connected) {
				const piece = item.pieceName as string;
				const actionName = (item.actionName as string || '').replace(new RegExp(`^${piece}-`), '');
				const callValue = `${piece}/${actionName}`;
				lines.push(`### ${item.displayName} — \`${callValue}\``);
				if (item.description) lines.push(`  ${(item.description as string).slice(0, 150)}`);

				const schema = item.inputSchema as Record<string, unknown> | null;
				if (schema) {
					const props = (schema.properties || {}) as Record<string, Record<string, unknown>>;
					const required = (schema.required || []) as string[];
					for (const [name, def] of Object.entries(props)) {
						const req = required.includes(name) ? ' **(required)**' : '';
						lines.push(`  - \`${name}\`: ${def.type || 'string'}${req} — ${def.title || def.description || name}`);
					}
				}
				lines.push('');
			}
		}

		catalogContext = lines.join('\n');
	} catch {
		// Continue without catalog
	}

	// Progressive disclosure: compact execution summary (last 3 runs)
	let executionContext = '';
	if (workflowContext?.workflowId) {
		try {
			const execRes = await skFetch(`/api/workflows/${workflowContext.workflowId}/executions`);
			if (execRes.ok) {
				const executions = (await execRes.json()) as Array<Record<string, unknown>>;
				const recent = executions.slice(0, 3);
				if (recent.length > 0) {
					const execLines: string[] = ['## Recent Executions (last 3)'];
					for (const exec of recent) {
						const status = exec.status as string;
						const icon = status === 'success' ? '✅' : status === 'error' ? '❌' : '⏳';
						const duration = exec.duration ? `${exec.duration}ms` : '';
						execLines.push(`${icon} **${status}** ${duration}`);

						// For failed runs: fetch step-level detail (progressive: only for errors)
						if (status === 'error') {
							try {
								const logsRes = await skFetch(`/api/workflows/executions/${exec.id}/logs`);
								if (logsRes.ok) {
									const logsData = await logsRes.json();
									const steps = (logsData.logs || []) as Array<Record<string, unknown>>;
									for (const step of steps) {
										const stepIcon = step.status === 'success' ? '  ✓' : '  ✗';
										const stepName = step.stepName || step.label || '?';
										execLines.push(`${stepIcon} ${stepName}: ${step.status}`);
										if (step.error) {
											// Truncate error to 200 chars for context efficiency
											execLines.push(`    Error: ${(step.error as string).slice(0, 200)}`);
										}
									}
								}
							} catch { /* skip logs */ }
						}
					}
					execLines.push('');
					execLines.push('_If a run failed, fix the spec to address the error. If runs succeed, the workflow is working._');
					executionContext = execLines.join('\n');
				}
			}
		} catch { /* skip executions */ }
	}

	const systemPrompt = buildSystemPrompt(
		workflowContext ? {
			workflowId: workflowContext.workflowId,
			workflowName: workflowContext.workflowName,
			spec: workflowContext.spec,
		} : null,
		null,
	) + (catalogContext ? '\n\n' + catalogContext : '') + (executionContext ? '\n\n' + executionContext : '');

	const model = anthropicKey
		? anthropic(env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514')
		: openai(env.OPENAI_MODEL || 'gpt-4o');

	const modelMessages = messages.map((m) => {
		const content = typeof m.content === 'string'
			? m.content
			: m.content?.filter((p) => p.type === 'text').map((p) => p.text).join('') || '';
		return {
			role: m.role as 'user' | 'assistant',
			content,
		};
	});

	const result = streamText({
		model,
		system: systemPrompt,
		messages: modelMessages,
		maxOutputTokens: 8192,
		abortSignal: request.signal,
	});

	return result.toTextStreamResponse();
};
