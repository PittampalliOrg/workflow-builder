<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Textarea } from '$lib/components/ui/textarea';
	import AgentGraphEditor from './agent-graph-editor.svelte';
	import {
		getAgentTaskBody,
		normalizeAgentTaskConfig,
		sanitizeAgentName,
		summarizeAgentGraph
	} from '$lib/types/agent-graph';

	interface Props {
		data: Record<string, unknown>;
		onUpdate: (key: string, value: unknown) => void;
	}

	let { data, onUpdate }: Props = $props();

	let showGraphEditor = $state(false);

	let taskConfig = $derived(
		normalizeAgentTaskConfig(
			(data.taskConfig as Record<string, unknown> | undefined) || {},
			typeof data.label === 'string' ? data.label : 'Agent'
		)
	);
	let body = $derived(getAgentTaskBody(taskConfig));
	let agentConfig = $derived((body.agentConfig as Record<string, unknown>) || {});
	let memoryConfig = $derived(
		((agentConfig.memory as Record<string, unknown> | undefined) || {}) as Record<string, unknown>
	);
	let loopConfig = $derived(
		((agentConfig.loop as Record<string, unknown> | undefined) || {}) as Record<string, unknown>
	);
	let hotReloadConfig = $derived(
		((agentConfig.configuration as Record<string, unknown> | undefined) || {}) as Record<
			string,
			unknown
		>
	);

	function updateBody(updates: Record<string, unknown>) {
		const next = normalizeAgentTaskConfig(
			{
				...taskConfig,
				with: {
					...((taskConfig.with as Record<string, unknown>) || {}),
					body: {
						...body,
						...updates
					}
				}
			},
			typeof data.label === 'string' ? data.label : 'Agent'
		);
		onUpdate('taskConfig', next);
	}

	function updateAgentConfig(updates: Record<string, unknown>) {
		updateBody({
			agentConfig: {
				...agentConfig,
				...updates
			}
		});
	}

	function updateHotReload(updates: Record<string, unknown>) {
		updateAgentConfig({
			configuration: {
				...hotReloadConfig,
				...updates
			}
		});
	}

	function updateCommaSeparatedArray(key: 'tools') {
		return (value: string) => {
			const items = value
				.split(',')
				.map((item) => item.trim())
				.filter(Boolean);
			updateAgentConfig({ [key]: items });
		};
	}
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<div>
			<p class="text-xs font-medium">Durable Agent</p>
			<p class="text-[11px] text-muted-foreground">
				Compiled as `durable/run` and executed by the selected OpenShell-backed durable runtime.
			</p>
		</div>
		<Badge variant="outline">{summarizeAgentGraph(body.agentGraph)}</Badge>
	</div>

	<div class="space-y-1.5">
		<Label for="agent-prompt">Prompt</Label>
		<Textarea
			id="agent-prompt"
			rows={4}
			value={body.prompt}
			oninput={(event) => updateBody({ prompt: event.currentTarget.value })}
			placeholder="Describe the durable agent task."
		/>
	</div>

	<div class="space-y-1.5">
		<Label for="agent-instructions">System Instructions</Label>
		<Textarea
			id="agent-instructions"
			rows={4}
			value={typeof agentConfig.instructions === 'string' ? agentConfig.instructions : ''}
			oninput={(event) => updateAgentConfig({ instructions: event.currentTarget.value })}
			placeholder="Optional single-loop instructions for this agent profile."
		/>
	</div>

	<div class="grid grid-cols-2 gap-3">
		<div class="space-y-1.5">
			<Label for="agent-runtime">Runtime</Label>
			<NativeSelect
				id="agent-runtime"
				class="w-full"
				value={body.agentRuntime}
				onchange={(event) =>
					updateBody({
						agentRuntime: event.currentTarget.value
					})}
			>
				<option value="durable-agent">Dapr Durable Agent</option>
				<option value="claude-code-agent">Claude Code Agent</option>
			</NativeSelect>
		</div>
		<div class="space-y-1.5">
			<Label for="agent-name">Agent Name</Label>
			<Input
				id="agent-name"
				value={
					typeof agentConfig.name === 'string'
						? agentConfig.name
						: sanitizeAgentName(typeof data.label === 'string' ? data.label : 'Agent')
				}
				oninput={(event) => updateAgentConfig({ name: event.currentTarget.value })}
			/>
		</div>
		<div class="space-y-1.5">
			<Label>Execution</Label>
			<div class="flex h-10 items-center rounded-md border px-3 text-sm text-muted-foreground">
				Single Loop
			</div>
		</div>
		<div class="space-y-1.5">
			<Label for="agent-model-spec">Model Spec</Label>
			<Input
				id="agent-model-spec"
				value={typeof agentConfig.modelSpec === 'string' ? agentConfig.modelSpec : ''}
				oninput={(event) => updateAgentConfig({ modelSpec: event.currentTarget.value })}
				placeholder="openai/gpt-5.4"
			/>
		</div>
		<div class="space-y-1.5">
			<Label for="agent-tools">Tools</Label>
			<Input
				id="agent-tools"
				value={Array.isArray(agentConfig.tools) ? agentConfig.tools.join(', ') : ''}
				oninput={(event) => updateCommaSeparatedArray('tools')(event.currentTarget.value)}
				placeholder="search_code, read_file, write_file"
			/>
		</div>
		<div class="space-y-1.5">
			<Label for="agent-loop-strategy">Loop Strategy</Label>
			<NativeSelect
				id="agent-loop-strategy"
				class="w-full"
				value={typeof loopConfig.strategy === 'string' ? loopConfig.strategy : 'graph_v1'}
				onchange={(event) =>
					updateAgentConfig({
						loop: {
							...loopConfig,
							strategy: event.currentTarget.value
						}
					})}
			>
				<option value="graph_v1">Single Loop</option>
				<option value="default">Runtime Default</option>
			</NativeSelect>
		</div>
		<div class="space-y-1.5">
			<Label for="agent-memory-backend">Memory Backend</Label>
			<NativeSelect
				id="agent-memory-backend"
				class="w-full"
				value={typeof memoryConfig.backend === 'string' ? memoryConfig.backend : 'dapr_state'}
				onchange={(event) =>
					updateAgentConfig({
						memory: {
							...memoryConfig,
							backend: event.currentTarget.value
						}
					})}
			>
				<option value="dapr_state">Dapr State</option>
				<option value="conversation_list">Conversation List</option>
			</NativeSelect>
		</div>
		<div class="space-y-1.5">
			<Label for="agent-max-turns">Max Turns</Label>
			<Input
				id="agent-max-turns"
				type="number"
				value={String(body.maxTurns ?? 12)}
				oninput={(event) =>
					updateBody({ maxTurns: Number.parseInt(event.currentTarget.value, 10) || 12 })}
			/>
		</div>
		<div class="space-y-1.5">
			<Label for="agent-timeout">Timeout Minutes</Label>
			<Input
				id="agent-timeout"
				type="number"
				value={String(body.timeoutMinutes ?? 30)}
				oninput={(event) =>
					updateBody({
						timeoutMinutes: Number.parseInt(event.currentTarget.value, 10) || 30
					})}
			/>
		</div>
	</div>

	<div class="grid grid-cols-2 gap-3">
		<div class="space-y-1.5">
			<Label for="agent-memory-session">Memory Session</Label>
			<Input
				id="agent-memory-session"
				value={typeof memoryConfig.sessionId === 'string' ? memoryConfig.sessionId : ''}
				oninput={(event) =>
					updateAgentConfig({
						memory: {
							...memoryConfig,
							sessionId: event.currentTarget.value
						}
					})}
				placeholder="optional-shared-session"
			/>
		</div>
		<div class="space-y-1.5">
			<Label for="agent-memory-store">Memory Store</Label>
			<Input
				id="agent-memory-store"
				value={typeof memoryConfig.storeName === 'string' ? memoryConfig.storeName : ''}
				oninput={(event) =>
					updateAgentConfig({
						memory: {
							...memoryConfig,
							storeName: event.currentTarget.value
						}
					})}
				placeholder="statestore"
			/>
		</div>
	</div>

	<div class="rounded-md border p-3 space-y-3">
		<div class="flex items-center justify-between gap-3">
			<div>
				<p class="text-xs font-medium">Agent Loop Graph</p>
				<p class="text-[11px] text-muted-foreground">
					Edit the constrained single-loop graph that drives the durable agent runtime.
				</p>
			</div>
			<Button variant="outline" onclick={() => (showGraphEditor = true)}>Edit Loop</Button>
		</div>
		<div class="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
			<Badge variant="secondary">{summarizeAgentGraph(body.agentGraph)}</Badge>
			<span>The graph stays revisioned with the workflow definition.</span>
		</div>
	</div>

	<div class="rounded-md border p-3 space-y-3">
		<div class="flex items-center justify-between">
			<div>
				<p class="text-xs font-medium">Runtime Config Hot Reload</p>
				<p class="text-[11px] text-muted-foreground">
					For prompt/model/tool overrides only. The single-loop graph topology and workflow code
					still publish as revisions.
				</p>
			</div>
		</div>

		<div class="grid grid-cols-2 gap-3">
			<div class="space-y-1.5">
				<Label for="agent-config-store">Config Store</Label>
				<Input
					id="agent-config-store"
					value={typeof hotReloadConfig.storeName === 'string' ? hotReloadConfig.storeName : ''}
					oninput={(event) => updateHotReload({ storeName: event.currentTarget.value })}
					placeholder="azureappconfig-workflow-builder"
				/>
			</div>
			<div class="space-y-1.5">
				<Label for="agent-config-name">Config Name</Label>
				<Input
					id="agent-config-name"
					value={typeof hotReloadConfig.configName === 'string' ? hotReloadConfig.configName : ''}
					oninput={(event) => updateHotReload({ configName: event.currentTarget.value })}
					placeholder="my-openshell-agent"
				/>
			</div>
		</div>
		<div class="space-y-1.5">
			<Label for="agent-config-keys">Subscribed Keys</Label>
			<Input
				id="agent-config-keys"
				value={Array.isArray(hotReloadConfig.keys) ? hotReloadConfig.keys.join(', ') : ''}
				oninput={(event) =>
					updateHotReload({
						keys: event.currentTarget.value
							.split(',')
							.map((item) => item.trim())
							.filter(Boolean)
					})}
				placeholder="agents.my-agent.instructions, agents.my-agent.model"
			/>
		</div>
		<p class="text-[11px] text-muted-foreground">
			The graph config drives a single durable agent loop. Planning and approval choreography are
			intentionally out of scope for this first implementation.
		</p>
	</div>
</div>

<AgentGraphEditor
	open={showGraphEditor}
	graph={body.agentGraph}
	onClose={() => (showGraphEditor = false)}
	onSave={(graph) => {
		updateBody({ agentGraph: graph });
		showGraphEditor = false;
	}}
/>
