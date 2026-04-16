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
	import {
		DEFAULT_SANDBOX_TEMPLATE,
		DEFAULT_SANDBOX_TTL_SECONDS,
		LEGACY_SHARED_SANDBOX_POLICY,
		normalizeSandboxPolicy,
		type SandboxPolicy,
		type SandboxPolicyMode
	} from '$lib/workflows/sandbox-policy';

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
	let agentProfiles = $state<AgentProfile[]>([]);
	let agentProfilesLoading = $state(false);
	let agentSkills = $state<AgentSkillConfig[]>([]);
	let agentSkillsLoading = $state(false);

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

	type AgentSkillConfig = {
		id?: string;
		name: string;
		description?: string;
		whenToUse?: string;
		when_to_use?: string;
		allowedTools?: string[];
		allowed_tools?: string[];
		sourceType?: 'profile' | 'registry';
		registryId?: string;
		slug?: string;
		version?: string;
		sourceRepo?: string;
		sourceRef?: string;
		skillPath?: string;
		registryUrl?: string;
		installSource?: string;
		skillName?: string;
		installAgent?: string;
		status?: string;
	};

	type AgentRuntimeOverridePolicy = {
		allowToolNarrowing?: boolean;
		allowServerAdditions?: boolean;
		allowCredentialBinding?: boolean;
		allowSkillAdditions?: boolean;
		allowSkillNarrowing?: boolean;
	};

	type AgentProfile = {
		id: string;
		templateId: string;
		slug: string;
		name: string;
		description: string | null;
		category: string | null;
		version: number;
		source: string;
		config: {
			modelSpec?: string;
			maxTurns?: number;
			timeoutMinutes?: number;
			builtinTools?: string[];
			mcpConnectionMode?: string;
			mcpServers?: McpServerConfig[];
			skills?: AgentSkillConfig[];
			runtimeOverridePolicy?: AgentRuntimeOverridePolicy;
		};
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
	let sandboxPolicy = $derived(
		normalizeSandboxPolicy(body.sandboxPolicy, LEGACY_SHARED_SANDBOX_POLICY)
	);
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
	let skills = $derived(
		(Array.isArray(agentConfig.skills) ? agentConfig.skills : []) as AgentSkillConfig[]
	);
	let mcpConnectionMode = $derived(
		typeof agentConfig.mcpConnectionMode === 'string' ? agentConfig.mcpConnectionMode : 'explicit'
	);
	let selectedProfileSlug = $derived(
		((agentConfig.profileRef as Record<string, unknown> | undefined)?.slug as string | undefined) || ''
	);
	let selectedProfile = $derived(
		agentProfiles.find((profile) => profile.slug === selectedProfileSlug) || null
	);
	let activeRuntimePolicy = $derived(
		((agentConfig.runtimeOverridePolicy as AgentRuntimeOverridePolicy | undefined) ||
			selectedProfile?.config.runtimeOverridePolicy ||
			{}) as AgentRuntimeOverridePolicy
	);
	let availableRegistrySkills = $derived.by(() => registrySkillsAvailable());

	onMount(() => {
		void loadMcpConnections();
		void loadAgentProfiles();
		void loadAgentSkills();
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

	function updateSandboxPolicy(updates: Partial<SandboxPolicy>) {
		const next = normalizeSandboxPolicy(
			{
				...sandboxPolicy,
				...updates
			},
			LEGACY_SHARED_SANDBOX_POLICY
		);
		const bodyUpdates: Record<string, unknown> = { sandboxPolicy: next };
		if (next.mode === 'provided') {
			bodyUpdates.workspaceRef = next.workspaceRef ?? body.workspaceRef ?? '';
		} else {
			bodyUpdates.workspaceRef = '';
			bodyUpdates.sandboxName = '';
		}
		updateBody(bodyUpdates);
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

	async function loadAgentProfiles() {
		agentProfilesLoading = true;
		try {
			const response = await fetch('/api/agent-profiles');
			if (response.ok) {
				const payload = await response.json();
				agentProfiles = Array.isArray(payload.profiles) ? payload.profiles : [];
			}
		} catch {
			agentProfiles = [];
		} finally {
			agentProfilesLoading = false;
		}
	}

	async function loadAgentSkills() {
		agentSkillsLoading = true;
		try {
			const response = await fetch('/api/agent-skills');
			if (response.ok) {
				const payload = await response.json();
				agentSkills = Array.isArray(payload.skills) ? payload.skills : [];
			}
		} catch {
			agentSkills = [];
		} finally {
			agentSkillsLoading = false;
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

	function serverAliasKeys(server: McpServerConfig): Set<string> {
		const aliases = new Set<string>([serverKey(server)]);
		for (const candidate of [
			server.server_name,
			server.serverName,
			server.name,
			server.pieceName,
			server.displayName,
			server.url,
			server.serverUrl,
			server.command
		]) {
			if (candidate) aliases.add(normalizeMcpName(candidate));
		}
		if (server.sourceType === 'nimble_piece' && server.pieceName) {
			aliases.add(normalizeMcpName(`piece_${server.pieceName}`));
		}
		if (server.sourceType === 'nimble_shared' && server.pieceName) {
			aliases.add(normalizeMcpName(`shared_${server.pieceName}`));
		}
		if (server.sourceType === 'custom_url' && (server.url || server.serverUrl)) {
			aliases.add(normalizeMcpName(`custom_${server.url || server.serverUrl}`));
		}
		return aliases;
	}

	function connectionAliasKeys(connection: McpConnection): Set<string> {
		const aliases = new Set<string>([connectionServerName(connection)]);
		for (const candidate of [
			connection.pieceName,
			connection.serverKey,
			connection.displayName,
			connection.serverUrl,
			connection.id
		]) {
			if (candidate) aliases.add(normalizeMcpName(candidate));
		}
		if (connection.sourceType === 'nimble_piece' && connection.pieceName) {
			aliases.add(normalizeMcpName(`piece_${connection.pieceName}`));
		}
		if (connection.sourceType === 'nimble_shared' && connection.pieceName) {
			aliases.add(normalizeMcpName(`shared_${connection.pieceName}`));
		}
		if (connection.sourceType === 'custom_url' && connection.serverUrl) {
			aliases.add(normalizeMcpName(`custom_${connection.serverUrl}`));
		}
		return aliases;
	}

	function serverMatchesConnection(server: McpServerConfig, connection: McpConnection): boolean {
		if (
			server.connectionExternalId &&
			connection.connectionExternalId &&
			server.connectionExternalId === connection.connectionExternalId
		) {
			return true;
		}
		if ((server.url || server.serverUrl) && connection.serverUrl) {
			if ((server.url || server.serverUrl) === connection.serverUrl) return true;
		}
		const connectionAliases = connectionAliasKeys(connection);
		for (const alias of serverAliasKeys(server)) {
			if (connectionAliases.has(alias)) return true;
		}
		return false;
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

	function selectedServerForConnection(connection: McpConnection): McpServerConfig | null {
		return mcpServers.find((server) => serverMatchesConnection(server, connection)) || null;
	}

	function profileServerKeys(profile: AgentProfile | null): Set<string> {
		return new Set((profile?.config.mcpServers || []).map((server) => serverKey(server)));
	}

	function canAddServer(server: McpServerConfig): boolean {
		if (!selectedProfile) return true;
		if (activeRuntimePolicy.allowServerAdditions === true) return true;
		if (selectedServerByKey(serverKey(server))) return true;
		return profileServerKeys(selectedProfile).has(serverKey(server));
	}

	function isConnectionSelected(connection: McpConnection): boolean {
		return Boolean(selectedServerForConnection(connection));
	}

	function isPresetSelected(preset: McpServerConfig): boolean {
		return Boolean(selectedServerByKey(serverKey(preset)));
	}

	function setMcpServers(nextServers: McpServerConfig[]) {
		updateAgentConfig({ mcpServers: nextServers });
	}

	function upsertMcpServer(server: McpServerConfig) {
		const key = serverKey(server);
		const next = mcpServers.filter((existing) => {
			if (
				existing.connectionExternalId &&
				server.connectionExternalId &&
				existing.connectionExternalId === server.connectionExternalId
			) {
				return false;
			}
			return serverKey(existing) !== key;
		});
		setMcpServers([...next, server]);
	}

	function removeMcpServer(key: string) {
		setMcpServers(mcpServers.filter((server) => serverKey(server) !== key));
	}

	function removeConnectionServer(connection: McpConnection) {
		setMcpServers(mcpServers.filter((server) => !serverMatchesConnection(server, connection)));
	}

	function toggleConnection(connection: McpConnection, checked: boolean) {
		if (!checked) {
			removeConnectionServer(connection);
			return;
		}
		const server = serverFromConnection(connection);
		if (!canAddServer(server)) return;
		upsertMcpServer(server);
	}

	function togglePreset(preset: McpServerConfig, checked: boolean) {
		if (!checked) {
			removeMcpServer(serverKey(preset));
			return;
		}
		if (!canAddServer(preset)) return;
		upsertMcpServer(preset);
	}

	function applyProfile(profileSlug: string) {
		const profile = agentProfiles.find((item) => item.slug === profileSlug);
		if (!profile) {
			updateAgentConfig({
				profileRef: undefined,
				profileSnapshot: undefined
			});
			return;
		}
		const profileConfig = profile.config || {};
		const runtimeOverridePolicy = profileConfig.runtimeOverridePolicy || {
			allowToolNarrowing: true,
			allowServerAdditions: false,
			allowCredentialBinding: true,
			allowSkillAdditions: false,
			allowSkillNarrowing: true
		};
		updateBody({
			...(typeof profileConfig.maxTurns === 'number' ? { maxTurns: profileConfig.maxTurns } : {}),
			...(typeof profileConfig.timeoutMinutes === 'number'
				? { timeoutMinutes: profileConfig.timeoutMinutes }
				: {}),
			agentConfig: {
				...agentConfig,
				profileRef: {
					templateId: profile.templateId,
					templateVersion: profile.version,
					slug: profile.slug,
					source: profile.source
				},
				profileSnapshot: {
					mcpServers: profileConfig.mcpServers || [],
					skills: profileConfig.skills || [],
					runtimeOverridePolicy
				},
				runtimeOverridePolicy,
				...(profileConfig.modelSpec ? { modelSpec: profileConfig.modelSpec } : {}),
				...(Array.isArray(profileConfig.builtinTools) ? { tools: profileConfig.builtinTools } : {}),
				mcpConnectionMode: profileConfig.mcpConnectionMode || 'explicit',
				mcpServers: profileConfig.mcpServers || [],
				skills: profileConfig.skills || []
			}
		});
	}

	function normalizeSkillName(value: unknown): string {
		return String(value || '')
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '');
	}

	function skillKey(skill: AgentSkillConfig): string {
		return normalizeSkillName(skill.slug || skill.name);
	}

	function profileSkillKeys(profile: AgentProfile | null): Set<string> {
		return new Set((profile?.config.skills || []).map((skill) => skillKey(skill)));
	}

	function isProfileSkill(skill: AgentSkillConfig): boolean {
		return skill.sourceType === 'profile' || profileSkillKeys(selectedProfile).has(skillKey(skill));
	}

	function selectedSkillByKey(key: string): AgentSkillConfig | null {
		return skills.find((skill) => skillKey(skill) === key) || null;
	}

	function canAddSkill(skill: AgentSkillConfig): boolean {
		if (!selectedProfile) return true;
		if (activeRuntimePolicy.allowSkillAdditions === true) return true;
		if (selectedSkillByKey(skillKey(skill))) return true;
		return profileSkillKeys(selectedProfile).has(skillKey(skill));
	}

	function registrySkillsAvailable(): AgentSkillConfig[] {
		return agentSkills.filter((skill) => {
			const key = skillKey(skill);
			if (!key || selectedSkillByKey(key)) return false;
			return canAddSkill(skill);
		});
	}

	function addRegistrySkill(skill: AgentSkillConfig) {
		upsertSkill({
			...skill,
			sourceType: selectedProfile && profileSkillKeys(selectedProfile).has(skillKey(skill)) ? 'profile' : 'registry',
			registryId: skill.registryId || (typeof skill.id === 'string' ? skill.id : undefined),
			slug: skill.slug || skill.name,
			installSource: skill.installSource || skill.sourceRepo || '',
			skillName: skill.skillName || skill.name,
			installAgent: skill.installAgent || 'universal'
		} as AgentSkillConfig);
	}

	function canRemoveSkill(skill: AgentSkillConfig): boolean {
		if (!isProfileSkill(skill)) return true;
		return activeRuntimePolicy.allowSkillNarrowing !== false;
	}

	function setSkills(nextSkills: AgentSkillConfig[]) {
		updateAgentConfig({ skills: nextSkills });
	}

	function upsertSkill(skill: AgentSkillConfig) {
		const key = skillKey(skill);
		if (!key || !canAddSkill(skill)) return;
		const next = skills.filter((existing) => skillKey(existing) !== key);
		setSkills([...next, skill]);
	}

	function removeSkill(skill: AgentSkillConfig) {
		if (!canRemoveSkill(skill)) return;
		setSkills(skills.filter((existing) => skillKey(existing) !== skillKey(skill)));
	}

	function restoreProfileSkill(skill: AgentSkillConfig) {
		upsertSkill({ ...skill, sourceType: 'profile' });
	}

	function updateSkill(skill: AgentSkillConfig, updates: Partial<AgentSkillConfig>) {
		const nextSkill = {
			...skill,
			...updates
		};
		const nextKey = skillKey(nextSkill);
		if (!nextKey || !canAddSkill(nextSkill)) return;
		const originalKey = skillKey(skill);
		const next = skills.filter((existing) => {
			const existingKey = skillKey(existing);
			return existingKey !== originalKey && existingKey !== nextKey;
		});
		setSkills([...next, nextSkill]);
	}

	function csvItems(value: string): string[] {
		return value
			.split(',')
			.map((item) => item.trim())
			.filter(Boolean);
	}

	function updateSkillAllowedTools(skill: AgentSkillConfig, value: string) {
		const allowedTools = csvItems(value);
		updateSkill(skill, { allowedTools });
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

	function toolNameFromUnknown(value: unknown): string | null {
		if (typeof value === 'string') {
			const trimmed = value.trim();
			return trimmed || null;
		}
		if (value && typeof value === 'object') {
			const record = value as Record<string, unknown>;
			for (const key of ['name', 'toolName', 'id', 'title']) {
				const candidate = record[key];
				if (typeof candidate === 'string' && candidate.trim()) {
					return candidate.trim();
				}
			}
		}
		return null;
	}

	function normalizeToolNames(value: unknown): string[] {
		if (!Array.isArray(value)) return [];
		const names = value.map(toolNameFromUnknown).filter((item): item is string => Boolean(item));
		return Array.from(new Set(names));
	}

	function toolInventory(connection: McpConnection): string[] {
		if (mcpToolInventories[connection.id]) {
			return mcpToolInventories[connection.id];
		}
		const metadata = metadataRecord(connection);
		const candidates = [metadata.toolNames, metadata.tools, metadata.allowedTools];
		for (const candidate of candidates) {
			if (Array.isArray(candidate)) {
				return normalizeToolNames(candidate);
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
			const toolNames = normalizeToolNames(payload.toolNames || payload.tools);
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

	<div class="rounded-md border p-3 space-y-3">
		<div class="flex items-center justify-between gap-3">
			<div>
				<p class="text-xs font-medium">Agent Profile</p>
				<p class="text-[11px] text-muted-foreground">
					Global profiles are the source of truth for MCP servers, skills, and default tool access.
				</p>
			</div>
			<Button variant="outline" size="sm" onclick={() => void loadAgentProfiles()}>
				{agentProfilesLoading ? 'Loading' : 'Refresh'}
			</Button>
		</div>
		<div class="space-y-1.5">
			<Label for="agent-profile">Profile</Label>
			<NativeSelect
				id="agent-profile"
				class="w-full"
				value={selectedProfileSlug}
				onchange={(event) => applyProfile(event.currentTarget.value)}
			>
				<option value="">Custom inline profile</option>
				{#each agentProfiles as profile (profile.id)}
					<option value={profile.slug}>{profile.name}</option>
				{/each}
			</NativeSelect>
		</div>
		{#if selectedProfile}
			<div class="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
				<Badge variant="secondary">{selectedProfile.category || 'agent'}</Badge>
				<Badge variant="outline">v{selectedProfile.version}</Badge>
				<span>{selectedProfile.description}</span>
			</div>
			{#if activeRuntimePolicy.allowServerAdditions !== true}
				<p class="text-[11px] text-muted-foreground">
					This profile allows tool narrowing, but new MCP servers must be added through the
					global profile definition.
				</p>
			{/if}
		{:else if agentProfiles.length === 0 && !agentProfilesLoading}
			<p class="text-[11px] text-muted-foreground">
				No global profiles were returned. The node can still run with inline configuration.
			</p>
		{/if}
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
				<option value="dapr-agent-py-testing">dapr-agent-py-testing (browser MCP)</option>
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

	<div class="space-y-3 rounded-md border p-3">
		<div class="flex items-center justify-between gap-3">
			<div>
				<p class="text-xs font-medium">Sandbox</p>
				<p class="text-[11px] text-muted-foreground">
					Controls how this agent receives an OpenShell workspace.
				</p>
			</div>
			<Badge variant="outline">{sandboxPolicy.mode}</Badge>
		</div>

		<div class="grid grid-cols-2 gap-3">
			<div class="space-y-1.5">
				<Label for="agent-sandbox-mode">Mode</Label>
				<NativeSelect
					id="agent-sandbox-mode"
					class="w-full"
					value={sandboxPolicy.mode}
					onchange={(event) =>
						updateSandboxPolicy({ mode: event.currentTarget.value as SandboxPolicyMode })}
				>
					<option value="per-run">New sandbox per run</option>
					<option value="per-node">New sandbox per node</option>
					<option value="provided">Existing workspace</option>
					<option value="shared-runtime">Shared runtime</option>
				</NativeSelect>
			</div>
			<div class="space-y-1.5">
				<Label for="agent-sandbox-template">Template</Label>
				<NativeSelect
					id="agent-sandbox-template"
					class="w-full"
					value={sandboxPolicy.template || DEFAULT_SANDBOX_TEMPLATE}
					disabled={sandboxPolicy.mode === 'shared-runtime' || sandboxPolicy.mode === 'provided'}
					onchange={(event) => updateSandboxPolicy({ template: event.currentTarget.value })}
				>
					<option value="dapr-agent">dapr-agent</option>
					<option value="dapr-agent-xlsx">dapr-agent-xlsx (xlsx)</option>
					<option value="openshell-browser">openshell-browser</option>
					<option value="dapr-agent-py-testing">dapr-agent-py-testing</option>
				</NativeSelect>
			</div>

			{#if sandboxPolicy.mode === 'provided'}
				<div class="col-span-2 space-y-1.5">
					<Label for="agent-workspace-ref">Workspace Ref</Label>
					<Input
						id="agent-workspace-ref"
						value={sandboxPolicy.workspaceRef ?? body.workspaceRef ?? ''}
						oninput={(event) =>
							updateSandboxPolicy({
								workspaceRef: event.currentTarget.value
							})}
						placeholder="ws_existing_workspace"
					/>
				</div>
			{/if}

			{#if sandboxPolicy.mode === 'per-run' || sandboxPolicy.mode === 'per-node'}
				<label class="col-span-2 flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						class="h-4 w-4 rounded border"
						checked={sandboxPolicy.keepAfterRun}
						onchange={(event) =>
							updateSandboxPolicy({
								keepAfterRun: event.currentTarget.checked,
								ttlSeconds: sandboxPolicy.ttlSeconds ?? DEFAULT_SANDBOX_TTL_SECONDS
							})}
					/>
					<span>Keep sandbox after run</span>
				</label>

				{#if sandboxPolicy.keepAfterRun}
					<div class="col-span-2 space-y-1.5">
						<Label for="agent-sandbox-ttl">TTL Seconds</Label>
						<Input
							id="agent-sandbox-ttl"
							type="number"
							min="60"
							value={String(sandboxPolicy.ttlSeconds ?? DEFAULT_SANDBOX_TTL_SECONDS)}
							oninput={(event) =>
								updateSandboxPolicy({
									ttlSeconds:
										Number.parseInt(event.currentTarget.value, 10) ||
										DEFAULT_SANDBOX_TTL_SECONDS
								})}
						/>
					</div>
				{/if}
			{/if}
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
				<p class="text-xs font-medium">Skills</p>
				<p class="text-[11px] text-muted-foreground">
					Expose runtime-installed skills to this agent run.
				</p>
			</div>
		</div>

		{#if selectedProfile && activeRuntimePolicy.allowSkillAdditions !== true}
			<p class="text-[11px] text-muted-foreground">
				This profile only allows profile skills. You can narrow allowed tools or remove profile
				skills when narrowing is enabled.
			</p>
		{/if}

		{#if selectedProfile}
			{@const missingProfileSkills = (selectedProfile.config.skills || []).filter((skill) => !selectedSkillByKey(skillKey(skill)))}
			{#if missingProfileSkills.length > 0}
				<div class="space-y-2">
					<p class="text-[11px] font-medium text-muted-foreground">Available Profile Skills</p>
					<div class="flex flex-wrap gap-2">
						{#each missingProfileSkills as skill (skillKey(skill))}
							<Button variant="outline" size="sm" onclick={() => restoreProfileSkill(skill)}>
								Restore {skill.name}
							</Button>
						{/each}
					</div>
				</div>
			{/if}
		{/if}

		<div class="space-y-2">
			<div class="flex items-center justify-between gap-2">
				<p class="text-[11px] font-medium text-muted-foreground">Approved Skill Registry</p>
				<Button variant="outline" size="sm" onclick={() => void loadAgentSkills()}>
					{agentSkillsLoading ? 'Loading' : 'Refresh'}
				</Button>
			</div>
			{#if availableRegistrySkills.length > 0}
				<div class="flex flex-wrap gap-2">
					{#each availableRegistrySkills as skill (skillKey(skill))}
						<Button variant="outline" size="sm" onclick={() => addRegistrySkill(skill)}>
							Add {skill.name}
						</Button>
					{/each}
				</div>
			{:else}
				<p class="text-[11px] text-muted-foreground">
					No additional approved skills are available for this profile policy.
				</p>
			{/if}
		</div>

		{#if skills.length === 0}
			<div class="rounded-md border border-dashed p-3 text-[11px] text-muted-foreground">
				No skills configured. Add an approved registry skill or select a profile with skills.
			</div>
		{:else}
			<div class="space-y-3">
				{#each skills as skill (skillKey(skill) || skill.name)}
					{@const profileSkill = isProfileSkill(skill)}
					{@const canNarrowSkill = activeRuntimePolicy.allowSkillNarrowing !== false}
					<div class="rounded-md border p-3 space-y-3">
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2">
									<p class="truncate text-xs font-medium">{skill.name || 'Unnamed skill'}</p>
									<Badge variant={profileSkill ? 'secondary' : 'outline'}>
										{profileSkill ? 'profile' : 'registry'}
									</Badge>
									{#if skill.version}
										<Badge variant="outline">v{skill.version}</Badge>
									{/if}
								</div>
								{#if profileSkill}
									<p class="mt-1 text-[11px] text-muted-foreground">
										Profile skills keep their install metadata from the selected profile.
									</p>
								{/if}
								{#if skill.installSource || skill.sourceRepo}
									<p class="mt-1 truncate text-[11px] text-muted-foreground">
										{skill.installSource || skill.sourceRepo}@{skill.skillName || skill.name}
									</p>
								{/if}
							</div>
							<Button
								variant="outline"
								size="sm"
								disabled={!canRemoveSkill(skill)}
								onclick={() => removeSkill(skill)}
							>
								Remove
							</Button>
						</div>

						<div class="grid grid-cols-2 gap-3">
							<div class="space-y-1.5">
								<Label for={`skill-source-${skillKey(skill)}`}>Install Source</Label>
								<Input
									id={`skill-source-${skillKey(skill)}`}
									value={skill.installSource || skill.sourceRepo || ''}
									disabled
									placeholder="owner/repo"
								/>
							</div>
							<div class="space-y-1.5">
								<Label for={`skill-name-${skillKey(skill)}`}>Skill Name</Label>
								<Input
									id={`skill-name-${skillKey(skill)}`}
									value={skill.skillName || skill.name}
									disabled
									placeholder="skill-name"
								/>
							</div>
							<div class="col-span-2 space-y-1.5">
								<Label for={`skill-registry-${skillKey(skill)}`}>Registry URL</Label>
								<Input
									id={`skill-registry-${skillKey(skill)}`}
									value={skill.registryUrl || ''}
									disabled
									placeholder="https://skills.sh/owner/repo/skill"
								/>
							</div>
							<div class="space-y-1.5">
								<Label for={`skill-tools-${skillKey(skill)}`}>Allowed Tools</Label>
								<Input
									id={`skill-tools-${skillKey(skill)}`}
									value={Array.isArray(skill.allowedTools) ? skill.allowedTools.join(', ') : ''}
									disabled={profileSkill && !canNarrowSkill}
									oninput={(event) => updateSkillAllowedTools(skill, event.currentTarget.value)}
									placeholder="All tools, or comma-separated tool names"
								/>
							</div>
							<div class="space-y-1.5">
								<Label for={`skill-agent-${skillKey(skill)}`}>Install Agent</Label>
								<Input
									id={`skill-agent-${skillKey(skill)}`}
									value={skill.installAgent || 'universal'}
									disabled
								/>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{/if}
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

		<div class="grid gap-3 md:grid-cols-[220px_1fr]">
			<div class="space-y-1.5">
				<Label for="agent-mcp-mode">Connection Mode</Label>
				<NativeSelect
					id="agent-mcp-mode"
					class="w-full"
					value={mcpConnectionMode}
					onchange={(event) => updateAgentConfig({ mcpConnectionMode: event.currentTarget.value })}
				>
					<option value="explicit">Profile and selected MCP servers</option>
					<option value="project">Legacy: all enabled project MCP connections</option>
					<option value="auto">Legacy: project connections when none selected</option>
				</NativeSelect>
			</div>
			<p class="self-end text-[11px] text-muted-foreground">
				Profile mode is the default. Legacy project modes append enabled Settings MCP connections
				at runtime.
			</p>
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
						{@const selectedServer = selectedServerForConnection(connection)}
						{@const connectionServer = serverFromConnection(connection)}
						{@const addBlocked = !selectedServer && !canAddServer(connectionServer)}
						{@const tools = toolInventory(connection)}
						<div class="rounded-md border p-3 space-y-2">
							<label class="flex items-start gap-2 text-xs">
								<input
									type="checkbox"
									class="mt-0.5"
									checked={Boolean(selectedServer)}
									disabled={(connection.status !== 'ENABLED' && !selectedServer) || addBlocked}
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
									{#if addBlocked}
										<span class="mt-1 block text-[10px] text-muted-foreground">
											Not included in the selected global profile.
										</span>
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
					{@const presetBlocked = !isPresetSelected(preset) && !canAddServer(preset)}
					<label class="rounded-md border p-3 text-xs">
						<span class="flex items-center gap-2">
							<input
								type="checkbox"
								checked={isPresetSelected(preset)}
								disabled={presetBlocked}
								onchange={(event) => togglePreset(preset, event.currentTarget.checked)}
							/>
							<span class="font-medium">{preset.displayName}</span>
						</span>
						<code class="mt-2 block truncate text-[10px] text-muted-foreground">
							{preset.command} {(preset.args || []).join(' ')}
						</code>
						{#if presetBlocked}
							<span class="mt-2 block text-[10px] text-muted-foreground">
								Not included in the selected global profile.
							</span>
						{/if}
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
