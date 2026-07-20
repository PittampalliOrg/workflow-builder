/**
 * POST /api/ai-assistant/build-workflow
 *
 * Autonomous workflow builder with execution feedback loop.
 * Streams SSE events as it generates, validates, executes, and iterates.
 */

import { type RequestHandler } from '@sveltejs/kit';
import yaml from 'js-yaml';
import { getApplicationAdapters } from '$lib/server/application';
import { buildBuildPrompt, buildFixPrompt } from '$lib/server/ai-assistant/build-prompt';
import { getMissingRequiredTriggerFields } from '$lib/server/workflows/trigger-validation';
import { applyWorkflowInputDefaults } from '$lib/utils/workflow-input-config';
// Tools available for future ReAct-style planning (not yet wired to generateText)
// import { createWorkflowTools } from '$lib/server/ai-assistant/tools';

const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120000;

type ActionCatalogSnapshotLike = {
	items?: Array<Record<string, unknown>>;
	services?: unknown[];
};

type AssistantActionContext = {
	name: string;
	displayName: string;
	description: string;
	providerId: string | null;
	providerLabel: string | null;
	pieceName: string;
	actionName: string;
	inputSchema: Record<string, unknown> | null;
	auth: { required: boolean; authType?: string } | null;
};

function sseEvent(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function extractYamlSpec(text: string): Record<string, unknown> | null {
	const match = text.match(/```ya?ml\s*\n([\s\S]*?)```/);
	if (!match) return null;
	try {
		const parsed = yaml.load(match[1]) as Record<string, unknown>;
		if (parsed && typeof parsed === 'object' && parsed.document) return parsed;
	} catch { /* invalid yaml */ }
	return null;
}

export const POST: RequestHandler = async ({ request, locals, fetch: skFetch }) => {
	const body = await request.json();
	const { prompt, workflowId } = body as { prompt: string; workflowId: string };

	if (!prompt || !workflowId) {
		return new Response('Missing prompt or workflowId', { status: 400 });
	}

	const application = getApplicationAdapters();
	const kimiAvailable = application.modelCompletion.isAvailable();
	if (!kimiAvailable) {
		return new Response('KIMI_API_KEY is not configured', { status: 503 });
	}

	const userId = locals.session?.userId ?? null;
	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			const emit = (event: string, data: unknown) => {
				controller.enqueue(encoder.encode(sseEvent(event, data)));
			};

			try {
				const workflowData = application.workflowData;
				// Load context
				emit('status', { phase: 'loading', message: 'Loading action catalog and connections...' });

				const [catalogSnapshot, connectionsRes] = await Promise.all([
					application.actionCatalog
						.loadSnapshot({ userId })
						.then((snapshot) => snapshot as ActionCatalogSnapshotLike)
						.catch((): ActionCatalogSnapshotLike => ({ items: [], services: [] })),
					skFetch('/api/app-connections').then(r => r.json()).catch(() => []),
				]);

				const actions: AssistantActionContext[] = (catalogSnapshot.items || [])
					.filter((i: Record<string, unknown>) => i.insertable)
					.map((i: Record<string, unknown>) => ({
						name: i.name as string,
						displayName: i.displayName as string,
						description: (i.description || '') as string,
						providerId: i.providerId as string | null,
						providerLabel: i.providerLabel as string | null,
						pieceName: (i.pieceName || i.providerId || '') as string,
						actionName: (i.actionName || '') as string,
						inputSchema: i.inputSchema as Record<string, unknown> | null,
						auth: i.auth as { required: boolean; authType?: string } | null,
					}));

				const connections = (Array.isArray(connectionsRes) ? connectionsRes : connectionsRes.connections || [])
					.filter((c: Record<string, unknown>) => c.status === 'ACTIVE')
					.map((c: Record<string, unknown>) => ({
						pieceName: (c.pieceName || '') as string,
						externalId: (c.externalId || '') as string,
						status: (c.status || 'ACTIVE') as string,
					}));

				// Load current workflow spec
				const workflow = await workflowData.getWorkflowByRef({
					workflowId,
					lookup: 'id',
				});
				const currentSpec = (workflow?.spec as Record<string, unknown>) || null;

				// Build system prompt
				const systemPrompt = buildBuildPrompt(currentSpec, actions, connections);

				// Agent loop
				const conversationMessages: { role: 'user' | 'assistant'; content: string }[] = [
					{ role: 'user', content: prompt },
				];

				for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
					emit('iteration', { attempt, maxAttempts: MAX_ATTEMPTS });

					// Generate spec
					emit('status', { phase: 'generating', message: `Generating workflow spec (attempt ${attempt})...` });

					const result = await application.modelCompletion.generate({
						system: systemPrompt,
						messages: conversationMessages,
						maxOutputTokens: 8192,
					});

					const responseText = result.text;
					conversationMessages.push({ role: 'assistant', content: responseText });
					emit('status', { phase: 'parsing', message: 'Parsing generated spec...' });

					// Extract spec
					const spec = extractYamlSpec(responseText);
					if (!spec) {
						emit('status', { phase: 'error', message: 'LLM did not return a valid YAML spec block.' });
						conversationMessages.push({
							role: 'user',
							content: 'You did not return a valid YAML spec in a ```yaml block. Please try again with a complete SW 1.0 spec.',
						});
						continue;
					}

					// Auto-fix common spec issues
					fixupSpec(spec, connections);

					emit('spec', { yaml: yaml.dump(spec, { lineWidth: 120, noRefs: true }) });

					// Save spec to DB
					emit('status', { phase: 'saving', message: 'Saving workflow...' });
					await workflowData.updateWorkflowDefinition(workflowId, {
						spec,
						name: ((spec.document as Record<string, unknown>)?.title || workflow?.name || 'Untitled') as string,
					});

					const missingTriggerFields = getMissingRequiredTriggerFields(
						spec,
						applyWorkflowInputDefaults(spec, {})
					);
					if (missingTriggerFields.length > 0) {
						const message = `Generated workflow requires trigger inputs before execution: ${missingTriggerFields.join(', ')}`;
						emit('status', { phase: 'error', message });
						conversationMessages.push({
							role: 'user',
							content:
								`${message}. Either remove those trigger placeholders, provide defaults, ` +
								'or avoid generating a spec that cannot be executed without external input.'
						});
						continue;
					}

					// Execute
					emit('status', { phase: 'executing', message: 'Executing workflow...' });
					const execRes = await skFetch(`/api/workflows/${workflowId}/execute`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({}),
					});

					if (!execRes.ok) {
						const errText = await execRes.text();
						emit('status', { phase: 'error', message: `Execution failed to start: ${errText}` });
						conversationMessages.push({
							role: 'user',
							content: `Execution failed to start: ${errText}. Fix the spec and try again.`,
						});
						continue;
					}

					const execData = await execRes.json();
					const executionId = execData.executionId;
					emit('status', { phase: 'running', message: `Workflow running (${executionId})...` });

					// Poll for completion
					let execStatus: Record<string, unknown> | null = null;
					const startTime = Date.now();
					while (Date.now() - startTime < POLL_TIMEOUT_MS) {
						await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
						const statusRes = await skFetch(`/api/workflows/executions/${executionId}/status`);
						if (statusRes.ok) {
							execStatus = await statusRes.json();
							const status = execStatus?.status as string;
							if (status === 'success' || status === 'error' || status === 'cancelled') break;
							emit('status', { phase: 'running', message: `Still running... (${Math.round((Date.now() - startTime) / 1000)}s)` });
						}
					}

					if (!execStatus) {
						emit('status', { phase: 'error', message: 'Execution timed out.' });
						conversationMessages.push({ role: 'user', content: 'Execution timed out after 2 minutes.' });
						continue;
					}

					// Fetch logs
					let logs: Record<string, unknown> | null = null;
					try {
						const logsRes = await skFetch(`/api/workflows/executions/${executionId}/logs`);
						if (logsRes.ok) logs = await logsRes.json();
					} catch { /* no logs */ }

					const steps = ((logs as Record<string, unknown>)?.logs || []) as Array<Record<string, unknown>>;
					const execResult = {
						status: execStatus.status as string,
						steps: steps.map((s) => ({
							name: s.stepName || s.label || '?',
							status: s.status || 'unknown',
							error: s.error || null,
							input: s.input,
							output: s.output,
							durationMs: s.durationMs,
						})),
						error: (execStatus.output as Record<string, unknown>)?.error || null,
					};

					emit('result', execResult);

					// Check result
					if (execStatus.status === 'success') {
						emit('status', { phase: 'complete', message: 'Workflow executed successfully!' });
						emit('done', { success: true, executionId, spec });
						controller.close();
						return;
					}

					// Error — feed back to LLM
					emit('status', { phase: 'fixing', message: `Step failed — asking LLM to fix (attempt ${attempt}/${MAX_ATTEMPTS})...` });

					const failingStep = execResult.steps.find((s) => s.status === 'error');
					const failingAction = failingStep
						? actions.find((a) => a.name.includes(String(failingStep.name)) || String(failingStep.name).includes(a.pieceName))
						: undefined;

					const fixPrompt = buildFixPrompt(attempt, MAX_ATTEMPTS, execResult.steps as Parameters<typeof buildFixPrompt>[2], failingAction);
					conversationMessages.push({ role: 'user', content: fixPrompt });
				}

				// Max attempts reached
				emit('status', { phase: 'failed', message: `Failed after ${MAX_ATTEMPTS} attempts. Check logs for details.` });
				emit('done', { success: false });
			} catch (err) {
				emit('status', { phase: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
				emit('done', { success: false });
			} finally {
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
};

/**
 * Auto-fix common spec issues before execution.
 */
function fixupSpec(
	spec: Record<string, unknown>,
	connections: Array<{ pieceName: string; externalId: string; status: string }>,
): void {
	const doArray = (spec.do || []) as Array<Record<string, unknown>>;

	for (const entry of doArray) {
		const taskName = Object.keys(entry)[0];
		const taskDef = entry[taskName] as Record<string, unknown>;
		if (!taskDef || typeof taskDef !== 'object') continue;

		const callValue = taskDef.call as string | undefined;
		if (!callValue || callValue === 'http') continue;

		// Fix 1: Remove duplicated prefix in call value
		// "gmail/gmail-send_email" → "gmail/send_email"
		if (callValue.includes('/')) {
			const [piece, action] = callValue.split('/');
			if (action && action.startsWith(piece + '-')) {
				taskDef.call = `${piece}/${action.slice(piece.length + 1)}`;
			}
		}

		// Fix 2: Ensure metadata exists in with.body
		const withBlock = (taskDef.with || {}) as Record<string, unknown>;
		const body = (withBlock.body || {}) as Record<string, unknown>;
		if (!body.metadata && callValue.includes('/')) {
			const [piece, action] = (taskDef.call as string).split('/');
			body.metadata = { pieceName: piece, actionName: action };
			withBlock.body = body;
			taskDef.with = withBlock;
		}

		// Fix 3: Auto-attach connection if not present
		if (!withBlock.connectionExternalId && callValue.includes('/')) {
			const piece = (taskDef.call as string).split('/')[0];
			const conn = connections.find(c => {
				const shortName = c.pieceName.replace('@activepieces/piece-', '').replace(/^@.*\//, '');
				return shortName === piece;
			});
			if (conn) {
				withBlock.connectionExternalId = conn.externalId;
				taskDef.with = withBlock;
			}
		}

		// Fix 4: Flatten body.input to top-level input for the AP piece-runtime
		// The piece-runtime /execute expects: { step, input: {...}, metadata: {...} }
		// But the LLM nests it as: with.body.input and with.body.metadata
		// We need both input AND metadata at the top level of `with`
		const bodyInput = (body.input || {}) as Record<string, unknown>;
		const bodyMetadata = (body.metadata || {}) as Record<string, unknown>;
		if (Object.keys(bodyInput).length > 0) {
			withBlock.input = bodyInput;
		}
		if (Object.keys(bodyMetadata).length > 0) {
			withBlock.metadata = bodyMetadata;
		}
		taskDef.with = withBlock;
	}
}
