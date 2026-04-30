<script lang="ts">
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import { Card, CardHeader, CardTitle, CardContent } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import {
		Table,
		TableHeader,
		TableBody,
		TableRow,
		TableHead,
		TableCell
	} from '$lib/components/ui/table';
	import JsonViewer from '$lib/components/workflow/execution/json-viewer.svelte';
	import { Message, MessageContent, MessageLabel } from '$lib/components/ai-elements/message';
	import { ToolCall } from '$lib/components/ai-elements/tool';
	import {
		RefreshCw,
		Loader2,
		Activity,
		Server,
		Database,
		Bot,
		Radio,
		ChevronDown,
		ChevronRight,
		Search
	} from '@lucide/svelte';
	import {
		getSidecarMetadata,
		getServiceHealth,
		getStateValue,
		getKnownStateKeys,
		getWorkflowSummary,
		getWorkflowHistory,
		getAgentRegistry,
		getAgentDaprState
	} from './data.remote';

	interface AgentInstance {
		input_value: string;
		output: string | null;
		start_time: string;
		end_time: string | null;
		status: string;
		messages: { role: string; content: string; timestamp?: string; name?: string; tool_calls?: unknown[]; tool_call_id?: string }[];
		system_messages: { role: string; content: string; timestamp?: string }[];
		tool_history: { tool_name: string; tool_args?: Record<string, unknown>; execution_result: string; timestamp: string }[];
		workflow_instance_id: string | null;
		workflow_name: string | null;
		triggering_workflow_instance_id: string | null;
		source: string | null;
		session_id: string | null;
	}

	// Remote queries
	const metadata = getSidecarMetadata();
	const services = getServiceHealth();
	const knownKeys = getKnownStateKeys();
	const workflowData = getWorkflowSummary();
	const registry = getAgentRegistry();

	// Local state
	let activeTab = $state('overview');
	let stateStoreName = $state('statestore');
	let stateKey = $state('');
	let stateMetadata: Record<string, string> | undefined = $state(undefined);
	let stateResult: ReturnType<typeof getStateValue> | null = $state(null);
	let stateLoading = $state(false);
	let stateViewMode = $state<'structured' | 'json'>('structured');

	let expandedInstance: string | null = $state(null);
	interface HistoryEvent {
		eventId?: number;
		eventType: string;
		timestamp?: string;
		name?: string;
		input?: unknown;
		output?: unknown;
		metadata?: Record<string, unknown>;
	}

	let historyResult: { events: HistoryEvent[]; error?: string } | null | undefined = $state(null);
	let historyLoading = $state(false);

	// Live pub/sub event stream
	interface StreamEvent {
		id: number;
		topic: string;
		type: string;
		source: string;
		data: unknown;
		timestamp: string;
	}
	let liveEvents = $state<StreamEvent[]>([]);
	let streamConnected = $state(false);
	let eventSource: EventSource | null = $state(null);

	function startEventStream() {
		if (eventSource) return;
		const lastId = liveEvents.length > 0 ? liveEvents[liveEvents.length - 1].id : 0;
		const es = new EventSource(`/api/dapr-system/events?since=${lastId}`);
		eventSource = es;
		streamConnected = true;

		es.addEventListener('dapr-event', (e: MessageEvent) => {
			try {
				const event = JSON.parse(e.data) as StreamEvent;
				liveEvents = [...liveEvents.slice(-199), event];
			} catch {
				// malformed
			}
		});

		es.onerror = () => {
			streamConnected = false;
			es.close();
			eventSource = null;
			// Auto-reconnect after 3s
			setTimeout(startEventStream, 3000);
		};
	}

	function stopEventStream() {
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
		streamConnected = false;
	}

	let selectedAgent: string | null = $state(null);
	let agentStateResult: {
		source?: string;
		storeName?: string;
		agentName?: string;
		stateKey?: string;
		found?: boolean;
		error?: string;
		instances: Record<string, AgentInstance>;
	} | null = $state(null);
	let agentStateLoading = $state(false);
	let selectedInstanceId: string | null = $state(null);
	let agentDetailTab = $state<'events' | 'json'>('events');

	function toggleAgentInstance(instId: string, _inst: AgentInstance) {
		if (selectedInstanceId === instId) {
			selectedInstanceId = null;
			return;
		}
		selectedInstanceId = instId;
		agentDetailTab = 'events';
	}

	// Derived: state store names from metadata
	const stateStores = $derived(
		(metadata.current?.metadata?.components ?? []).filter((c) => c.type.startsWith('state.'))
	);

	// Auto-select the first available state store when metadata loads
	$effect(() => {
		if (stateStores.length > 0 && stateStoreName === 'statestore') {
			const hasDefault = stateStores.some((s) => s.name === 'statestore');
			if (!hasDefault) {
				stateStoreName = stateStores[0].name;
			}
		}
	});
	const pubsubComponents = $derived(
		(metadata.current?.metadata?.components ?? []).filter((c) => c.type.startsWith('pubsub.'))
	);
	const activeAgentRegistry = $derived(registry.current?.agents ?? []);
	const activeAgentRegistryLoading = $derived(registry.loading);

	function refreshAll() {
		metadata.refresh();
		services.refresh();
		knownKeys.refresh();
		workflowData.refresh();
		registry.refresh();
	}

	async function lookupState() {
		if (!stateKey.trim()) return;
		stateLoading = true;
		stateResult = getStateValue({ storeName: stateStoreName, key: stateKey.trim(), metadata: stateMetadata });
		// Wait for it to resolve
		await new Promise<void>((resolve) => {
			const check = () => {
				if (!stateResult?.loading) resolve();
				else setTimeout(check, 50);
			};
			check();
		});
		stateLoading = false;
	}

	function selectKnownKey(key: string, store?: string, metadata?: Record<string, string>) {
		if (store) stateStoreName = store;
		stateKey = key;
		stateMetadata = metadata;
		lookupState();
	}

	async function toggleHistory(instanceId: string) {
		if (expandedInstance === instanceId) {
			expandedInstance = null;
			historyResult = null;
			return;
		}
		expandedInstance = instanceId;
		historyLoading = true;
		historyResult = null;

		const historyQuery = getWorkflowHistory(instanceId);

		await new Promise<void>((resolve) => {
			const check = () => {
				if (!historyQuery.loading) {
					historyResult = historyQuery.current as { events: HistoryEvent[]; error?: string } | undefined;
					resolve();
				} else setTimeout(check, 50);
			};
			check();
		});
		historyLoading = false;
	}

	async function selectAgent(agentName: string) {
		if (selectedAgent === agentName) {
			selectedAgent = null;
			agentStateResult = null;
			selectedInstanceId = null;
			return;
		}
		selectedAgent = agentName;
		agentStateLoading = true;
		agentStateResult = null;
		selectedInstanceId = null;
		const agentMeta = registry.current?.agents?.find((a) => a.name === agentName)?.metadata;
		const storeName = typeof agentMeta?.storeName === 'string' ? agentMeta.storeName : null;
		const stateKey = typeof agentMeta?.stateKey === 'string' ? agentMeta.stateKey : null;
		const appId = typeof agentMeta?.appId === 'string' ? agentMeta.appId : null;
		const instancesEndpoint =
			typeof agentMeta?.instancesEndpoint === 'string' ? agentMeta.instancesEndpoint : null;
		const q = getAgentDaprState({ agentName, storeName, stateKey, appId, instancesEndpoint });
		await new Promise<void>((resolve) => {
			const check = () => {
				if (!q.loading) {
					agentStateResult = q.current as typeof agentStateResult;
					resolve();
				} else setTimeout(check, 50);
			};
			check();
		});
		agentStateLoading = false;
	}

	function statusVariant(
		status: string
	): 'default' | 'secondary' | 'destructive' | 'outline' {
		const s = status.toUpperCase();
		if (s === 'RUNNING' || s === 'PENDING' || s === 'SUSPENDED') return 'default';
		if (s === 'COMPLETED' || s === 'SUCCESS') return 'secondary';
		if (s === 'FAILED' || s === 'ERROR') return 'destructive';
		return 'outline';
	}

	// -- Agent activity structured data types --

	interface ToolCall {
		id: string;
		name: string;
		args: Record<string, unknown>;
	}

	interface ToolResult {
		stdout?: string;
		stderr?: string;
		exitCode?: number;
		success?: boolean;
		files?: { path: string; status: string }[];
		patchPreview?: string;
		sandbox?: { name?: string; backend?: string };
		raw?: string;
	}

	interface ActivityTurn {
		type: 'prompt' | 'tool_turn' | 'response' | 'system';
		timestamp?: string;
		// prompt
		content?: string;
		// tool_turn
		toolCalls?: ToolCall[];
		toolResults?: { callId: string; name: string; result: ToolResult }[];
		// response
		responseText?: string;
	}

	/** Parse messages + system_messages into structured activity turns */
	function buildActivityTimeline(inst: AgentInstance): ActivityTurn[] {
		const turns: ActivityTurn[] = [];

		// System messages first
		if (inst.system_messages?.length) {
			for (const msg of inst.system_messages) {
				turns.push({ type: 'system', content: String(msg.content || ''), timestamp: msg.timestamp });
			}
		}

		const msgs = inst.messages || [];
		let i = 0;
		while (i < msgs.length) {
			const msg = msgs[i];

			if (msg.role === 'user') {
				turns.push({ type: 'prompt', content: String(msg.content || ''), timestamp: msg.timestamp });
				i++;
			} else if (msg.role === 'assistant' && msg.tool_calls?.length) {
				// Parse tool calls
				const toolCalls: ToolCall[] = [];
				for (const tc of msg.tool_calls as { id?: string; function?: { name?: string; arguments?: string } }[]) {
					let args: Record<string, unknown> = {};
					try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* */ }
					toolCalls.push({ id: tc.id || '', name: tc.function?.name || 'unknown', args });
				}

				// Collect subsequent tool result messages
				const toolResults: { callId: string; name: string; result: ToolResult }[] = [];
				let j = i + 1;
				while (j < msgs.length && msgs[j].role === 'tool') {
					const toolMsg = msgs[j];
					const result = parseToolResultStr(String(toolMsg.content || ''));
					toolResults.push({
						callId: toolMsg.tool_call_id || '',
						name: toolMsg.name || 'unknown',
						result,
					});
					j++;
				}

				turns.push({ type: 'tool_turn', toolCalls, toolResults, timestamp: msg.timestamp });
				i = j;
			} else if (msg.role === 'assistant' && msg.content) {
				turns.push({ type: 'response', responseText: String(msg.content), timestamp: msg.timestamp });
				i++;
			} else {
				i++;
			}
		}

		return turns;
	}

	function parseToolResultStr(resultStr: string): ToolResult {
		try {
			const r = JSON.parse(resultStr);
			return {
				stdout: r.stdout || undefined,
				stderr: r.stderr || undefined,
				exitCode: r.exitCode,
				success: r.success,
				files: r.changeSummary?.files,
				patchPreview: r.changeSummary?.inlinePatchPreview,
				sandbox: r.sandbox?.details ? { name: r.sandbox.details.sandboxName, backend: r.sandbox.backend } : undefined,
			};
		} catch {
			return { raw: resultStr.slice(0, 500) };
		}
	}

	function formatTime(dateStr: string | undefined): string {
		if (!dateStr) return '-';
		return new Date(dateStr).toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	}
