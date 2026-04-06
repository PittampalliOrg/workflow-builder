import yaml from 'js-yaml';

export interface UIMessage {
	id: string;
	role: 'user' | 'assistant';
	parts: Array<{ type: 'text'; text: string }>;
}

export interface WorkflowContext {
	workflowId: string | null;
	workflowName: string;
	spec: Record<string, unknown> | null;
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

		const userMsg: UIMessage = {
			id: crypto.randomUUID(),
			role: 'user',
			parts: [{ type: 'text', text: content }],
		};
		messages = [...messages, userMsg];
		isStreaming = true;

		abortController = new AbortController();

		try {
			const body: Record<string, unknown> = {
				messages: messages.map((m) => ({
					role: m.role,
					content: getMessageText(m),
				})),
			};
			if (workflowContext) {
				body.workflowContext = {
					workflowId: workflowContext.workflowId,
					workflowName: workflowContext.workflowName,
					spec: workflowContext.spec,
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

			const reader = response.body!.getReader();
			const decoder = new TextDecoder();
			const assistantId = crypto.randomUUID();
			let fullText = '';

			messages = [...messages, {
				id: assistantId,
				role: 'assistant' as const,
				parts: [{ type: 'text' as const, text: '' }],
			}];

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				fullText += decoder.decode(value, { stream: true });
				messages = messages.map((m) =>
					m.id === assistantId
						? { ...m, parts: [{ type: 'text' as const, text: fullText }] }
						: m,
				);
			}

			// Extract spec from the response
			const spec = extractSpec(fullText);
			if (spec) {
				pendingSpec = spec;
			}
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') {
				// User cancelled
			} else {
				const msg = err instanceof Error ? err.message : 'Chat failed';
				error = msg;
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
		dismissSpec,
		setWorkflowContext,
		clearWorkflowContext,
		loadHistory,
		clearHistory,
	};
}
