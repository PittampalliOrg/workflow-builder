<script lang="ts">
	import {
		Check, X, Loader2, Circle, ChevronDown, ChevronRight,
		Brain, MessageSquare, Wrench, CheckCircle2, XCircle, Bot,
		AlertTriangle, Cable, ShieldCheck, Gauge
	} from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import JsonViewer from './json-viewer.svelte';
	import CollapsibleSection from './collapsible-section.svelte';
	import {
		ChainOfThought,
		ChainOfThoughtHeader,
		ChainOfThoughtContent,
		ChainOfThoughtStep
	} from '$lib/components/ui/ai-elements/chain-of-thought/index.js';
	import { Response } from '$lib/components/ui/ai-elements/response/index.js';

	interface AgentEvent {
		type: string;
		data: Record<string, unknown>;
		timestamp: string;
		toolName?: string | null;
		workflowAgentRunId?: string | null;
		daprInstanceId?: string | null;
	}

	interface AgentRun {
		id: string;
		nodeId: string;
		daprInstanceId: string;
	}

	interface StepLog {
		logId?: string;
		stepName: string;
		label: string;
		displayLabel?: string;
		actionType: string;
		status: string;
		input: unknown;
		output: unknown;
		error: string | null;
		durationMs: number | null;
		attempt?: number;
		attemptsTotal?: number;
	}

	interface Props {
		steps: StepLog[];
		agentEvents?: AgentEvent[];
		agentRuns?: AgentRun[];
	}

	let { steps, agentEvents = [], agentRuns = [] }: Props = $props();

	const AGENT_ACTION_TYPES = new Set(['durable/run']);

	function eventType(event: AgentEvent): string {
		return event.type || (typeof event.data?.type === 'string' ? event.data.type : '');
	}

	function stepAgentEvents(step: StepLog): AgentEvent[] {
		if (!AGENT_ACTION_TYPES.has(step.actionType)) return [];

		const runsForStep = agentRuns.filter((run) => run.nodeId === step.stepName);
		if (runsForStep.length > 0) {
			const runIds = new Set(runsForStep.map((run) => run.id));
			const instanceIds = new Set(runsForStep.map((run) => run.daprInstanceId));
			return agentEvents.filter(
				(event) =>
					(event.workflowAgentRunId && runIds.has(event.workflowAgentRunId)) ||
					(event.daprInstanceId && instanceIds.has(event.daprInstanceId))
			);
		}

		const nodeMatched = agentEvents.filter((event) => event.data?.nodeId === step.stepName);
		if (nodeMatched.length > 0) return nodeMatched;

		const durableSteps = steps.filter((candidate) => AGENT_ACTION_TYPES.has(candidate.actionType));
		return durableSteps.length === 1 ? agentEvents : [];
	}

	// Event types we surface in the chain-of-thought. Covers legacy vocabulary
	// (llm_*, tool_call_*, run_*) AND CMA-shape (agent.*, hook.decision,
	// mcp.tool_call, session.*). Streaming deltas (*_delta) are excluded from
	// the chain because their content rolls up into the corresponding terminal
	// `agent.message` / `agent.thinking` / `agent.tool_use` event — showing
	// every delta separately would flood the view.
	const SIGNIFICANT_EVENT_TYPES = new Set([
		// Legacy
		'llm_start', 'llm_complete',
		'tool_call_start', 'tool_call_end', 'tool_call_error',
		'run_started', 'run_complete', 'run_error',
		// CMA — tier 1/2
		'agent.message', 'agent.thinking',
		'agent.tool_use', 'agent.mcp_tool_use', 'agent.custom_tool_use',
		'agent.tool_result', 'agent.mcp_tool_result', 'agent.custom_tool_result',
		'agent.llm_usage',
		'hook.decision',
		'mcp.tool_call',
		// CMA alerts
		'agent.circuit_breaker_tripped',
		'session.turn_timeout',
		'agent.thread_images_compacted',
		'session.error'
	]);

	function significantEvents(events: AgentEvent[]): AgentEvent[] {
		return events.filter((event) => SIGNIFICANT_EVENT_TYPES.has(eventType(event)));
	}

	function turnCount(events: AgentEvent[]): number {
		// A "turn" = one LLM response landed. Count CMA `agent.message`
		// + CMA `agent.llm_usage` OR legacy `llm_complete`. Dedup by taking
		// the max of the two paths so we don't double-count when both fire.
		const cma = events.filter((event) => eventType(event) === 'agent.message').length;
		const legacy = events.filter((event) => eventType(event) === 'llm_complete').length;
		return Math.max(cma, legacy);
	}

	function toolCount(events: AgentEvent[]): number {
		// A "tool call" = one tool invocation began. Count CMA tool_use types
		// + legacy tool_call_start. Dedup via max.
		const cma = events.filter((event) => {
			const t = eventType(event);
			return t === 'agent.tool_use' || t === 'agent.mcp_tool_use' || t === 'agent.custom_tool_use';
		}).length;
		const legacy = events.filter((event) => eventType(event) === 'tool_call_start').length;
		return Math.max(cma, legacy);
	}

	// Helpers for the CMA render branches below.
	function cmaToolName(event: AgentEvent): string {
		const d = event.data as { name?: unknown; tool_name?: unknown };
		return String(d.name ?? d.tool_name ?? event.toolName ?? 'tool');
	}

	function cmaToolArgsSummary(event: AgentEvent): string | undefined {
		const d = event.data as { input?: unknown; input_preview?: unknown };
		if (typeof d.input_preview === 'string' && d.input_preview) return d.input_preview.slice(0, 150);
		if (d.input && typeof d.input === 'object') {
			return Object.entries(d.input as Record<string, unknown>)
				.map(([k, v]) => `${k}: ${String(v).slice(0, 50)}`)
				.join(', ')
				.slice(0, 150);
		}
		return undefined;
	}

	function cmaToolOutputSummary(event: AgentEvent): string | undefined {
		const d = event.data as { output?: unknown; output_preview?: unknown; error?: unknown };
		if (typeof d.error === 'string' && d.error) return String(d.error).slice(0, 150);
		if (typeof d.output_preview === 'string' && d.output_preview) return d.output_preview.slice(0, 150);
		if (typeof d.output === 'string' && d.output) return d.output.slice(0, 150);
		return undefined;
	}

	function cmaMessageText(event: AgentEvent): string | undefined {
		const d = event.data as { content?: unknown; preview?: unknown };
		if (typeof d.content === 'string' && d.content) return d.content;
		if (Array.isArray(d.content)) {
			const joined = (d.content as Array<{ text?: unknown }>)
				.map((b) => (typeof b?.text === 'string' ? b.text : ''))
				.filter(Boolean)
				.join('\n\n');
			if (joined) return joined;
		}
		if (typeof d.preview === 'string' && d.preview) return d.preview;
		return undefined;
	}

	function llmUsageSummary(event: AgentEvent): string {
		const d = event.data as {
			input_tokens?: number; output_tokens?: number;
			cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
			model?: string;
		};
		const parts: string[] = [];
		if (d.model) parts.push(String(d.model));
		if (d.input_tokens != null) parts.push(`in=${d.input_tokens}`);
		if (d.output_tokens != null) parts.push(`out=${d.output_tokens}`);
		const cr = Number(d.cache_read_input_tokens ?? 0);
		const i = Number(d.input_tokens ?? 0);
		const denom = cr + i;
		if (cr > 0 && denom > 0) parts.push(`cache ${Math.round((cr / denom) * 100)}%`);
		return parts.join(' · ');
	}

	function hookDecisionSummary(event: AgentEvent): string {
		const d = event.data as { hook_event?: string; decision?: string; matcher?: string; duration_ms?: number };
		const parts: string[] = [];
		if (d.hook_event) parts.push(String(d.hook_event));
		if (d.matcher) parts.push(`(${d.matcher})`);
		if (d.decision) parts.push(`→ ${d.decision}`);
		if (d.duration_ms != null) parts.push(`${d.duration_ms}ms`);
		return parts.join(' ');
	}

	function mcpCallSummary(event: AgentEvent): string {
		const d = event.data as { tool_name?: string; server?: string; duration_ms?: number; success?: boolean };
		const parts: string[] = [];
		if (d.tool_name) parts.push(String(d.tool_name));
		if (d.server) parts.push(`@${d.server}`);
		if (d.duration_ms != null) parts.push(`${d.duration_ms}ms`);
		if (d.success === false) parts.push('failed');
		return parts.join(' · ');
	}

	function alertSummary(event: AgentEvent): string {
		const t = eventType(event);
		const d = event.data as Record<string, unknown>;
		if (t === 'agent.circuit_breaker_tripped') {
			return `Circuit breaker: ${String(d.reason ?? '')} (${d.streak ?? '?'}/${d.threshold ?? '?'})`;
		}
		if (t === 'session.turn_timeout') {
			return `Turn ${d.turn ?? '?'} exceeded ${d.timeout_seconds ?? '?'}s`;
		}
		if (t === 'agent.thread_images_compacted') {
			return `Collapsed ${d.collapsed ?? '?'} screenshot(s); kept ${d.kept ?? '?'}`;
		}
		if (t === 'session.error') {
			const err = String(d.error ?? '').slice(0, 120);
			return `Session error${err ? `: ${err}` : ''}`;
		}
		return t;
	}

	let expandedSteps = new SvelteSet<number>();

	function toggleStep(index: number) {
		if (expandedSteps.has(index)) {
			expandedSteps.delete(index);
		} else {
			expandedSteps.add(index);
		}
	}

	function formatDuration(ms: number | null): string {
		if (ms === null) return '';
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
	}

	function statusDotColor(status: string): string {
		switch (status) {
			case 'success': return 'bg-green-500';
			case 'error': return 'bg-red-500';
			case 'running': return 'bg-blue-500';
			default: return 'bg-muted-foreground/50';
		}
	}
