import yaml from 'js-yaml';

export interface UIMessage {
	id: string;
	role: 'user' | 'assistant';
	parts: Array<{ type: 'text'; text: string }>;
	operationResult?: AiAssistantOperationResult;
	status?: 'thinking' | 'complete';
}

export interface WorkflowContext {
	workflowId: string | null;
	workflowName: string;
	spec: Record<string, unknown> | null;
	selectedNodeId?: string | null;
	selectedTaskName?: string | null;
	selectedNodeLabel?: string | null;
	selectedNodeType?: string | null;
	selectedTask?: Record<string, unknown> | null;
}

export interface AiAssistantOperationResult {
	operations: Array<Record<string, unknown>>;
	proposedSpec: Record<string, unknown> | null;
	validation: { valid: boolean; errors: string[] };
	changedTaskNames: string[];
	autoApply: boolean;
	needsClarification: boolean;
	toolCalls?: string[];
	canvasApplyStatus?: 'pending' | 'applied' | 'failed';
	canvasApplyErrors?: string[];
}

/**
 * Extract a SW 1.0 spec from ```yaml or ```json fenced blocks in text.
 */
export function extractSpec(text: string): Record<string, unknown> | null {
	// Try YAML first
	const yamlMatch = text.match(/```ya?ml\s*\n([\s\S]*?)```/);
	if (yamlMatch) {
		try {
			const parsed = yaml.load(yamlMatch[1]) as Record<string, unknown>;
			if (parsed && typeof parsed === 'object' && parsed.document) return parsed;
		} catch { /* fall through */ }
	}

	// Try JSON
	const jsonMatch = text.match(/```json\s*\n([\s\S]*?)```/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[1]) as Record<string, unknown>;
			if (parsed && typeof parsed === 'object' && parsed.document) return parsed;
		} catch { /* fall through */ }
	}

	return null;
}

/**
 * Strip spec blocks from text for display.
 */
export function stripSpecBlocks(text: string): string {
	return text.replace(/```ya?ml\s*\n[\s\S]*?```/g, '').replace(/```json\s*\n[\s\S]*?```/g, '').trim();
}

/**
 * Get text content from a UIMessage.
 */
export function getMessageText(message: UIMessage): string {
	return message.parts
		.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
		.map((p) => p.text)
		.join('');
}

