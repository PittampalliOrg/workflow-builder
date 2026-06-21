<script lang="ts" module>
	export type EventKind =
		| 'user'
		| 'agent'
		| 'thinking'
		| 'tool'
		| 'result'
		| 'model'
		| 'status'
		| 'span'
		| 'hook'
		| 'mcp'
		| 'adk'
		| 'alert'
		| 'provision'
		| 'other';

	/**
	 * Map the persisted `session_events.type` (e.g. `agent.message`,
	 * `agent.tool_use`, `span.model_request_start`) to a short event kind we
	 * colour-code in the UI. Matches CMA's left-panel pill taxonomy —
	 * distinct hues for User / Agent / Thinking / Tool / Result / Model.
	 */
	export function eventKindFor(type: string): EventKind {
		if (type === 'user.message' || type === 'user.interrupt') return 'user';
		if (type === 'agent.message') return 'agent';
		if (type === 'agent.thinking') return 'thinking';
		if (
			type === 'agent.tool_use' ||
			type === 'agent.mcp_tool_use' ||
			type === 'agent.custom_tool_use'
		)
			return 'tool';
		if (
			type === 'agent.tool_result' ||
			type === 'agent.mcp_tool_result' ||
			type === 'agent.custom_tool_result'
		)
			return 'result';
		if (
			type.startsWith('span.model_request') ||
			type === 'agent.llm_usage' ||
			type === 'agent.context_usage' ||
			type === 'llm_start'
		)
			return 'model';
		if (type === 'hook.decision') return 'hook';
		if (type === 'mcp.tool_call') return 'mcp';
		if (type.startsWith('adk.')) return 'adk';
		if (
			type === 'agent.circuit_breaker_tripped' ||
			type === 'session.turn_timeout' ||
			type === 'session.error' ||
			type === 'agent.thread_images_compacted' ||
			type === 'agent.thread_context_compacted'
		)
			return 'alert';
		if (type.startsWith('session.provisioning_')) return 'provision';
		if (type.startsWith('session.status_')) return 'status';
		if (type.startsWith('span.')) return 'span';
		return 'other';
	}
</script>

<script lang="ts">
	interface Props {
		kind: EventKind;
		label?: string;
		size?: 'sm' | 'xs';
	}

	const { kind, label, size = 'sm' }: Props = $props();

	// Colour palette mirrors CMA's pill hues. Each kind gets a slightly
	// translucent tinted bg + a bright foreground to pop against the dark
	// chrome. Keep the set short and distinct — if you add a new kind, pick
	// a hue that's visually distant from its neighbours in the timeline.
	const CLASSES: Record<EventKind, string> = {
		user: 'bg-rose-500/25 text-rose-200 border-rose-400/20',
		agent: 'bg-teal-500/25 text-teal-200 border-teal-400/20',
		thinking: 'bg-emerald-500/25 text-emerald-200 border-emerald-400/20',
		tool: 'bg-muted text-muted-foreground border-border',
		result: 'bg-amber-500/20 text-amber-200 border-amber-400/20',
		model: 'bg-slate-500/25 text-slate-200 border-slate-400/20',
		status: 'bg-purple-500/20 text-purple-200 border-purple-400/20',
		span: 'bg-blue-500/20 text-blue-200 border-blue-400/20',
		hook: 'bg-indigo-500/25 text-indigo-200 border-indigo-400/20',
		mcp: 'bg-cyan-500/25 text-cyan-200 border-cyan-400/20',
		adk: 'bg-lime-500/20 text-lime-200 border-lime-400/20',
		alert: 'bg-red-500/25 text-red-200 border-red-400/20',
		provision: 'bg-orange-500/20 text-orange-200 border-orange-400/20',
		other: 'bg-muted text-muted-foreground border-border'
	};

	const LABELS: Record<EventKind, string> = {
		user: 'User',
		agent: 'Agent',
		thinking: 'Thinking',
		tool: 'Tool',
		result: 'Result',
		model: 'Model',
		status: 'Status',
		span: 'Span',
		hook: 'Hook',
		mcp: 'MCP',
		adk: 'ADK',
		alert: 'Alert',
		provision: 'Provision',
		other: 'Event'
	};

	const resolved = $derived(label ?? LABELS[kind]);
</script>

<span
	class="inline-flex items-center rounded border font-medium {size === 'xs'
		? 'px-1.5 py-0 text-[9px]'
		: 'px-2 py-0.5 text-[10px]'} {CLASSES[kind]}"
>
	{resolved}
</span>