</script>

<div class="flex h-full flex-col">
	<!-- Header -->
	<header class="flex h-12 shrink-0 items-center justify-between border-b border-border px-6">
		<h1 class="text-sm font-semibold tracking-tight">Dapr System</h1>
		<div class="flex items-center gap-2">
			<Button variant="outline" size="sm" onclick={refreshAll}>
				<RefreshCw class="mr-1.5 h-3.5 w-3.5" />
				Refresh
			</Button>
		</div>
	</header>

	<!-- Tabs -->
	<div class="flex-1 overflow-auto">
		<Tabs bind:value={activeTab} class="h-full p-4">
			<TabsList>
				<TabsTrigger value="overview">
					<Server class="mr-1.5 h-3.5 w-3.5" />
					Overview
				</TabsTrigger>
				<TabsTrigger value="state">
					<Database class="mr-1.5 h-3.5 w-3.5" />
					State Inspector
				</TabsTrigger>
				<TabsTrigger value="workflows">
					<Activity class="mr-1.5 h-3.5 w-3.5" />
					Workflows
				</TabsTrigger>
				<TabsTrigger value="agents">
					<Bot class="mr-1.5 h-3.5 w-3.5" />
					Agents
				</TabsTrigger>
				<TabsTrigger value="pubsub">
					<Radio class="mr-1.5 h-3.5 w-3.5" />
					Pub/Sub
				</TabsTrigger>
			</TabsList>

			<!-- ==================== OVERVIEW TAB ==================== -->
			<TabsContent value="overview" class="space-y-4">
				<!-- Sidecar Status -->
				<Card>
					<CardHeader>
						<CardTitle class="text-sm">Sidecar Status</CardTitle>
					</CardHeader>
					<CardContent>
						{#if metadata.loading}
							<div class="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2 class="h-4 w-4 animate-spin" /> Loading...
							</div>
						{:else if metadata.current?.metadata}
							{@const meta = metadata.current.metadata}
							<div class="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
								<div>
									<div class="text-xs text-muted-foreground">Health</div>
									<Badge variant={metadata.current.healthy ? 'secondary' : 'destructive'}>
										{metadata.current.healthy ? 'Healthy' : 'Unhealthy'}
									</Badge>
								</div>
								<div>
									<div class="text-xs text-muted-foreground">App ID</div>
									<div class="font-mono">{meta.id || '-'}</div>
								</div>
								<div>
									<div class="text-xs text-muted-foreground">Runtime Version</div>
									<div class="font-mono">{meta.runtimeVersion || '-'}</div>
								</div>
								<div>
									<div class="text-xs text-muted-foreground">Components</div>
									<div>{meta.components?.length ?? 0}</div>
								</div>
							</div>
						{:else}
							<p class="text-sm text-muted-foreground">
								Dapr sidecar unavailable. Ensure the app is running with a Dapr sidecar.
							</p>
						{/if}
					</CardContent>
				</Card>

				<!-- Loaded Components -->
				{#if metadata.current?.metadata?.components?.length}
					<Card>
						<CardHeader>
							<CardTitle class="text-sm">Loaded Components</CardTitle>
						</CardHeader>
						<CardContent>
							<div class="rounded-md border border-border">
								<Table>
									<TableHeader>
										<TableRow
											class="border-b border-border bg-muted/50 text-xs font-medium uppercase tracking-wider text-muted-foreground"
										>
											<TableHead class="px-4 py-2">Name</TableHead>
											<TableHead class="px-4 py-2">Type</TableHead>
											<TableHead class="px-4 py-2">Version</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{#each metadata.current.metadata.components as comp}
											<TableRow class="border-b border-border last:border-b-0">
												<TableCell class="px-4 py-2 font-mono text-sm">{comp.name}</TableCell>
												<TableCell class="px-4 py-2">
													<Badge variant="outline" class="text-xs">{comp.type}</Badge>
												</TableCell>
												<TableCell class="px-4 py-2 text-sm text-muted-foreground"
													>{comp.version}</TableCell
												>
											</TableRow>
										{/each}
									</TableBody>
								</Table>
							</div>
						</CardContent>
					</Card>
				{/if}

				<!-- Service Health Matrix -->
				<Card>
					<CardHeader>
						<CardTitle class="text-sm">Service Health</CardTitle>
					</CardHeader>
					<CardContent>
						{#if services.loading}
							<div class="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2 class="h-4 w-4 animate-spin" /> Loading...
							</div>
						{:else if services.current?.length}
							<div class="rounded-md border border-border">
								<Table>
									<TableHeader>
										<TableRow
											class="border-b border-border bg-muted/50 text-xs font-medium uppercase tracking-wider text-muted-foreground"
										>
											<TableHead class="px-4 py-2">Service</TableHead>
											<TableHead class="px-4 py-2">Status</TableHead>
											<TableHead class="px-4 py-2">Version</TableHead>
											<TableHead class="px-4 py-2">Runtime</TableHead>
											<TableHead class="px-4 py-2">Workflows</TableHead>
											<TableHead class="px-4 py-2">Activities</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{#each services.current as svc}
											<TableRow class="border-b border-border last:border-b-0">
												<TableCell class="px-4 py-2 font-mono text-sm">{svc.id}</TableCell>
												<TableCell class="px-4 py-2">
													<Badge variant={svc.healthy ? 'secondary' : 'destructive'}>
														{svc.healthy ? 'Healthy' : 'Unreachable'}
													</Badge>
												</TableCell>
												<TableCell class="px-4 py-2 text-sm">{svc.version}</TableCell>
												<TableCell class="px-4 py-2 text-sm">{svc.runtime}</TableCell>
												<TableCell class="px-4 py-2 text-sm">{svc.workflowCount}</TableCell>
												<TableCell class="px-4 py-2 text-sm">{svc.activityCount}</TableCell>
											</TableRow>
										{/each}
									</TableBody>
								</Table>
							</div>
						{:else}
							<p class="text-sm text-muted-foreground">No services discovered.</p>
						{/if}
					</CardContent>
				</Card>
			</TabsContent>

			<!-- ==================== STATE INSPECTOR TAB ==================== -->
			<TabsContent value="state" class="space-y-4">
				<!-- Key Lookup -->
				<Card>
					<CardHeader>
						<CardTitle class="text-sm">State Store Lookup</CardTitle>
					</CardHeader>
					<CardContent>
						<div class="flex items-end gap-3">
								<div class="w-48">
									<label for="dapr-state-store" class="mb-1 block text-xs text-muted-foreground">Store</label>
									<NativeSelect id="dapr-state-store" bind:value={stateStoreName}>
									{#each stateStores as store}
										<option value={store.name}>{store.name}</option>
									{/each}
									{#if stateStores.length === 0}
										<option value="statestore">statestore</option>
									{/if}
								</NativeSelect>
								</div>
								<div class="flex-1">
									<label for="dapr-state-key" class="mb-1 block text-xs text-muted-foreground">Key</label>
									<Input
										id="dapr-state-key"
										bind:value={stateKey}
										placeholder="e.g. agents:default or my-agent:workflow_state"
										oninput={() => stateMetadata = undefined}
										onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && lookupState()}
									/>
							</div>
							<Button size="sm" onclick={lookupState} disabled={stateLoading || !stateKey.trim()}>
								{#if stateLoading}
									<Loader2 class="mr-1.5 h-3.5 w-3.5 animate-spin" />
								{:else}
									<Search class="mr-1.5 h-3.5 w-3.5" />
								{/if}
								Lookup
							</Button>
						</div>
					</CardContent>
				</Card>

				<!-- Known Keys -->
				<Card>
					<CardHeader>
						<CardTitle class="text-sm">Known Keys</CardTitle>
					</CardHeader>
					<CardContent>
						{#if knownKeys.loading}
							<div class="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2 class="h-4 w-4 animate-spin" /> Discovering keys...
							</div>
						{:else if knownKeys.current}
							{@const k = knownKeys.current}
							<div class="space-y-3">
								{#if k.agents.length > 0}
									<div>
										<h4 class="mb-1 text-xs font-medium text-muted-foreground">
											Agent State ({k.agents.length})
										</h4>
										<div class="flex flex-wrap gap-1.5">
												{#each k.agents as agent}
													<Button
														variant="outline"
														size="sm"
														class="h-7 text-xs font-mono"
														onclick={() => selectKnownKey(agent.key, agent.storeName, agent.metadata)}
													>
													{agent.label}
												</Button>
											{/each}
										</div>
									</div>
								{/if}
								{#if k.conversations.length > 0}
									<div>
										<h4 class="mb-1 text-xs font-medium text-muted-foreground">
											Conversations ({k.conversations.length})
										</h4>
										<div class="flex flex-wrap gap-1.5">
												{#each k.conversations as conv}
													<Button
														variant="outline"
														size="sm"
														class="h-7 text-xs font-mono"
														onclick={() => selectKnownKey(conv.key, conv.storeName, conv.metadata)}
													>
													{conv.label.length > 24
														? conv.label.slice(0, 24) + '...'
														: conv.label}
												</Button>
											{/each}
										</div>
									</div>
								{/if}
								{#if k.agents.length === 0 && k.conversations.length === 0}
									<p class="text-sm text-muted-foreground">
										No known keys found. The agent registry may be empty or the sidecar may be
										unavailable.
									</p>
								{/if}
							</div>
						{/if}
					</CardContent>
				</Card>

				<!-- State Result -->
				{#if stateResult}
					<Card>
						<CardHeader>
							<div class="flex items-center justify-between">
								<CardTitle class="flex items-center gap-2 text-sm">
									<span class="font-mono">{stateStoreName}/{stateKey}</span>
									{#if stateResult.current?.found}
										<Badge variant="secondary">Found</Badge>
									{:else}
										<Badge variant="outline">Not Found</Badge>
									{/if}
									{#if stateResult.current?.etag}
										<span class="text-xs font-normal text-muted-foreground">ETag: {stateResult.current.etag}</span>
									{/if}
								</CardTitle>
								{#if stateResult.current?.found}
									<div class="flex gap-1">
										<Button
											variant={stateViewMode === 'structured' ? 'default' : 'outline'}
											size="sm"
											class="h-6 text-[10px]"
											onclick={() => stateViewMode = 'structured'}
										>Structured</Button>
										<Button
											variant={stateViewMode === 'json' ? 'default' : 'outline'}
											size="sm"
											class="h-6 text-[10px]"
											onclick={() => stateViewMode = 'json'}
										>JSON</Button>
									</div>
								{/if}
							</div>
						</CardHeader>
						<CardContent>
							{#if stateResult.loading}
								<div class="flex items-center gap-2 text-sm text-muted-foreground">
									<Loader2 class="h-4 w-4 animate-spin" /> Loading...
								</div>
							{:else if stateResult.current?.found}
								{@const val = stateResult.current.value}
								{@const isAgentState = val && typeof val === 'object' && 'instances' in val}
								{@const isConversation = Array.isArray(val) && val.length > 0 && val[0]?.role}

								{#if stateViewMode === 'json'}
									<!-- JSON view -->
									<JsonViewer data={val} label="Value" />
								{:else if isConversation}
									<!-- Structured conversation view using ai-elements -->
									{@const roles = [...new Set(val.map((m: Record<string, unknown>) => m.role))]}
									<div class="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
										<Badge variant="outline">{val.length} messages</Badge>
										{#each roles as role}
											<span class="text-muted-foreground">{role}: {val.filter((m: Record<string, unknown>) => m.role === role).length}</span>
										{/each}
									</div>
									<div class="space-y-0.5">
										{#each val as msg}
											{@const role = String(msg.role || '')}
											{@const content = String(msg.content || '')}
											<Message from={role === 'user' ? 'user' : role === 'tool' ? 'tool' : 'assistant'}>
												<MessageContent variant={role === 'tool' ? 'flat' : 'contained'}>
													<MessageLabel>
														{role}{msg.name ? `: ${msg.name}` : ''} &middot; {formatTime(String(msg.createdAt || msg.timestamp || ''))}
													</MessageLabel>
													{#if content}
														<div class="whitespace-pre-wrap break-words text-[11px] {role === 'tool' ? 'font-mono' : ''}">{content.length > 400 ? content.slice(0, 400) + '...' : content}</div>
													{:else if msg.tool_calls}
														<span class="text-[11px] text-muted-foreground">[{Array.isArray(msg.tool_calls) ? msg.tool_calls.length : 1} tool call(s)]</span>
													{/if}
												</MessageContent>
											</Message>
										{/each}
									</div>
								{:else if isAgentState}
									<!-- Structured agent state view -->
									{@const agentInstances = Object.entries((val as { instances: Record<string, { status?: string; messages?: unknown[]; tool_history?: unknown[]; start_time?: string }> }).instances)}
									<div class="mb-2 text-xs text-muted-foreground">
										<Badge variant="outline">{agentInstances.length} instances</Badge>
									</div>
									<div class="rounded border border-border/30">
										<table class="w-full text-xs">
											<thead>
												<tr class="border-b border-border/50 bg-muted/30 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
													<th class="px-3 py-1.5 font-medium">Instance</th>
													<th class="px-3 py-1.5 font-medium">Status</th>
													<th class="px-3 py-1.5 font-medium">Messages</th>
													<th class="px-3 py-1.5 font-medium">Tools</th>
													<th class="px-3 py-1.5 font-medium">Started</th>
												</tr>
											</thead>
											<tbody>
												{#each agentInstances as [iid, aInst]}
													<tr class="border-b border-border/30 last:border-b-0">
														<td class="px-3 py-1.5 font-mono" title={iid}>{iid.length > 20 ? iid.slice(0, 20) + '...' : iid}</td>
														<td class="px-3 py-1.5">
															<Badge variant={statusVariant(String(aInst.status || ''))} class="text-[10px]">{aInst.status}</Badge>
														</td>
														<td class="px-3 py-1.5">{Array.isArray(aInst.messages) ? aInst.messages.length : 0}</td>
														<td class="px-3 py-1.5">{Array.isArray(aInst.tool_history) ? aInst.tool_history.length : 0}</td>
														<td class="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{formatTime(String(aInst.start_time || ''))}</td>
													</tr>
												{/each}
											</tbody>
										</table>
									</div>
								{:else}
									<!-- Unknown structure - syntax highlighted JSON -->
									<JsonViewer data={val} label="Value" />
								{/if}
							{:else if stateResult.current?.error}
								<p class="text-sm text-destructive">{stateResult.current.error}</p>
							{:else}
								<p class="text-sm text-muted-foreground">Key not found in state store.</p>
							{/if}
						</CardContent>
					</Card>
				{/if}
			</TabsContent>

			<!-- ==================== WORKFLOWS TAB ==================== -->
			<TabsContent value="workflows" class="space-y-4">
				<!-- Summary Cards -->
				{#if workflowData.current}
					{@const s = workflowData.current.summary}
					<div class="grid grid-cols-2 gap-3 md:grid-cols-4">
						<Card>
							<CardContent class="pt-4">
								<div class="text-2xl font-bold">{s.total}</div>
								<div class="text-xs text-muted-foreground">Total</div>
							</CardContent>
						</Card>
						<Card>
							<CardContent class="pt-4">
								<div class="text-2xl font-bold text-blue-500">{s.running}</div>
								<div class="text-xs text-muted-foreground">Running</div>
							</CardContent>
						</Card>
						<Card>
							<CardContent class="pt-4">
								<div class="text-2xl font-bold text-green-500">{s.completed}</div>
								<div class="text-xs text-muted-foreground">Completed</div>
							</CardContent>
						</Card>
						<Card>
							<CardContent class="pt-4">
								<div class="text-2xl font-bold text-red-500">{s.failed}</div>
								<div class="text-xs text-muted-foreground">Failed</div>
							</CardContent>
						</Card>
						</div>

						{#if workflowData.current.registrations?.length}
							<Card>
								<CardHeader>
									<CardTitle class="text-sm">
										Registered Workflows ({workflowData.current.registrations.length})
									</CardTitle>
								</CardHeader>
								<CardContent>
									<div class="rounded-md border border-border">
										<Table>
											<TableHeader>
												<TableRow class="border-b border-border bg-muted/50 text-xs font-medium uppercase tracking-wider text-muted-foreground">
													<TableHead class="px-4 py-2">Workflow</TableHead>
													<TableHead class="px-4 py-2">Service</TableHead>
													<TableHead class="px-4 py-2">Version</TableHead>
												</TableRow>
											</TableHeader>
											<TableBody>
												{#each workflowData.current.registrations as wf}
													<TableRow class="border-b border-border last:border-b-0">
														<TableCell class="px-4 py-2 font-mono text-sm">{wf.name}</TableCell>
														<TableCell class="px-4 py-2">
															<Badge variant="outline" class="text-xs">{wf.serviceId}</Badge>
														</TableCell>
														<TableCell class="px-4 py-2 font-mono text-xs text-muted-foreground">{wf.version || '-'}</TableCell>
													</TableRow>
												{/each}
											</TableBody>
										</Table>
									</div>
									{#if workflowData.current.discovery?.registrations}
										<p class="mt-2 text-xs text-muted-foreground">{workflowData.current.discovery.registrations}</p>
									{/if}
								</CardContent>
							</Card>
						{/if}

						{#if workflowData.current.discovery?.executions}
							<p class="text-xs text-muted-foreground">{workflowData.current.discovery.executions}</p>
						{/if}

						{#if workflowData.current.orchestratorError}
							<p class="text-xs text-destructive">{workflowData.current.orchestratorError}</p>
						{/if}

						<!-- Instance Table -->
						{#if workflowData.current.instances.length > 0}
							<Card>
							<CardHeader>
								<CardTitle class="text-sm">
									Recent Instances ({workflowData.current.instances.length})
								</CardTitle>
							</CardHeader>
							<CardContent>
								<div class="rounded-md border border-border">
									<Table>
										<TableHeader>
											<TableRow
												class="border-b border-border bg-muted/50 text-xs font-medium uppercase tracking-wider text-muted-foreground"
											>
												<TableHead class="w-8 px-4 py-2"></TableHead>
												<TableHead class="px-4 py-2">Instance ID</TableHead>
												<TableHead class="px-4 py-2">Workflow</TableHead>
												<TableHead class="px-4 py-2">Status</TableHead>
												<TableHead class="px-4 py-2">Started</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{#each workflowData.current.instances as inst}
												{@const id = inst.instanceId}
												<TableRow
													class="cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/30"
													onclick={() => toggleHistory(id)}
												>
													<TableCell class="px-4 py-2">
														{#if expandedInstance === id}
															<ChevronDown class="h-4 w-4 text-muted-foreground" />
														{:else}
															<ChevronRight class="h-4 w-4 text-muted-foreground" />
														{/if}
													</TableCell>
													<TableCell class="px-4 py-2 font-mono text-xs" title={id}>
														{id.length > 30 ? id.slice(0, 30) + '...' : id}
													</TableCell>
													<TableCell class="px-4 py-2 text-sm">
														{inst.workflowName || inst.workflowId || '-'}
													</TableCell>
													<TableCell class="px-4 py-2">
														<Badge
															variant={statusVariant(inst.runtimeStatus || inst.status || '')}
														>
															{inst.runtimeStatus || inst.status || 'UNKNOWN'}
														</Badge>
													</TableCell>
													<TableCell class="px-4 py-2 text-sm text-muted-foreground">
														{formatTime(inst.startedAt)}
													</TableCell>
												</TableRow>
												{#if expandedInstance === id}
													<TableRow class="bg-muted/20">
														<TableCell colspan={5} class="px-4 py-3">
																{#if historyLoading}
																	<div class="flex items-center gap-2 text-sm text-muted-foreground">
																		<Loader2 class="h-4 w-4 animate-spin" /> Loading...
																	</div>
																{:else if historyResult?.error}
																	<p class="text-xs text-destructive">{historyResult.error}</p>
																{:else if historyResult?.events?.length}
																	<table class="w-full text-xs">
																		<thead>
																			<tr class="border-b border-border/50 bg-muted/30 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
																				<th class="px-2 py-1 font-medium">Time</th>
																				<th class="px-2 py-1 font-medium">Event</th>
																				<th class="px-2 py-1 font-medium">Name</th>
																				<th class="px-2 py-1 font-medium">Details</th>
																			</tr>
																		</thead>
																		<tbody>
																			{#each historyResult.events as event}
																				<tr class="border-b border-border/30 last:border-b-0">
																					<td class="whitespace-nowrap px-2 py-1 text-muted-foreground">{formatTime(event.timestamp)}</td>
																					<td class="px-2 py-1"><Badge variant="outline" class="text-[10px]">{event.eventType}</Badge></td>
																					<td class="px-2 py-1 font-mono">{event.name || ''}</td>
																					<td class="px-2 py-1">
																						{#if event.metadata?.error}
																							<span class="text-destructive">{event.metadata.error}</span>
																						{:else if event.metadata?.taskId}
																							<span class="text-muted-foreground">task #{event.metadata.taskId}</span>
																						{/if}
																					</td>
																				</tr>
																			{/each}
																		</tbody>
																	</table>
																{:else}
																	<p class="text-xs text-muted-foreground">No Dapr workflow history found for this instance.</p>
																{/if}
															</TableCell>
														</TableRow>
												{/if}
											{/each}
										</TableBody>
									</Table>
								</div>
							</CardContent>
						</Card>
					{/if}
				{:else if workflowData.loading}
					<div class="flex items-center justify-center py-12">
						<Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
					</div>
				{:else}
					<div class="flex flex-col items-center justify-center py-16 text-center">
						<Activity class="mb-4 h-12 w-12 text-muted-foreground/50" />
						<p class="text-sm text-muted-foreground">
							Unable to load workflow data. Orchestrator may be unavailable.
						</p>
					</div>
				{/if}
			</TabsContent>

				<!-- ==================== AGENTS TAB ==================== -->
				<TabsContent value="agents" class="space-y-4">
					<div class="flex items-center justify-between">
						<Badge variant="outline">Dapr Agent Registry</Badge>
						<div class="text-xs text-muted-foreground">
							Reads Dapr registry records and declared Dapr execution state keys only.
						</div>
					</div>

					{#if registry.current?.discovery?.definitions}
						<p class="text-xs text-muted-foreground">{registry.current.discovery.definitions}</p>
					{/if}

					{#if registry.current?.diagnostics?.length}
						<div class="rounded border border-border/50 px-3 py-2 text-xs text-muted-foreground">
							{#each registry.current.diagnostics as diagnostic}
								<div>{diagnostic}</div>
							{/each}
						</div>
					{/if}

					{#if activeAgentRegistryLoading}
					<div class="flex items-center justify-center py-12">
						<Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
					</div>
				{:else if activeAgentRegistry.length}
					<!-- Agent cards -->
					{#each activeAgentRegistry as { name, metadata: meta }}
						<Card>
							<CardHeader class="cursor-pointer" onclick={() => selectAgent(name)}>
								<div class="flex items-center justify-between">
									<div class="flex items-center gap-3">
										{#if selectedAgent === name}
											<ChevronDown class="h-4 w-4 text-muted-foreground" />
										{:else}
											<ChevronRight class="h-4 w-4 text-muted-foreground" />
										{/if}
										<CardTitle class="font-mono text-sm">{name}</CardTitle>
											{#if meta.instanceCount != null}
												<Badge variant="outline">{meta.instanceCount} instances</Badge>
											{/if}
											<Badge variant="outline">Dapr</Badge>
										</div>
										<span class="font-mono text-xs text-muted-foreground">{meta.stateKey || meta.registryKey || meta.storeName || ''}</span>
									</div>
								</CardHeader>
							{#if selectedAgent === name}
								<CardContent>
									{#if agentStateLoading}
										<div class="flex items-center gap-2 text-sm text-muted-foreground">
											<Loader2 class="h-4 w-4 animate-spin" /> Loading agent state...
										</div>
									{:else if agentStateResult?.instances}
										{@const entries = Object.entries(agentStateResult.instances).sort((a, b) => (b[1].start_time || '').localeCompare(a[1].start_time || ''))}
										{@const completed = entries.filter(([, i]) => i.status === 'completed').length}
										{@const failed = entries.filter(([, i]) => i.status !== 'completed' && i.end_time).length}
										{@const running = entries.filter(([, i]) => !i.end_time).length}
										{@const totalMessages = entries.reduce((s, [, i]) => s + (i.messages?.length ?? 0), 0)}
										{@const totalTools = entries.reduce((s, [, i]) => s + (i.tool_history?.length ?? 0), 0)}
										{@const toolNames = [...new Set(entries.flatMap(([, i]) => (i.tool_history ?? []).map((t) => t.tool_name)))]}

											<div class="mb-4 rounded border border-border/50 px-3 py-2 text-xs">
												<div><span class="text-muted-foreground">State store:</span> <span class="font-mono">{agentStateResult?.storeName || '-'}</span></div>
												<div><span class="text-muted-foreground">State key:</span> <span class="font-mono">{agentStateResult?.stateKey || '-'}</span></div>
												{#if agentStateResult?.error}
													<div class="text-red-500">{agentStateResult.error}</div>
												{/if}
											</div>

											{#if registry.current?.discovery?.executions}
												<p class="mb-4 text-xs text-muted-foreground">{registry.current.discovery.executions}</p>
											{/if}

										<!-- Summary stats -->
										<div class="mb-4 grid grid-cols-3 gap-3 md:grid-cols-6">
											<div class="rounded border border-border/50 px-3 py-2">
												<div class="text-lg font-semibold">{entries.length}</div>
												<div class="text-[10px] text-muted-foreground">Runs</div>
											</div>
											<div class="rounded border border-border/50 px-3 py-2">
												<div class="text-lg font-semibold text-green-500">{completed}</div>
												<div class="text-[10px] text-muted-foreground">Completed</div>
											</div>
											<div class="rounded border border-border/50 px-3 py-2">
												<div class="text-lg font-semibold text-red-500">{failed}</div>
												<div class="text-[10px] text-muted-foreground">Failed</div>
											</div>
											<div class="rounded border border-border/50 px-3 py-2">
												<div class="text-lg font-semibold text-blue-500">{running}</div>
												<div class="text-[10px] text-muted-foreground">Running</div>
											</div>
											<div class="rounded border border-border/50 px-3 py-2">
												<div class="text-lg font-semibold">{totalMessages}</div>
												<div class="text-[10px] text-muted-foreground">Messages</div>
											</div>
											<div class="rounded border border-border/50 px-3 py-2">
												<div class="text-lg font-semibold">{totalTools}</div>
												<div class="text-[10px] text-muted-foreground">Tool Calls</div>
											</div>
										</div>

										<!-- Tool usage breakdown -->
										{#if toolNames.length > 0}
											<div class="mb-4">
												<h4 class="mb-1.5 text-xs font-medium text-muted-foreground">Tools Used</h4>
												<div class="flex flex-wrap gap-1.5">
													{#each toolNames as toolName}
														{@const count = entries.reduce((s, [, i]) => s + (i.tool_history ?? []).filter((t) => t.tool_name === toolName).length, 0)}
														<Badge variant="outline" class="text-xs">
															{toolName} <span class="ml-1 text-muted-foreground">({count})</span>
														</Badge>
													{/each}
												</div>
											</div>
										{/if}

										<!-- Instance list -->
										<div class="rounded-md border border-border">
											<table class="w-full text-xs">
												<thead>
													<tr class="border-b border-border bg-muted/50 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
														<th class="w-6 px-3 py-2"></th>
														<th class="px-3 py-2 font-medium">Instance</th>
														<th class="px-3 py-2 font-medium">Status</th>
														<th class="px-3 py-2 font-medium">Duration</th>
														<th class="px-3 py-2 font-medium">Messages</th>
														<th class="px-3 py-2 font-medium">Tools</th>
														<th class="px-3 py-2 font-medium">Started</th>
													</tr>
												</thead>
												<tbody>
													{#each entries.slice(0, 15) as [instId, inst]}
														{@const duration = inst.start_time && inst.end_time
															? Math.round((new Date(inst.end_time).getTime() - new Date(inst.start_time).getTime()) / 1000)
															: null}
														<tr
															class="cursor-pointer border-b border-border/50 last:border-b-0 hover:bg-muted/20 {selectedInstanceId === instId ? 'bg-muted/30' : ''}"
															onclick={() => toggleAgentInstance(instId, inst)}
														>
															<td class="px-3 py-2">
																{#if selectedInstanceId === instId}
																	<ChevronDown class="h-3 w-3 text-muted-foreground" />
																{:else}
																	<ChevronRight class="h-3 w-3 text-muted-foreground" />
																{/if}
															</td>
															<td class="px-3 py-2 font-mono" title={instId}>
																{instId.length > 20 ? instId.slice(0, 20) + '...' : instId}
															</td>
															<td class="px-3 py-2">
																<Badge variant={statusVariant(inst.status)} class="text-[10px]">
																	{inst.status}
																</Badge>
															</td>
															<td class="px-3 py-2 text-muted-foreground">
																{#if duration !== null}
																	{duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`}
																{:else if !inst.end_time}
																	<span class="text-blue-500">running</span>
																{:else}
																	-
																{/if}
															</td>
															<td class="px-3 py-2">{inst.messages?.length ?? 0}</td>
															<td class="px-3 py-2">{inst.tool_history?.length ?? 0}</td>
															<td class="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatTime(inst.start_time)}</td>
														</tr>
															{#if selectedInstanceId === instId}
																<tr>
																	<td colspan={7} class="border-b border-border/30 px-3 py-3">
																		<div class="space-y-3">
																				<!-- Summary -->
																				<div class="grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-4">
																					<div><span class="text-muted-foreground">Workflow:</span> <span class="font-mono">{inst.workflow_name || '-'}</span></div>
																					<div><span class="text-muted-foreground">Source:</span> <span class="font-mono">{inst.source || '-'}</span></div>
																					<div><span class="text-muted-foreground">Started:</span> {formatTime(inst.start_time)}</div>
																					<div><span class="text-muted-foreground">Ended:</span> {formatTime(inst.end_time ?? undefined)}</div>
																					{#if inst.output}
																						<div class="col-span-2"><span class="text-muted-foreground">Output:</span> <span class="text-green-500">{String(inst.output).slice(0, 100)}</span></div>
																					{/if}
																			</div>

																			<!-- Sub-tabs -->
																				<div class="flex gap-1">
																					{#each [
																						{ key: 'events', label: 'Dapr Activity', count: inst.messages?.length || 0 },
																						{ key: 'json', label: 'JSON' },
																					] as tab}
																					<Button
																						variant={agentDetailTab === tab.key ? 'default' : 'outline'}
																						size="sm"
																						class="h-6 text-[10px]"
																						onclick={() => agentDetailTab = tab.key as typeof agentDetailTab}
																					>
																						{tab.label}{tab.count ? ` (${tab.count})` : ''}
																					</Button>
																				{/each}
																			</div>

																			{#if agentDetailTab === 'events'}
																				<!-- Structured activity timeline using ai-elements -->
																				{@const timeline = buildActivityTimeline(inst)}
																				<div class="space-y-1">
																					{#each timeline as turn, turnIdx}
																						{#if turn.type === 'system'}
																							<Message from="system">
																								<MessageContent variant="flat">
																									<MessageLabel>System</MessageLabel>
																									<div class="max-h-12 overflow-hidden whitespace-pre-wrap text-[11px] text-muted-foreground">{(turn.content || '').slice(0, 200)}{(turn.content || '').length > 200 ? '...' : ''}</div>
																								</MessageContent>
																							</Message>
																						{:else if turn.type === 'prompt'}
																							<Message from="user">
																								<MessageContent>
																									<MessageLabel>User &middot; {formatTime(turn.timestamp)}</MessageLabel>
																									<div class="max-h-20 overflow-hidden whitespace-pre-wrap text-[11px]">{(turn.content || '').slice(0, 400)}{(turn.content || '').length > 400 ? '...' : ''}</div>
																								</MessageContent>
																							</Message>
																						{:else if turn.type === 'tool_turn'}
																							<Message from="assistant">
																								<MessageContent variant="flat">
																									{#each turn.toolCalls || [] as tc, tcIdx}
																										{@const result = turn.toolResults?.find((r) => r.callId === tc.id) || turn.toolResults?.[tcIdx]}
																										<ToolCall
																											name={tc.name}
																											state={result ? (result.result.success === false ? 'error' : 'completed') : 'running'}
																										>
																											<!-- Input -->
																											<div class="space-y-1 border-t border-border/30 p-2">
																												{#if tc.args.description}
																													<div class="text-[10px] text-muted-foreground">{tc.args.description}</div>
																												{/if}
																												{#if tc.args.command}
																													<pre class="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted/50 px-2 py-1.5 font-mono text-[10px]">{String(tc.args.command).slice(0, 500)}{String(tc.args.command).length > 500 ? '...' : ''}</pre>
																												{:else if Object.keys(tc.args).length > 0}
																													<pre class="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted/50 px-2 py-1.5 font-mono text-[10px]">{JSON.stringify(tc.args, null, 2).slice(0, 400)}</pre>
																												{/if}

																												<!-- Output -->
																												{#if result}
																													<div class="mt-1 rounded border p-1.5 {result.result.success === false ? 'border-red-500/20 bg-red-500/5' : 'border-border/20 bg-muted/20'}">
																														<div class="mb-1 flex items-center gap-2">
																															<Badge variant={result.result.success === false ? 'destructive' : 'secondary'} class="text-[10px]">
																																{result.result.success === false ? `exit ${result.result.exitCode}` : 'success'}
																															</Badge>
																															{#if result.result.sandbox?.name}
																																<span class="font-mono text-[9px] text-muted-foreground">{result.result.sandbox.name}</span>
																															{/if}
																														</div>
																														{#if result.result.stdout}
																															<pre class="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/30 px-2 py-1 font-mono text-[10px]">{result.result.stdout.slice(0, 600)}{result.result.stdout.length > 600 ? '...' : ''}</pre>
																														{/if}
																														{#if result.result.stderr}
																															<pre class="mt-1 max-h-10 overflow-auto whitespace-pre-wrap break-all rounded bg-red-500/10 px-2 py-1 font-mono text-[10px] text-red-400">{result.result.stderr.slice(0, 200)}</pre>
																														{/if}
																														{#if result.result.files?.length}
																															<div class="mt-1 flex flex-wrap gap-1">
																																{#each result.result.files as f}
																																	<Badge variant="outline" class="text-[9px]">{f.status === 'A' ? '+' : f.status === 'D' ? '-' : '~'} {f.path}</Badge>
																																{/each}
																															</div>
																														{/if}
																														{#if result.result.raw}
																															<div class="mt-1 max-h-16 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">{result.result.raw}</div>
																														{/if}
																													</div>
																												{/if}
																											</div>
																										</ToolCall>
																									{/each}
																								</MessageContent>
																							</Message>
																						{:else if turn.type === 'response'}
																							<Message from="assistant">
																								<MessageContent>
																									<MessageLabel>Assistant &middot; {formatTime(turn.timestamp)}</MessageLabel>
																									<div class="whitespace-pre-wrap text-[11px]">{turn.responseText}</div>
																								</MessageContent>
																							</Message>
																						{/if}
																					{/each}
																				</div>
																				{:else if agentDetailTab === 'json'}
																					<JsonViewer data={inst} label="Agent State" />
																				{/if}
																			</div>
																	</td>
																</tr>
															{/if}
													{/each}
												</tbody>
											</table>
											{#if entries.length > 15}
												<div class="border-t border-border/50 px-3 py-2 text-center text-xs text-muted-foreground">
													Showing 15 of {entries.length} instances
												</div>
											{/if}
										</div>

										<!-- Full agent state JSON -->
										<div class="mt-3">
											<JsonViewer data={agentStateResult} label="Full Agent State JSON" collapsed={true} />
										</div>
									{:else}
										<p class="text-sm text-muted-foreground">
											No state found for this agent.
										</p>
									{/if}
								</CardContent>
							{/if}
						</Card>
					{/each}
					{:else}
						<div class="flex flex-col items-center justify-center py-16 text-center">
							<Bot class="mb-4 h-12 w-12 text-muted-foreground/50" />
							<p class="text-sm text-muted-foreground">
								No Dapr agent definitions found.
							</p>
						</div>
					{/if}
			</TabsContent>

			<!-- ==================== PUB/SUB TAB ==================== -->
			<TabsContent value="pubsub" class="space-y-4">
				<!-- Pub/Sub Components -->
				<Card>
					<CardHeader>
						<CardTitle class="text-sm">Pub/Sub Components</CardTitle>
					</CardHeader>
					<CardContent>
						{#if pubsubComponents.length > 0}
							<div class="rounded-md border border-border">
								<Table>
									<TableHeader>
										<TableRow
											class="border-b border-border bg-muted/50 text-xs font-medium uppercase tracking-wider text-muted-foreground"
										>
											<TableHead class="px-4 py-2">Name</TableHead>
											<TableHead class="px-4 py-2">Type</TableHead>
											<TableHead class="px-4 py-2">Version</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{#each pubsubComponents as comp}
											<TableRow class="border-b border-border last:border-b-0">
												<TableCell class="px-4 py-2 font-mono text-sm">{comp.name}</TableCell>
												<TableCell class="px-4 py-2">
													<Badge variant="outline" class="text-xs">{comp.type}</Badge>
												</TableCell>
												<TableCell class="px-4 py-2 text-sm text-muted-foreground"
													>{comp.version}</TableCell
												>
											</TableRow>
										{/each}
									</TableBody>
								</Table>
							</div>
						{:else}
							<p class="text-sm text-muted-foreground">
								No pub/sub components found in sidecar metadata.
							</p>
						{/if}
					</CardContent>
				</Card>

				<!-- Subscriptions -->
				<Card>
					<CardHeader>
						<CardTitle class="text-sm">Active Subscriptions</CardTitle>
					</CardHeader>
					<CardContent>
						{#if metadata.current?.metadata?.subscriptions?.length}
							<div class="rounded-md border border-border">
								<Table>
									<TableHeader>
										<TableRow
											class="border-b border-border bg-muted/50 text-xs font-medium uppercase tracking-wider text-muted-foreground"
										>
											<TableHead class="px-4 py-2">PubSub</TableHead>
											<TableHead class="px-4 py-2">Topic</TableHead>
											<TableHead class="px-4 py-2">Route</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{#each metadata.current.metadata.subscriptions as sub}
											<TableRow class="border-b border-border last:border-b-0">
												<TableCell class="px-4 py-2 font-mono text-sm"
													>{sub.pubsubname}</TableCell
												>
												<TableCell class="px-4 py-2 font-mono text-sm">{sub.topic}</TableCell>
												<TableCell class="px-4 py-2 font-mono text-xs text-muted-foreground">
													{sub.route || sub.routes?.default || (sub.routes?.rules?.length ? sub.routes.rules.map((r: { path: string }) => r.path).join(', ') : '(programmatic)')}
												</TableCell>
											</TableRow>
										{/each}
									</TableBody>
								</Table>
							</div>
						{:else}
							<p class="text-sm text-muted-foreground">
								No active subscriptions found in sidecar metadata.
							</p>
						{/if}
					</CardContent>
				</Card>

				<!-- Live Event Stream -->
				<Card>
					<CardHeader>
						<div class="flex items-center justify-between">
							<CardTitle class="text-sm">Live Event Stream</CardTitle>
							<div class="flex items-center gap-2">
								{#if streamConnected}
									<div class="flex items-center gap-1.5 text-xs text-green-500">
										<div class="h-2 w-2 animate-pulse rounded-full bg-green-500"></div>
										Connected
									</div>
								{/if}
								<Badge variant="outline" class="text-xs">{liveEvents.length} events</Badge>
								{#if !streamConnected}
									<Button variant="default" size="sm" class="h-6 text-[10px]" onclick={startEventStream}>
										Start Streaming
									</Button>
								{:else}
									<Button variant="outline" size="sm" class="h-6 text-[10px]" onclick={stopEventStream}>
										Stop
									</Button>
								{/if}
								{#if liveEvents.length > 0}
									<Button variant="outline" size="sm" class="h-6 text-[10px]" onclick={() => liveEvents = []}>
										Clear
									</Button>
								{/if}
							</div>
						</div>
					</CardHeader>
					<CardContent>
						{#if liveEvents.length > 0}
							<div class="rounded border border-border/30">
								<table class="w-full text-xs">
									<thead>
										<tr class="border-b border-border/50 bg-muted/30 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
											<th class="px-3 py-1.5 font-medium">Time</th>
											<th class="px-3 py-1.5 font-medium">Topic</th>
											<th class="px-3 py-1.5 font-medium">Type</th>
											<th class="px-3 py-1.5 font-medium">Preview</th>
										</tr>
									</thead>
									<tbody>
										{#each [...liveEvents].reverse().slice(0, 50) as evt (evt.id)}
											<tr class="border-b border-border/30 last:border-b-0">
												<td class="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{formatTime(evt.timestamp)}</td>
												<td class="px-3 py-1.5"><Badge variant="outline" class="text-[10px]">{evt.topic}</Badge></td>
												<td class="px-3 py-1.5 font-mono">{evt.type}</td>
												<td class="max-w-xs truncate px-3 py-1.5 text-muted-foreground">
													{JSON.stringify(evt.data).slice(0, 80)}{JSON.stringify(evt.data).length > 80 ? '...' : ''}
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{:else if !streamConnected}
							<p class="text-sm text-muted-foreground">
								Click "Start Streaming" to receive live pub/sub events from Dapr topics
								(workflow.stream, workflow-state-events, task-team-broadcast).
							</p>
						{:else}
							<p class="text-sm text-muted-foreground">
								Listening for events... Events will appear here as they flow through the system.
							</p>
						{/if}
					</CardContent>
				</Card>
			</TabsContent>
		</Tabs>
	</div>
</div>