export function createAiAssistantStore() {
	let messages = $state<UIMessage[]>([]);
	let isStreaming = $state(false);
	let error = $state<string | null>(null);
	let pendingSpec = $state<Record<string, unknown> | null>(null);
	let workflowContext = $state<WorkflowContext | null>(null);
	let appliedMessageIds = $state<Set<string>>(new Set());
	let abortController: AbortController | null = null;

	async function sendMessage(content: string) {
		if (!content.trim() || isStreaming) return;
		error = null;

		const existingMessages = messages;
		const userMsg: UIMessage = {
			id: crypto.randomUUID(),
			role: 'user',
			parts: [{ type: 'text', text: content }],
		};
		const requestMessages = [...existingMessages, userMsg]
			.filter((m) => !(
				m.role === 'assistant' &&
				m.operationResult?.validation.valid === false &&
				m.operationResult.operations.length === 0
			))
			.map((m) => ({
				role: m.role,
				content: getMessageText(m),
			}))
			.filter((m) => m.content.trim().length > 0);

		messages = [...existingMessages, userMsg];
		isStreaming = true;

		abortController = new AbortController();
		const assistantId = crypto.randomUUID();
		messages = [...messages, {
			id: assistantId,
			role: 'assistant' as const,
			parts: [{ type: 'text' as const, text: '' }],
			status: 'thinking',
		}];

		try {
			const body: Record<string, unknown> = {
				messages: requestMessages,
			};
			if (workflowContext) {
				body.workflowContext = {
					workflowId: workflowContext.workflowId,
					workflowName: workflowContext.workflowName,
					spec: workflowContext.spec,
					selectedNodeId: workflowContext.selectedNodeId,
					selectedTaskName: workflowContext.selectedTaskName,
					selectedNodeLabel: workflowContext.selectedNodeLabel,
					selectedNodeType: workflowContext.selectedNodeType,
					selectedTask: workflowContext.selectedTask,
				};
			}

			const response = await fetch('/api/ai-assistant/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: abortController.signal,
			});

			if (!response.ok) {
				throw new Error(await response.text() || `Chat failed (${response.status})`);
			}

			const result = await response.json() as {
				message?: string;
				operations?: Array<Record<string, unknown>>;
				proposedSpec?: Record<string, unknown> | null;
				validation?: { valid: boolean; errors: string[] };
				changedTaskNames?: string[];
				autoApply?: boolean;
				needsClarification?: boolean;
				toolCalls?: string[];
			};
			const operationResult: AiAssistantOperationResult = {
				operations: result.operations ?? [],
				proposedSpec: result.proposedSpec ?? null,
				validation: result.validation ?? { valid: false, errors: [] },
				changedTaskNames: result.changedTaskNames ?? [],
				autoApply: Boolean(result.autoApply),
				needsClarification: Boolean(result.needsClarification),
				toolCalls: result.toolCalls ?? [],
				canvasApplyStatus: result.autoApply ? 'pending' : undefined,
			};
			const shouldShowOperationResult =
				operationResult.operations.length > 0 ||
				operationResult.needsClarification ||
				operationResult.validation.errors.length > 0;

			messages = messages.map((message) => message.id === assistantId
				? {
						...message,
						parts: [{ type: 'text' as const, text: result.message || 'Done.' }],
						status: 'complete' as const,
						...(shouldShowOperationResult ? { operationResult } : {}),
					}
				: message);

			if (operationResult.autoApply && operationResult.proposedSpec) {
				window.dispatchEvent(
					new CustomEvent('ai-assistant:apply-spec', {
						detail: {
							spec: operationResult.proposedSpec,
							messageId: assistantId,
							changedTaskNames: operationResult.changedTaskNames,
						},
					}),
				);
			}
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') {
				// User cancelled
			} else {
				const msg = err instanceof Error ? err.message : 'Chat failed';
				error = msg;
				messages = messages.map((message) => message.id === assistantId
					? {
							...message,
							parts: [{ type: 'text' as const, text: msg }],
							status: 'complete' as const,
							operationResult: {
								operations: [],
								proposedSpec: null,
								validation: { valid: false, errors: [msg] },
								changedTaskNames: [],
								autoApply: false,
								needsClarification: false,
								toolCalls: [],
							},
						}
					: message);
			}
		} finally {
			isStreaming = false;
			abortController = null;
		}
	}

	function stop() {
		abortController?.abort();
	}

	function markApplied(messageId: string) {
		appliedMessageIds = new Set([...appliedMessageIds, messageId]);
		messages = messages.map((message) => message.id === messageId && message.operationResult
			? {
					...message,
					operationResult: {
						...message.operationResult,
						canvasApplyStatus: 'applied',
						canvasApplyErrors: [],
					},
				}
			: message);
	}

	function markApplyFailed(messageId: string, errors: string[]) {
		messages = messages.map((message) => message.id === messageId && message.operationResult
			? {
					...message,
					operationResult: {
						...message.operationResult,
						autoApply: false,
						canvasApplyStatus: 'failed',
						canvasApplyErrors: errors,
					},
				}
			: message);
	}

	function isApplied(messageId: string): boolean {
		return appliedMessageIds.has(messageId);
	}

	function dismissSpec() {
		pendingSpec = null;
	}

	function setWorkflowContext(ctx: WorkflowContext) {
		workflowContext = ctx;
	}

	function clearWorkflowContext() {
		workflowContext = null;
	}

	async function loadHistory(_workflowId: string) {
		// Placeholder for DB history loading
	}

	function clearHistory() {
		messages = [];
		pendingSpec = null;
		appliedMessageIds = new Set();
	}

	return {
		get messages() { return messages; },
		get isStreaming() { return isStreaming; },
		get error() { return error; },
		get pendingSpec() { return pendingSpec; },
		set pendingSpec(v) { pendingSpec = v; },
		get workflowContext() { return workflowContext; },

		getMessageText,
		extractSpec,
		stripSpecBlocks,
		isApplied,

		sendMessage,
		stop,
		markApplied,
		markApplyFailed,
		dismissSpec,
		setWorkflowContext,
		clearWorkflowContext,
		loadHistory,
		clearHistory,
	};
}
