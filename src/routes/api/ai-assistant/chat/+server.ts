import { type RequestHandler } from '@sveltejs/kit';
import { getApplicationAdapters } from '$lib/server/application';
import { buildSystemPrompt } from '$lib/server/ai-assistant/system-prompt';
import { createWorkflowTools } from '$lib/server/ai-assistant/tools';
import {
	applyWorkflowSpecOperations,
	parseWorkflowSpecOperationPlan,
	type WorkflowSpecOperationPlan,
	type WorkflowSpecOperationResult,
} from '$lib/server/ai-assistant/spec-operations';

const MAX_PLAN_ATTEMPTS = 3;

function parseJsonPlanText(text: string): unknown {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) return JSON.parse(fenced[1].trim());

	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf('{');
		const end = trimmed.lastIndexOf('}');
		if (start >= 0 && end > start) {
			return JSON.parse(trimmed.slice(start, end + 1));
		}
		throw new Error('Assistant response did not include a JSON operation plan.');
	}
}

function assistantNoopResponse(message: string, errors: string[] = [], toolCalls: string[] = []) {
	return Response.json({
		message,
		operations: [],
		proposedSpec: null,
		validation: { valid: errors.length === 0, errors },
		changedTaskNames: [],
		autoApply: false,
		needsClarification: false,
		toolCalls,
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function specTaskNames(spec: Record<string, unknown> | null | undefined): string[] {
	const doArray = spec?.do;
	if (!Array.isArray(doArray)) return [];
	return doArray
		.map((entry) => entry && typeof entry === 'object' ? Object.keys(entry as Record<string, unknown>)[0] : '')
		.filter(Boolean);
}

type ToolTraceResult = {
	text: string;
	steps: ReadonlyArray<{
		toolResults: ReadonlyArray<{ toolName: string; output: unknown }>;
		toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>;
	}>;
};

async function validateCanvasRenderable(spec: Record<string, unknown> | null): Promise<string[]> {
	if (!spec) return ['No proposed spec was generated.'];
	const taskNames = specTaskNames(spec);
	if (taskNames.length === 0) return ['The proposed spec has no root do tasks to render on the canvas.'];

	try {
		const { specToGraph } = await import('$lib/utils/spec-graph-adapter');
		const graph = specToGraph(spec, {});
		const nodeCount = graph?.nodes.length ?? 0;
		const renderedTaskCount = graph?.nodes.filter((node) => node.type !== 'start' && node.type !== 'end').length ?? 0;
		if (!graph || nodeCount === 0) {
			return [`The proposed spec could not be rendered on the canvas. Task names: ${taskNames.join(', ')}.`];
		}
		if (renderedTaskCount === 0) {
			return [`The proposed spec rendered no task nodes on the canvas. Task names: ${taskNames.join(', ')}.`];
		}
		return [];
	} catch (error) {
		return [`Canvas render preflight failed: ${errorMessage(error)}`];
	}
}

export const POST: RequestHandler = async ({ request, locals, fetch: skFetch }) => {
	const body = await request.json();

	const messages = body.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
	const workflowContext = body.workflowContext as {
		workflowId: string | null;
		workflowName: string;
		spec: Record<string, unknown> | null;
		selectedNodeId?: string | null;
		selectedTaskName?: string | null;
		selectedNodeLabel?: string | null;
		selectedNodeType?: string | null;
		selectedTask?: Record<string, unknown> | null;
	} | undefined;

	if (!messages || !Array.isArray(messages)) {
		return new Response('Missing messages', { status: 400 });
	}

	const application = getApplicationAdapters();
	const kimiAvailable = application.modelCompletion.isAvailable();

	if (!kimiAvailable) {
		return new Response('KIMI_API_KEY is not configured', { status: 503 });
	}

	const userId = locals.session?.userId;

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
			selectedNodeId: workflowContext.selectedNodeId,
			selectedTaskName: workflowContext.selectedTaskName,
			selectedNodeLabel: workflowContext.selectedNodeLabel,
			selectedNodeType: workflowContext.selectedNodeType,
			selectedTask: workflowContext.selectedTask,
		} : null,
		null,
	) + (executionContext ? '\n\n' + executionContext : '');

	const modelMessages = messages.map((m) => {
		const content = typeof m.content === 'string'
			? m.content
			: m.content?.filter((p) => p.type === 'text' && p.text?.trim()).map((p) => p.text).join('') || '';
		return {
			role: m.role as 'user' | 'assistant',
			content,
		};
	}).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0);

	if (modelMessages.length === 0) {
		return assistantNoopResponse('Tell me what workflow change you want to make.', ['No non-empty messages were provided.']);
	}

	const latestUserMessage = [...modelMessages].reverse().find((m) => m.role === 'user')?.content ?? '';
	const toolCalls: string[] = [];

	async function generatePlan(attempt: number, feedback?: {
		previousPlan?: WorkflowSpecOperationPlan | null;
		errors: string[];
	}): Promise<WorkflowSpecOperationPlan> {
		const attemptSystem = feedback
			? `${systemPrompt}

You are in a ReAct correction loop. The previous operation plan failed validation or canvas render preflight.
Reason about the failure by using the available tools again if needed, then return exactly one corrected JSON operation plan.
Do not include Markdown fences, comments, ellipses, YAML, or explanatory prose.`
			: systemPrompt;
		const attemptMessages = feedback
			? [{
					role: 'user' as const,
					content: `Original user request:
${latestUserMessage}

Previous operation plan:
${JSON.stringify(feedback.previousPlan ?? null, null, 2)}

Errors to correct:
${feedback.errors.map((error) => `- ${error}`).join('\n')}

Return the corrected JSON operation plan now.`,
				}]
			: modelMessages;

		const tools = createWorkflowTools(userId ?? null, skFetch);
		const maxSteps = feedback ? 6 : 8;
		const maxOutputTokens = feedback ? 4096 : 8192;
		const result = (await application.modelCompletion.generate({
			system: attemptSystem,
			messages: attemptMessages,
			tools,
			maxSteps,
			maxOutputTokens,
			abortSignal: request.signal,
		})) as ToolTraceResult;
		toolCalls.push(...result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)));
		if (attempt > 0) toolCalls.push(`repairOperationPlan:${attempt}`);

		try {
			return parseWorkflowSpecOperationPlan(parseJsonPlanText(result.text));
		} catch (error) {
			const message = errorMessage(error);
			console.error('[ai-assistant/chat] operation plan parse failed:', {
				error,
				text: result.text.slice(0, 2000),
			});
			if (attempt >= MAX_PLAN_ATTEMPTS - 1) throw new Error(`${message}; invalid output: ${result.text.slice(0, 500)}`);
			return generatePlan(attempt + 1, {
				previousPlan: null,
				errors: [
					`Parser error: ${message}`,
					`Invalid output: ${result.text.slice(0, 1000)}`,
				],
			});
		}
	}

	let plan: WorkflowSpecOperationPlan;
	let operationResult: WorkflowSpecOperationResult;
	let renderErrors: string[] = [];
	try {
		plan = await generatePlan(0);
		operationResult = applyWorkflowSpecOperations({
			workflowName: workflowContext?.workflowName ?? 'Untitled Workflow',
			spec: workflowContext?.spec ?? null,
			operations: plan.operations,
		});
		renderErrors = operationResult.applied
			? await validateCanvasRenderable(operationResult.proposedSpec)
			: [];

		for (let attempt = 1; attempt < MAX_PLAN_ATTEMPTS && !operationResult.needsClarification && (!operationResult.applied || renderErrors.length > 0); attempt++) {
			const errors = [
				...operationResult.validation.errors,
				...renderErrors,
			].filter(Boolean);
			plan = await generatePlan(attempt, {
				previousPlan: plan,
				errors,
			});
			operationResult = applyWorkflowSpecOperations({
				workflowName: workflowContext?.workflowName ?? 'Untitled Workflow',
				spec: workflowContext?.spec ?? null,
				operations: plan.operations,
			});
			renderErrors = operationResult.applied
				? await validateCanvasRenderable(operationResult.proposedSpec)
				: [];
		}
	} catch (error) {
		const message = errorMessage(error);
		console.error('[ai-assistant/chat] generation failed:', error);
		return assistantNoopResponse(
			`I could not update the workflow because the AI request failed: ${message}`,
			[message],
			toolCalls,
		);
	}

	if (operationResult.applied && renderErrors.length > 0) {
		return Response.json({
			message: renderErrors.join('\n'),
			operations: operationResult.operations,
			proposedSpec: operationResult.proposedSpec,
			validation: { valid: false, errors: renderErrors },
			changedTaskNames: operationResult.changedTaskNames,
			autoApply: false,
			needsClarification: false,
			toolCalls,
		});
	}

	const message = operationResult.needsClarification
		? operationResult.message
		: operationResult.applied
			? plan.message
			: operationResult.validation.errors.join('\n') || plan.message;

	return Response.json({
		message,
		operations: operationResult.operations,
		proposedSpec: operationResult.proposedSpec,
		validation: operationResult.validation,
		changedTaskNames: operationResult.changedTaskNames,
		autoApply: operationResult.applied,
		needsClarification: operationResult.needsClarification,
		toolCalls,
	});
};
