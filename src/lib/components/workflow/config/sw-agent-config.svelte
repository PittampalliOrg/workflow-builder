<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { DEFAULT_WORKSPACE_SLUG } from '$lib/utils/workspace-path';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import {
		Collapsible,
		CollapsibleContent,
		CollapsibleTrigger
	} from '$lib/components/ui/collapsible';
	import { ChevronDown, ChevronRight, ExternalLink, Plus } from '@lucide/svelte';
	import { buildOpenShellSystemPrompt } from '$lib/agents/instruction-bundle-renderer';
	import { buildPromptWorkbenchPreview } from '$lib/agents/prompt-workbench-renderer';
	import { normalizeAgentTaskConfig } from '$lib/types/agent-graph';
	import type { AgentDetail, AgentSummary, BundleRef } from '$lib/types/agents';
	import RegistryStatusBadge from '$lib/components/agents/registry-status-badge.svelte';
	import BundleRefsPicker from '$lib/components/capabilities/bundle-refs-picker.svelte';
	import AgentPicker from '$lib/components/agents/agent-picker.svelte';
	import PromptPreview from '$lib/components/agents/prompt-preview.svelte';

	interface Props {
		data: Record<string, unknown>;
		onUpdate: (key: string, value: unknown) => void;
	}

	let { data, onUpdate }: Props = $props();

	let agents = $state<AgentSummary[]>([]);
	let selectedAgentDetail = $state<AgentDetail | null>(null);
	let detailLoading = $state(false);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let overridesOpen = $state(false);

	/** Runtime descriptor projection from GET /api/runtimes (capability-driven UI). */
	interface RuntimeInfo {
		id: string;
		family: 'durable-session' | 'browser' | 'interactive-cli';
		cliAdapter: string | null;
		capabilities: {
			multiProvider: boolean;
			supportedProviders: string[];
			interactiveTerminal?: boolean;
			supportsMcp: boolean;
			[key: string]: unknown;
		};
		cliAuth: { provider: string; credentialKind: string; loginStyle: string | null } | null;
	}
	let runtimes = $state<Record<string, RuntimeInfo>>({});
	// Native-goal CLI adapters (claude/codex inject /goal); agy + non-CLI use the
	// custom BFF goal loop. Mirrors runtimeUsesNativeGoal() on the server.
	const NATIVE_GOAL_ADAPTERS = new Set(['claude-code', 'codex']);
	// Live CLI-credential status for the selected runtime's provider (interactive
	// CLI agents 400 at dispatch without a linked credential).
	let cliCredStatus = $state<{
		provider: string;
		linked: boolean;
		status: string | null;
		expiresAt: string | null;
	} | null>(null);
	let cliCredLoading = $state(false);
	const slug = $derived(
		(page.params.slug as string | undefined) ?? DEFAULT_WORKSPACE_SLUG,
	);

	// Normalize incoming taskConfig to the ref-only shape.
	const taskConfig = $derived(
		typeof data.taskConfig === 'object' && data.taskConfig !== null
			? (data.taskConfig as Record<string, unknown>)
			: {}
	);
	const withBlock = $derived(
		typeof taskConfig.with === 'object' && taskConfig.with !== null
			? (taskConfig.with as Record<string, unknown>)
			: {}
	);
	const body = $derived(
		typeof withBlock.body === 'object' && withBlock.body !== null
			? (withBlock.body as Record<string, unknown>)
			: {}
	);
	const agentRef = $derived(
		(body.agentRef ?? withBlock.agentRef) as
			| { id: string; version?: number }
			| undefined
	);
	const prompt = $derived(
		typeof body.prompt === 'string'
			? body.prompt
			: typeof withBlock.prompt === 'string'
				? withBlock.prompt
				: ''
	);
	const overrides = $derived(
		typeof body.overrides === 'object' && body.overrides !== null
			? (body.overrides as Record<string, unknown>)
			: {}
	);
	const nodeInstructionBundle = $derived(
		recordOrNull(body.instructionBundle) ?? recordOrNull(withBlock.instructionBundle)
	);
	const instructionHash = $derived(
		typeof nodeInstructionBundle?.instructionHash === 'string'
			? nodeInstructionBundle.instructionHash
			: null
	);
	const overrideCount = $derived(Object.keys(overrides).length);
	// Optional Goal section: presence of goal.objective makes this a goal-driven
	// (multi-turn) run that loops until session.goal_completed / budget / maxIter.
	// Stored as `goalSpec` (NOT `goal`): the spec-resolver treats `goal` as an
	// agent-persona override field and strips it at execute time.
	const goal = $derived(
		typeof body.goalSpec === 'object' && body.goalSpec !== null
			? (body.goalSpec as Record<string, unknown>)
			: {}
	);
	const goalObjective = $derived(
		typeof goal.objective === 'string' ? goal.objective : ''
	);
	let goalOpen = $state(false);
	const selectedAgent = $derived(
		agentRef ? agents.find((a) => a.id === agentRef.id) ?? null : null
	);
	// Resolve the selected agent's runtime descriptor → drive capability-gated UI.
	const selectedRuntime = $derived(
		selectedAgent ? runtimes[selectedAgent.runtime] ?? null : null
	);
	const isCliRuntime = $derived(selectedRuntime?.family === 'interactive-cli');
	const isMultiProvider = $derived(selectedRuntime?.capabilities.multiProvider === true);
	const runtimeProviders = $derived(selectedRuntime?.capabilities.supportedProviders ?? []);
	const usesNativeGoal = $derived(
		isCliRuntime &&
			!!selectedRuntime?.cliAdapter &&
			NATIVE_GOAL_ADAPTERS.has(selectedRuntime.cliAdapter)
	);
	const cliProvider = $derived(selectedRuntime?.cliAuth?.provider ?? null);
	const selectedAgentVersion = $derived(
		agentRef?.version ?? selectedAgent?.currentVersion ?? null
	);
	const previewCwd = $derived(
		typeof overrides.cwd === 'string' && overrides.cwd.trim()
			? overrides.cwd.trim()
			: typeof selectedAgentDetail?.config.cwd === 'string' &&
				  selectedAgentDetail.config.cwd.trim()
				? selectedAgentDetail.config.cwd.trim()
				: '/sandbox'
	);
	const previewSandboxName = $derived(
		typeof body.sandboxName === 'string' && body.sandboxName.trim()
			? body.sandboxName.trim()
			: typeof withBlock.sandboxName === 'string' && withBlock.sandboxName.trim()
				? withBlock.sandboxName.trim()
				: null
	);
	const nodePromptPreview = $derived(
		selectedAgentDetail
			? buildPromptWorkbenchPreview({
					config: selectedAgentDetail.config,
					agent: {
						id: selectedAgentDetail.id,
						name: selectedAgentDetail.name,
						slug: selectedAgentDetail.slug,
						version: selectedAgentVersion,
						configHash: selectedAgent?.currentConfigHash ?? selectedAgentDetail.currentConfigHash
					},
					runtime: {
						cwd: previewCwd,
						sandboxName: previewSandboxName,
						environment: selectedAgentDetail.environmentId ?? 'default',
						skills: skillNames(selectedAgentDetail.config.skills),
						platformSystemSections: [
							buildOpenShellSystemPrompt(previewCwd, previewSandboxName)
						]
					},
					workflow: {
						id: (page.params.workflowId as string | undefined) ?? null,
						nodePrompt: prompt
					},
					userPrompt: prompt
				})
			: null
	);

	onMount(async () => {
		try {
			const [agentsRes, runtimesRes] = await Promise.all([
				fetch('/api/agents'),
				fetch('/api/runtimes')
			]);
			if (!agentsRes.ok) {
				loadError = `Failed to load agents (${agentsRes.status})`;
				return;
			}
			const d = (await agentsRes.json()) as { agents: AgentSummary[] };
			agents = d.agents ?? [];
			if (runtimesRes.ok) {
				const rd = (await runtimesRes.json()) as { runtimes: RuntimeInfo[] };
				runtimes = Object.fromEntries((rd.runtimes ?? []).map((r) => [r.id, r]));
			}
			if (agentRef?.id) void loadAgentDetail(agentRef.id);
		} catch (err) {
			loadError = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	});

	// Live-check the user's CLI credential for the selected interactive-CLI
	// runtime's provider so we can warn that workflow dispatch needs one linked
	// (Settings → CLI tokens) before the run 400s at the bridge.
	$effect(() => {
		const provider = cliProvider;
		if (!provider) {
			cliCredStatus = null;
			return;
		}
		let cancelled = false;
		cliCredLoading = true;
		fetch(`/api/v1/users/me/cli-tokens/${encodeURIComponent(provider)}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((s) => {
				if (!cancelled) cliCredStatus = s;
			})
			.catch(() => {
				if (!cancelled) cliCredStatus = null;
			})
			.finally(() => {
				if (!cancelled) cliCredLoading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	function writeBody(nextBody: Record<string, unknown>) {
		const next = normalizeAgentTaskConfig(
			{
				...taskConfig,
				call: 'durable/run',
				with: { ...withBlock, body: nextBody }
			} as Record<string, unknown>,
			typeof data.label === 'string' ? data.label : 'Agent'
		);
		onUpdate('taskConfig', next);
	}

	function setAgent(agentId: string) {
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) return;
		void loadAgentDetail(agent.id);
		writeBody({
			...body,
			prompt,
			agentRef: { id: agent.id, version: agent.currentVersion ?? undefined }
		});
	}

	async function loadAgentDetail(agentId: string) {
		detailLoading = true;
		try {
			const res = await fetch(`/api/agents/${agentId}`);
			if (!res.ok) {
				selectedAgentDetail = null;
				return;
			}
			const d = (await res.json()) as { agent: AgentDetail };
			selectedAgentDetail = d.agent ?? null;
		} catch {
			selectedAgentDetail = null;
		} finally {
			detailLoading = false;
		}
	}

	function recordOrNull(value: unknown): Record<string, unknown> | null {
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	}

	function skillNames(value: unknown): string[] {
		if (!Array.isArray(value)) return [];
		return value
			.map((item) => {
				const record = recordOrNull(item);
				if (!record) return null;
				return (
					textValue(record.name) ??
					textValue(record.skillName) ??
					textValue(record.skill_name) ??
					textValue(record.slug)
				);
			})
			.filter((name): name is string => Boolean(name));
	}

	function textValue(value: unknown): string | null {
		return typeof value === 'string' && value.trim() ? value.trim() : null;
	}

	function setPrompt(v: string) {
		writeBody({ ...body, prompt: v });
	}

	/** Write a Goal field. Clearing the objective removes the whole goal block
	 *  (reverts the node to a single-shot run). */
	function setGoalField(key: 'objective' | 'tokenBudget' | 'maxIterations', value: unknown) {
		const next: Record<string, unknown> = { ...goal };
		if (value === undefined || value === null || value === '') delete next[key];
		else next[key] = value;
		const nextBody = { ...body };
		if (key === 'objective' && (value === undefined || value === '')) {
			// Objective cleared → drop goal mode entirely.
			delete nextBody.goalSpec;
		} else if (Object.keys(next).length === 0) {
			delete nextBody.goalSpec;
		} else {
			nextBody.goalSpec = next;
		}
		writeBody(nextBody);
	}

	function setOverride<T>(key: string, value: T | undefined) {
		const next = { ...overrides };
		if (value === undefined || value === null || value === '') delete next[key];
		else next[key] = value;
		const nextBody = { ...body };
		if (Object.keys(next).length === 0) delete nextBody.overrides;
		else nextBody.overrides = next;
		writeBody(nextBody);
	}

	const policy = $derived(
		selectedAgent
			? ({
					allowToolNarrowing: true,
					allowServerAdditions: false,
					allowCredentialBinding: true,
					allowSkillAdditions: false,
					allowSkillNarrowing: true
				} as Record<string, boolean>)
			: null
	);
</script>

<div class="flex flex-col gap-4 p-4">
	{#if loadError}
		<Alert variant="destructive">
			<AlertDescription>{loadError}</AlertDescription>
		</Alert>
	{/if}

	<div>
		<Label>Agent</Label>
		{#if loading}
			<div class="text-xs text-muted-foreground mt-1">Loading agents…</div>
		{:else if agents.length === 0}
			<Alert class="mt-2">
				<AlertDescription class="flex items-center justify-between gap-2">
					<span>No agents defined yet.</span>
					<a href="/workspaces/{slug}/agents/new" target="_blank" class="text-primary hover:underline text-xs">
						Create one <ExternalLink class="inline size-3" />
					</a>
				</AlertDescription>
			</Alert>
		{:else}
			<div class="flex items-center gap-2 mt-1">
				<div class="flex-1">
					<AgentPicker
						value={agentRef?.id ?? null}
						{agents}
						onChange={(id) => setAgent(id)}
					/>
				</div>
				{#if agentRef?.id}
					<a
						href="/workspaces/{slug}/agents/{agentRef.id}"
						target="_blank"
						class="text-xs text-primary hover:underline flex items-center gap-1"
					>
						Edit <ExternalLink class="size-3" />
					</a>
				{/if}
			</div>
			{#if selectedAgent}
				<div class="flex items-center gap-1 mt-2 flex-wrap">
					{#if selectedAgent.modelSpec}
						<Badge variant="outline" class="font-mono text-[10px]">
							{selectedAgent.modelSpec}
						</Badge>
					{/if}
					<RegistryStatusBadge
						status={selectedAgent.registryStatus}
						error={selectedAgent.registryError}
						syncedAt={selectedAgent.registrySyncedAt}
						mini
					/>
					{#if selectedAgent.description}
						<span class="text-xs text-muted-foreground line-clamp-1">
							{selectedAgent.description}
						</span>
					{/if}
				</div>
				{#if selectedAgent.registryStatus !== 'registered'}
					<p class="text-[11px] text-amber-600 dark:text-amber-300 mt-1">
						Not in the Dapr registry. Native <code>call_agent</code> lookups won't find this agent
						by name until it's resynced.
					</p>
				{/if}

				<!-- Runtime capability summary: the node abstracts CLI vs dapr; these
				     chips + notices surface what's runtime-specific for the picked agent. -->
				{#if selectedRuntime}
					<div class="mt-2 flex items-center gap-1 flex-wrap">
						<Badge variant="secondary" class="font-mono text-[10px]">
							{selectedRuntime.id}
						</Badge>
						{#if isCliRuntime}
							<Badge variant="outline" class="text-[10px]">interactive CLI</Badge>
						{/if}
						{#if isMultiProvider}
							<Badge variant="outline" class="text-[10px]">
								multi-provider ({runtimeProviders.length})
							</Badge>
						{:else if runtimeProviders.length === 1}
							<Badge variant="outline" class="text-[10px]">
								{runtimeProviders[0]} (vendor-locked)
							</Badge>
						{/if}
						<Badge variant="outline" class="text-[10px]">
							{usesNativeGoal ? 'native /goal' : 'goal loop'}
						</Badge>
					</div>
					{#if isMultiProvider}
						<p class="text-[11px] text-muted-foreground mt-1">
							Model is configured on the agent (multi-provider runtime) — edit it in the
							agent library.
						</p>
					{:else if isCliRuntime && cliProvider}
						<p class="text-[11px] text-muted-foreground mt-1">
							Vendor-locked to <code>{cliProvider}</code>; the model is the CLI's own.
						</p>
					{/if}

					{#if isCliRuntime && cliProvider && !cliCredLoading}
						{#if !cliCredStatus?.linked}
							<Alert variant="destructive" class="mt-2">
								<AlertDescription class="text-xs">
									This runtime needs a linked <strong>{cliProvider}</strong> CLI credential
									to run in a workflow. Add one under
									<a
										href="/settings/cli-tokens"
										target="_blank"
										class="underline">Settings → CLI tokens</a
									>, or the run will fail at dispatch.
								</AlertDescription>
							</Alert>
						{:else if cliCredStatus.status === 'expired'}
							<Alert variant="destructive" class="mt-2">
								<AlertDescription class="text-xs">
									The linked <strong>{cliProvider}</strong> CLI credential has expired —
									re-enroll under
									<a
										href="/settings/cli-tokens"
										target="_blank"
										class="underline">Settings → CLI tokens</a
									>.
								</AlertDescription>
							</Alert>
						{:else}
							<p class="text-[11px] text-emerald-600 dark:text-emerald-300 mt-1">
								{cliProvider} CLI credential linked ✓
							</p>
						{/if}
					{/if}
				{/if}
				<div class="mt-3">
					{#if detailLoading}
						<div class="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
							Loading compiled prompt...
						</div>
					{:else if nodePromptPreview}
						<PromptPreview preview={nodePromptPreview} compact />
						{#if instructionHash}
							<div class="mt-1 text-[11px] text-muted-foreground">
								Stored instruction hash: <code>{instructionHash}</code>
							</div>
						{/if}
					{:else}
						<div class="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
							Instruction fields unavailable.
						</div>
					{/if}
				</div>
			{/if}
		{/if}
	</div>

	<div>
		<Label for="agent-prompt">Prompt</Label>
		<Textarea
			id="agent-prompt"
			rows={5}
			placeholder="What should the agent do for this workflow run?"
			value={prompt}
			oninput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
		/>
	</div>

	{#if selectedAgent}
		<!-- Goal mode: an optional objective turns this into a multi-turn run that
		     loops until the agent completes the goal (or hits a budget/iteration
		     cap). Same node — empty objective = single-shot run. -->
		<Collapsible bind:open={goalOpen}>
			<CollapsibleTrigger
				class="flex items-center gap-2 w-full text-left text-sm font-medium py-2"
			>
				{#if goalOpen}
					<ChevronDown class="size-4" />
				{:else}
					<ChevronRight class="size-4" />
				{/if}
				Goal (autonomous, multi-turn)
				{#if goalObjective.trim()}
					<Badge variant="secondary">on</Badge>
				{/if}
			</CollapsibleTrigger>
			<CollapsibleContent class="space-y-3 pl-6 pt-2">
				<p class="text-xs text-muted-foreground">
					Set an objective and the agent works toward it across turns until a
					completion signal fires (or a budget/iteration cap). Leave blank for a
					single-shot run.
					{#if goalObjective.trim()}
						{#if usesNativeGoal}
							<span class="block mt-1">
								This runtime uses its <strong>native <code>/goal</code></strong> — the
								objective is injected into the CLI, which drives its own loop.
							</span>
						{:else}
							<span class="block mt-1">
								This runtime uses the <strong>goal loop</strong> + goal MCP — the agent
								calls <code>update_goal</code> to mark completion.
							</span>
						{/if}
					{/if}
				</p>
				<div>
					<Label class="text-xs" for="agent-goal-objective">Objective</Label>
					<Textarea
						id="agent-goal-objective"
						rows={3}
						placeholder="e.g. Add tests for the auth module until all pass."
						value={goalObjective}
						oninput={(e) =>
							setGoalField('objective', (e.target as HTMLTextAreaElement).value)}
					/>
				</div>
				<div class="grid grid-cols-2 gap-3">
					<div>
						<Label class="text-xs">Token budget</Label>
						<Input
							type="number"
							value={(goal.tokenBudget as number | undefined) ?? ''}
							placeholder="none"
							oninput={(e) => {
								const v = (e.target as HTMLInputElement).value;
								setGoalField('tokenBudget', v ? Number(v) : undefined);
							}}
						/>
					</div>
					<div>
						<Label class="text-xs">Max iterations</Label>
						<Input
							type="number"
							value={(goal.maxIterations as number | undefined) ?? ''}
							placeholder="50"
							oninput={(e) => {
								const v = (e.target as HTMLInputElement).value;
								setGoalField('maxIterations', v ? Number(v) : undefined);
							}}
						/>
					</div>
				</div>
			</CollapsibleContent>
		</Collapsible>

		<Collapsible bind:open={overridesOpen}>
			<CollapsibleTrigger
				class="flex items-center gap-2 w-full text-left text-sm font-medium py-2"
			>
				{#if overridesOpen}
					<ChevronDown class="size-4" />
				{:else}
					<ChevronRight class="size-4" />
				{/if}
				Per-node overrides
				{#if overrideCount > 0}
					<Badge variant="secondary">{overrideCount}</Badge>
				{/if}
			</CollapsibleTrigger>
			<CollapsibleContent class="space-y-3 pl-6 pt-2">
				<p class="text-xs text-muted-foreground">
					Fine-tune the agent for this node only. Fields disabled by the agent's policy cannot be
					overridden.
				</p>
				<div class="grid grid-cols-2 gap-3">
					<div>
						<Label class="text-xs">Max turns</Label>
						<Input
							type="number"
							value={(overrides.maxTurns as number | undefined) ?? ''}
							placeholder="inherit"
							oninput={(e) => {
								const v = (e.target as HTMLInputElement).value;
								setOverride('maxTurns', v ? Number(v) : undefined);
							}}
						/>
					</div>
					<div>
						<Label class="text-xs">Timeout (min)</Label>
						<Input
							type="number"
							value={(overrides.timeoutMinutes as number | undefined) ?? ''}
							placeholder="inherit"
							oninput={(e) => {
								const v = (e.target as HTMLInputElement).value;
								setOverride('timeoutMinutes', v ? Number(v) : undefined);
							}}
						/>
					</div>
					<div class="col-span-2">
						<Label class="text-xs">cwd</Label>
						<Input
							value={(overrides.cwd as string | undefined) ?? ''}
							placeholder="inherit (defaults to /sandbox)"
							oninput={(e) =>
								setOverride('cwd', (e.target as HTMLInputElement).value || undefined)}
						/>
					</div>
					<div class="col-span-2">
						<Label class="text-xs">
							Tools (comma-separated, narrows the agent's list)
							{#if policy && !policy.allowToolNarrowing}
								<span class="text-destructive">(blocked by policy)</span>
							{/if}
						</Label>
						<Input
							disabled={policy ? !policy.allowToolNarrowing : false}
							value={((overrides.tools as string[] | undefined) ?? []).join(', ')}
							placeholder="leave blank to inherit"
							oninput={(e) => {
								const v = (e.target as HTMLInputElement).value
									.split(',')
									.map((s) => s.trim())
									.filter(Boolean);
								setOverride('tools', v.length > 0 ? v : undefined);
							}}
						/>
					</div>
				</div>
				<div class="mt-3">
					<Label class="text-xs">Capability bundles (layered on top of the agent's own)</Label>
					<BundleRefsPicker
						value={(overrides.bundleRefs as BundleRef[] | undefined) ?? []}
						onChange={(v) => setOverride('bundleRefs', v.length > 0 ? v : undefined)}
					/>
				</div>
			</CollapsibleContent>
		</Collapsible>
	{/if}

	<div class="border-t pt-3">
		<a href="/workspaces/{slug}/agents" target="_blank" class="text-xs text-primary hover:underline">
			<Plus class="inline size-3" /> Manage agents in the library
		</a>
	</div>
</div>