</script>

<div class="space-y-0">
	{#each steps as step, i (i)}
		{@const isFirst = i === 0}
		{@const isLast = i === steps.length - 1}
		{@const isExpanded = expandedSteps.has(i)}
		{@const stepEvents = stepAgentEvents(step)}
		{@const stepSignificantEvents = significantEvents(stepEvents)}
		{@const stepTurnCount = turnCount(stepEvents)}
		{@const stepToolCount = toolCount(stepEvents)}

		<div class="relative flex gap-3">
			<!-- Timeline connector -->
			<div class="relative -ml-px flex flex-col items-center pt-2" style="width: 20px;">
				<!-- Top connector line -->
				{#if !isFirst}
					<div class="absolute bottom-full h-2 w-px bg-border"></div>
				{/if}

				<!-- Status dot (h-5 w-5 — matches card header dots) -->
				<div class="z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full {statusDotColor(step.status)}">
					{#if step.status === 'success'}
						<Check size={11} class="text-white" strokeWidth={3} />
					{:else if step.status === 'error'}
						<X size={11} class="text-white" strokeWidth={3} />
					{:else if step.status === 'running'}
						<Loader2 size={11} class="text-white animate-spin" />
					{:else}
						<Circle size={6} class="fill-white text-white" />
					{/if}
				</div>

				<!-- Bottom connector line -->
				{#if !isLast}
					<div class="absolute top-[calc(0.5rem+1.25rem)] bottom-0 w-px bg-border"></div>
				{/if}
			</div>

			<!-- Step content -->
			<div class="min-w-0 flex-1 pb-2">
				<button
					class="group flex w-full items-center gap-2 rounded-lg py-1.5 text-left hover:bg-muted/50 transition-colors"
					onclick={() => toggleStep(i)}
				>
					<svelte:component this={isExpanded ? ChevronDown : ChevronRight} size={12} class="shrink-0 text-muted-foreground" />
					<span class="flex-1 truncate text-xs font-medium group-hover:text-foreground">
						{step.displayLabel || step.label || step.stepName}
					</span>
					{#if step.durationMs !== null}
						<span class="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
							{formatDuration(step.durationMs)}
						</span>
					{/if}
				</button>

				{#if isExpanded}
					<div class="mt-1.5 mb-1 space-y-2.5 pl-5">
						{#if step.input}
							<CollapsibleSection
								title="Input"
								defaultOpen={false}
								copyData={JSON.stringify(step.input, null, 2)}
							>
								<JsonViewer data={step.input} label="Input" collapsed={false} />
							</CollapsibleSection>
						{/if}

						{#if step.output}
							<CollapsibleSection
								title="Output"
								defaultOpen={false}
								copyData={JSON.stringify(step.output, null, 2)}
							>
								<JsonViewer data={step.output} label="Output" collapsed={false} />
							</CollapsibleSection>
						{/if}

						{#if step.error}
							<CollapsibleSection title="Error" defaultOpen={true} isError>
								<div class="rounded-md border border-red-500/20 bg-red-500/5 p-2">
									<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-red-500">{step.error}</pre>
								</div>
							</CollapsibleSection>
						{/if}

						<!-- Agent activity chain-of-thought (for durable/run steps) -->
						{#if AGENT_ACTION_TYPES.has(step.actionType) && stepSignificantEvents.length > 0}
							<div class="space-y-2">
								<!-- Stats summary -->
								{#if stepTurnCount > 0 || stepToolCount > 0}
									<div class="flex items-center gap-3 rounded-lg bg-gradient-to-r from-blue-500/10 via-purple-500/10 to-emerald-500/10 px-3 py-1.5">
										<div class="flex items-center gap-1 text-[10px]">
											<MessageSquare size={10} class="text-blue-400" />
											<span class="font-semibold text-blue-400">{stepTurnCount}</span>
											<span class="text-muted-foreground">turns</span>
										</div>
										<div class="h-3 w-px bg-border"></div>
										<div class="flex items-center gap-1 text-[10px]">
											<Wrench size={10} class="text-orange-400" />
											<span class="font-semibold text-orange-400">{stepToolCount}</span>
											<span class="text-muted-foreground">tools</span>
										</div>
									</div>
								{/if}

								<ChainOfThought defaultOpen={true}>
									<ChainOfThoughtHeader>
										Agent Activity ({stepSignificantEvents.length} steps)
									</ChainOfThoughtHeader>
									<ChainOfThoughtContent>
										{#each stepSignificantEvents as event, ei (event.timestamp + event.type + ei)}
											{@const evtType = eventType(event)}
											{#if evtType === 'llm_start'}
												<ChainOfThoughtStep
													icon={Brain}
													label="Thinking..."
													description={event.data?.model ? `Model: ${event.data.model}` : undefined}
													status="complete"
												/>
											{:else if evtType === 'llm_complete'}
												{@const toolCalls = (event.data?.toolCalls ?? []) as string[]}
												<ChainOfThoughtStep
													icon={MessageSquare}
													label={toolCalls.length ? `Plan: call ${toolCalls.join(', ')}` : 'Response'}
													description={event.data?.content ? String(event.data.content).slice(0, 150) : undefined}
													status="complete"
												/>
											{:else if evtType === 'tool_call_start'}
												<ChainOfThoughtStep
													icon={Wrench}
													label={String(event.toolName || event.data?.toolName || 'Tool')}
													description={event.data?.args ? Object.entries(event.data.args as Record<string, unknown>).map(([k,v]) => `${k}: ${String(v).slice(0,50)}`).join(', ') : undefined}
													status="complete"
												/>
											{:else if evtType === 'tool_call_end'}
												<ChainOfThoughtStep
													icon={event.data?.success ? CheckCircle2 : XCircle}
													label={`${event.toolName || event.data?.toolName || 'Tool'} ${event.data?.success ? '✓' : '✗'}`}
													description={event.data?.output ? String(event.data.output).slice(0, 150) : event.data?.error ? String(event.data.error).slice(0, 150) : undefined}
													status="complete"
												/>
											{:else if evtType === 'run_started'}
												<ChainOfThoughtStep
													icon={Bot}
													label="Agent started"
													description={event.data?.model ? `Using ${event.data.model}` : undefined}
													status="complete"
												/>
											{:else if evtType === 'run_complete'}
												<ChainOfThoughtStep
													icon={CheckCircle2}
													label="Agent completed"
													status="complete"
												/>
											{:else if evtType === 'run_error'}
												<ChainOfThoughtStep
													icon={XCircle}
													label="Agent error"
													description={event.data?.error ? String(event.data.error).slice(0, 150) : undefined}
													status="complete"
												/>
											<!-- CMA Tier 1/2/3 event types -->
											{:else if evtType === 'agent.thinking'}
												{@const thinkingText = cmaMessageText(event)}
												<ChainOfThoughtStep
													icon={Brain}
													label="Thinking"
													status="complete"
												>
													{#if thinkingText}
														<div class="prose prose-sm dark:prose-invert max-w-none text-xs text-muted-foreground">
															<Response content={thinkingText} parseIncompleteMarkdown={true} />
														</div>
													{/if}
												</ChainOfThoughtStep>
											{:else if evtType === 'agent.message'}
												{@const messageText = cmaMessageText(event)}
												<ChainOfThoughtStep
													icon={MessageSquare}
													label="Response"
													status="complete"
												>
													{#if messageText}
														<div class="prose prose-sm dark:prose-invert max-w-none text-xs text-muted-foreground">
															<Response content={messageText} parseIncompleteMarkdown={true} />
														</div>
													{/if}
												</ChainOfThoughtStep>
											{:else if evtType === 'agent.tool_use' || evtType === 'agent.mcp_tool_use' || evtType === 'agent.custom_tool_use'}
												<ChainOfThoughtStep
													icon={Wrench}
													label={cmaToolName(event)}
													description={cmaToolArgsSummary(event)}
													status="complete"
												/>
											{:else if evtType === 'agent.tool_result' || evtType === 'agent.mcp_tool_result' || evtType === 'agent.custom_tool_result'}
												{@const isErr = (event.data as { is_error?: boolean }).is_error === true}
												<ChainOfThoughtStep
													icon={isErr ? XCircle : CheckCircle2}
													label={`${cmaToolName(event)} ${isErr ? '✗' : '✓'}`}
													description={cmaToolOutputSummary(event)}
													status="complete"
												/>
											{:else if evtType === 'agent.llm_usage'}
												<ChainOfThoughtStep
													icon={Gauge}
													label="LLM usage"
													description={llmUsageSummary(event)}
													status="complete"
												/>
											{:else if evtType === 'hook.decision'}
												<ChainOfThoughtStep
													icon={ShieldCheck}
													label="Hook decision"
													description={hookDecisionSummary(event)}
													status="complete"
												/>
											{:else if evtType === 'mcp.tool_call'}
												<ChainOfThoughtStep
													icon={Cable}
													label="MCP tool call"
													description={mcpCallSummary(event)}
													status="complete"
												/>
											{:else if evtType === 'agent.circuit_breaker_tripped' || evtType === 'session.turn_timeout' || evtType === 'agent.thread_images_compacted' || evtType === 'session.error'}
												<ChainOfThoughtStep
													icon={AlertTriangle}
													label={evtType.replace(/^(agent|session)\./, '').replace(/_/g, ' ')}
													description={alertSummary(event)}
													status="complete"
												/>
											{/if}
										{/each}
									</ChainOfThoughtContent>
								</ChainOfThought>
							</div>
						{/if}

						{#if !step.input && !step.output && !step.error && !(AGENT_ACTION_TYPES.has(step.actionType) && stepSignificantEvents.length > 0)}
							<div class="rounded-md border bg-muted/30 py-2.5 text-center text-[10px] text-muted-foreground">
								No data recorded
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/each}
</div>
