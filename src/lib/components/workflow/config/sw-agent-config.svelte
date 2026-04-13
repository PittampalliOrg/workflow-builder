<script lang="ts">
	import { onMount } from 'svelte';
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
	let mcpConnections = $state<McpConnection[]>([]);
	let mcpConnectionsLoading = $state(false);
	let mcpToolInventories = $state<Record<string, string[]>>({});
	let mcpToolLoadingId = $state<string | null>(null);

	type McpServerConfig = {
		server_name?: string;
		serverName?: string;
		name?: string;
		displayName?: string;
		sourceType?: string;
		pieceName?: string | null;
		connectionExternalId?: string | null;
		transport?: string;
		type?: string;
		url?: string;
		serverUrl?: string;
		command?: string;
		args?: string[];
		env?: Record<string, string>;
		cwd?: string;
		allowedTools?: string[];
		headers?: Record<string, string>;
		timeout?: number;
		sse_read_timeout?: number;
		terminate_on_close?: boolean;
	};

	type McpConnection = {
		id: string;
		displayName: string;
		sourceType: string;
		pieceName: string | null;
		serverKey?: string | null;
		connectionExternalId: string | null;
		serverUrl: string | null;
		status: string;
		metadata: Record<string, unknown> | null;
	};

	const MCP_PRESETS: McpServerConfig[] = [
		{
			server_name: 'playwright',
			displayName: 'Playwright',
			sourceType: 'preset',
			transport: 'stdio',
			command: 'npx',
			args: ['@playwright/mcp@latest']
		},
		{
			server_name: 'chrome_devtools',
			displayName: 'Chrome DevTools',
			sourceType: 'preset',
			transport: 'stdio',
			command: 'npx',
			args: ['chrome-devtools-mcp@latest']
		},
		{
			server_name: 'claude_in_chrome',
			displayName: 'Claude in Chrome',
			sourceType: 'preset',
			transport: 'stdio',
			command: 'claude',
			args: ['--claude-in-chrome-mcp']
		}
	];

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
	let mcpServers = $derived(
		(Array.isArray(agentConfig.mcpServers) ? agentConfig.mcpServers : []) as McpServerConfig[]
	);

	onMount(() => {
		void loadMcpConnections();
	});

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

	async function loadMcpConnections() {
		mcpConnectionsLoading = true;
		try {
			const response = await fetch('/api/mcp-connections');
			if (response.ok) {
				mcpConnections = await response.json();
			}
		} catch {
			mcpConnections = [];
		} finally {
			mcpConnectionsLoading = false;
		}
	}

	function normalizeMcpName(value: unknown): string {
		const normalized = String(value || '')
			.trim()
			.toLowerCase()
			.replace(/^@activepieces\/piece-/, '')
			.replace(/[^a-z0-9_-]+/g, '_')
			.replace(/_+/g, '_')
			.replace(/^_|_$/g, '');
		return normalized || 'mcp_server';
	}

	function serverKey(server: McpServerConfig): string {
		return normalizeMcpName(
			server.server_name ||
				server.serverName ||
				server.name ||
				server.pieceName ||
				server.displayName ||
				server.url ||
				server.serverUrl ||
				server.command
		);
	}

	function metadataRecord(connection: McpConnection): Record<string, unknown> {
		return connection.metadata && typeof connection.metadata === 'object' ? connection.metadata : {};
	}

	function connectionServerName(connection: McpConnection): string {
		const base = connection.pieceName || connection.serverKey || connection.displayName || connection.id;
		if (connection.sourceType === 'nimble_piece') return normalizeMcpName(`piece_${base}`);
		if (connection.sourceType === 'nimble_shared') return normalizeMcpName(`shared_${base}`);
		if (connection.sourceType === 'custom_url') return normalizeMcpName(`custom_${base}`);
		return normalizeMcpName(base);
	}

	function transportFromConnection(connection: McpConnection): string {
		const metadata = metadataRecord(connection);
		const raw = String(metadata.transport || metadata.transportType || 'streamable_http')
			.trim()
			.toLowerCase()
			.replace('-', '_');
		return raw === 'sse' || raw === 'stdio' || raw === 'websocket' ? raw : 'streamable_http';
	}

	function serverFromConnection(connection: McpConnection): McpServerConfig {
		return {
			server_name: connectionServerName(connection),
			displayName: connection.displayName,
			sourceType: connection.sourceType,
			pieceName: connection.pieceName,
			connectionExternalId: connection.connectionExternalId,
			transport: transportFromConnection(connection),
			url: connection.serverUrl || undefined
		};
	}

	function selectedServerByKey(key: string): McpServerConfig | null {
		return mcpServers.find((server) => serverKey(server) === key) || null;
	}

	function isConnectionSelected(connection: McpConnection): boolean {
		return Boolean(selectedServerByKey(connectionServerName(connection)));
	}

	function isPresetSelected(preset: McpServerConfig): boolean {
		return Boolean(selectedServerByKey(serverKey(preset)));
	}

	function setMcpServers(nextServers: McpServerConfig[]) {
		updateAgentConfig({ mcpServers: nextServers });
	}

	function upsertMcpServer(server: McpServerConfig) {
		const key = serverKey(server);
		const next = mcpServers.filter((existing) => serverKey(existing) !== key);
		setMcpServers([...next, server]);
	}

	function removeMcpServer(key: string) {
		setMcpServers(mcpServers.filter((server) => serverKey(server) !== key));
	}

	function toggleConnection(connection: McpConnection, checked: boolean) {
		const key = connectionServerName(connection);
		if (!checked) {
			removeMcpServer(key);
			return;
		}
		upsertMcpServer(serverFromConnection(connection));
	}

	function togglePreset(preset: McpServerConfig, checked: boolean) {
		if (!checked) {
			removeMcpServer(serverKey(preset));
			return;
		}
		upsertMcpServer(preset);
	}

	function updateServerAllowedTools(server: McpServerConfig, value: string) {
		const allowedTools = value
			.split(',')
			.map((item) => item.trim())
			.filter(Boolean);
		upsertMcpServer({
			...server,
			...(allowedTools.length > 0 ? { allowedTools } : { allowedTools: undefined })
		});
	}

	function toolInventory(connection: McpConnection): string[] {
		if (mcpToolInventories[connection.id]) {
			return mcpToolInventories[connection.id];
		}
		const metadata = metadataRecord(connection);
		const candidates = [metadata.toolNames, metadata.tools, metadata.allowedTools];
		for (const candidate of candidates) {
			if (Array.isArray(candidate)) {
				return candidate.map((item) => String(item).trim()).filter(Boolean);
			}
		}
		return [];
	}

	async function loadMcpTools(connection: McpConnection) {
		mcpToolLoadingId = connection.id;
		try {
			const response = await fetch(`/api/mcp-connections/${encodeURIComponent(connection.id)}/tools`);
			if (!response.ok) return;
			const payload = await response.json();
			const toolNames = Array.isArray(payload.toolNames)
				? payload.toolNames.map((item: unknown) => String(item).trim()).filter(Boolean)
				: [];
			mcpToolInventories = {
				...mcpToolInventories,
				[connection.id]: toolNames
			};
		} finally {
			mcpToolLoadingId = null;
		}
	}

	function isToolAllowed(server: McpServerConfig, toolName: string): boolean {
		return !Array.isArray(server.allowedTools) || server.allowedTools.length === 0
			? true
			: server.allowedTools.includes(toolName);
	}

	function toggleAllowedTool(server: McpServerConfig, allTools: string[], toolName: string, checked: boolean) {
		const current = Array.isArray(server.allowedTools) && server.allowedTools.length > 0
			? server.allowedTools
			: allTools;
		const next = checked
			? Array.from(new Set([...current, toolName]))
			: current.filter((item) => item !== toolName);
		upsertMcpServer({ ...server, allowedTools: next.length === allTools.length ? undefined : next });
	}
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<div>
			<p class="text-xs font-medium">Durable Agent</p>
			<p class="text-[11px] text-muted-foreground">
				Compiled as `durable/run` and executed by dapr-agent-py.
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
				<option value="dapr-agent-py">dapr-agent-py</option>
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
			<Label for="agent-workspace-ref">Workspace Ref</Label>
			<Input
				id="agent-workspace-ref"
				value={body.workspaceRef ?? ''}
				oninput={(event) => updateBody({ workspaceRef: event.currentTarget.value })}
				placeholder={'${ .workspaceProfile.workspaceRef }'}
			/>
		</div>
		<div class="space-y-1.5">
			<Label for="agent-sandbox-name">Sandbox Name</Label>
			<Input
				id="agent-sandbox-name"
				value={body.sandboxName ?? ''}
				oninput={(event) => updateBody({ sandboxName: event.currentTarget.value })}
				placeholder={'${ .workspaceProfile.sandboxName }'}
			/>
		</div>
		<div class="space-y-1.5">
			<Label for="agent-cwd">Working Directory</Label>
			<Input
				id="agent-cwd"
				value={body.cwd ?? '/sandbox'}
				oninput={(event) => updateBody({ cwd: event.currentTarget.value })}
				placeholder="/sandbox"
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
				value={String(body.maxTurns ?? 120)}
				oninput={(event) =>
					updateBody({ maxTurns: Number.parseInt(event.currentTarget.value, 10) || 120 })}
			/>
		</div>
		<div class="space-y-1.5">
			<Label for="agent-timeout">Timeout Minutes</Label>
			<Input
				id="agent-timeout"
				type="number"
				value={String(body.timeoutMinutes ?? 120)}
				oninput={(event) =>
					updateBody({
						timeoutMinutes: Number.parseInt(event.currentTarget.value, 10) || 120
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
					placeholder="my-dapr-agent"
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

	<div class="rounded-md border p-3 space-y-3">
		<div class="flex items-center justify-between gap-3">
			<div>
				<p class="text-xs font-medium">MCP Servers</p>
				<p class="text-[11px] text-muted-foreground">
					Expose project MCP connections or browser automation presets to this dapr-agent-py run.
				</p>
			</div>
			<Button variant="outline" size="sm" onclick={() => void loadMcpConnections()}>
				{#if mcpConnectionsLoading}
					Loading
				{:else}
					Refresh
				{/if}
			</Button>
		</div>

		<div class="space-y-2">
			<p class="text-[11px] font-medium text-muted-foreground">Project Connections</p>
			{#if mcpConnectionsLoading}
				<div class="text-[11px] text-muted-foreground">Loading MCP connections...</div>
			{:else if mcpConnections.length === 0}
				<div class="rounded-md border border-dashed p-3 text-[11px] text-muted-foreground">
					No project MCP connections found. Add OAuth-backed or custom servers in Settings.
				</div>
			{:else}
				<div class="space-y-2">
					{#each mcpConnections as connection (connection.id)}
						{@const selectedServer = selectedServerByKey(connectionServerName(connection))}
						{@const tools = toolInventory(connection)}
						<div class="rounded-md border p-3 space-y-2">
							<label class="flex items-start gap-2 text-xs">
								<input
									type="checkbox"
									class="mt-0.5"
									checked={Boolean(selectedServer)}
									disabled={connection.status !== 'ENABLED' && !selectedServer}
									onchange={(event) => toggleConnection(connection, event.currentTarget.checked)}
								/>
								<span class="min-w-0 flex-1">
									<span class="flex flex-wrap items-center gap-2">
										<span class="font-medium">{connection.displayName}</span>
										<Badge variant="outline">{connection.sourceType}</Badge>
										{#if connection.status !== 'ENABLED'}
											<Badge variant="secondary">{connection.status}</Badge>
										{/if}
									</span>
									{#if connection.serverUrl}
										<code class="mt-1 block truncate text-[10px] text-muted-foreground">{connection.serverUrl}</code>
									{/if}
								</span>
							</label>
							{#if selectedServer}
								<div class="space-y-2 pl-6">
									<div class="flex items-end gap-2">
										<div class="min-w-0 flex-1 space-y-1">
											<Label for={`mcp-tools-${connection.id}`}>Allowed Tools</Label>
											<Input
												id={`mcp-tools-${connection.id}`}
												value={Array.isArray(selectedServer.allowedTools) ? selectedServer.allowedTools.join(', ') : ''}
												oninput={(event) => updateServerAllowedTools(selectedServer, event.currentTarget.value)}
												placeholder="All tools, or comma-separated MCP tool names"
											/>
										</div>
										<Button
											variant="outline"
											size="sm"
											disabled={mcpToolLoadingId === connection.id}
											onclick={() => void loadMcpTools(connection)}
										>
											{mcpToolLoadingId === connection.id ? 'Loading' : 'Load Tools'}
										</Button>
									</div>
									{#if tools.length === 0 && mcpToolInventories[connection.id]}
										<div class="text-[11px] text-muted-foreground">
											No tools reported by this MCP server.
										</div>
									{/if}
									{#if tools.length > 0}
										<div class="flex flex-wrap gap-2">
											{#each tools as tool}
												<label class="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]">
													<input
														type="checkbox"
														checked={isToolAllowed(selectedServer, tool)}
														onchange={(event) => toggleAllowedTool(selectedServer, tools, tool, event.currentTarget.checked)}
													/>
													<span>{tool}</span>
												</label>
											{/each}
										</div>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<div class="space-y-2">
			<p class="text-[11px] font-medium text-muted-foreground">Browser MCP Presets</p>
			<div class="grid grid-cols-1 gap-2 md:grid-cols-3">
				{#each MCP_PRESETS as preset}
					<label class="rounded-md border p-3 text-xs">
						<span class="flex items-center gap-2">
							<input
								type="checkbox"
								checked={isPresetSelected(preset)}
								onchange={(event) => togglePreset(preset, event.currentTarget.checked)}
							/>
							<span class="font-medium">{preset.displayName}</span>
						</span>
						<code class="mt-2 block truncate text-[10px] text-muted-foreground">
							{preset.command} {(preset.args || []).join(' ')}
						</code>
					</label>
				{/each}
			</div>
			<p class="text-[11px] text-muted-foreground">
				Browser presets run as stdio MCP servers inside the agent runtime container. They require
				their CLI/browser prerequisites to be present in that runtime image or mounted environment.
			</p>
		</div>
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
