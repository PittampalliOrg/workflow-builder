<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import * as Command from '$lib/components/ui/command';
	import { Dialog, DialogContent } from '$lib/components/ui/dialog';
	import {
		Bot,
		Layers,
		MessageSquare,
		MessagesSquare,
		KeyRound,
		Plug,
		Plus,
		Sparkles,
		Workflow,
		Rocket,
		Folder,
		BarChart3,
		FileText,
		Container,
		Activity,
		Key,
		Gauge,
		GitBranch,
		Users,
		Settings,
		Trophy
	} from '@lucide/svelte';
	import type { SessionSummary } from '$lib/types/sessions';
	import type { AgentSummary } from '$lib/types/agents';

	let open = $state(false);
	let search = $state('');

	// Cache lists so the palette doesn't re-fetch on every open.
	let sessions = $state<SessionSummary[]>([]);
	let agents = $state<AgentSummary[]>([]);
	let lastLoaded = 0;

	async function loadData() {
		// 30s freshness window — the palette is ephemeral, a tiny bit of
		// staleness is fine and avoids double-fetch on rapid reopens.
		if (Date.now() - lastLoaded < 30_000) return;
		try {
			const [sRes, aRes] = await Promise.all([
				fetch('/api/v1/sessions?limit=50'),
				fetch('/api/agents')
			]);
			if (sRes.ok) {
				const sb = (await sRes.json()) as { sessions: SessionSummary[] };
				sessions = sb.sessions ?? [];
			}
			if (aRes.ok) {
				const ab = (await aRes.json()) as { agents: AgentSummary[] };
				agents = ab.agents ?? [];
			}
			lastLoaded = Date.now();
		} catch {
			// silent — palette still works with static nav items
		}
	}

	function handleKey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			open = !open;
			if (open) void loadData();
		} else if (e.key === 'Escape' && open) {
			open = false;
		}
	}

	onMount(() => {
		window.addEventListener('keydown', handleKey);
	});
	onDestroy(() => {
		window.removeEventListener('keydown', handleKey);
	});

	function go(path: string) {
		open = false;
		goto(path);
	}

	async function createSessionForAgent(agentId: string) {
		open = false;
		try {
			const res = await fetch('/api/v1/sessions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ agentId })
			});
			if (res.ok) {
				const body = (await res.json()) as { session?: { id: string }; id?: string };
				const id = body.session?.id ?? body.id;
				if (id) goto(`/workspaces/default/sessions/${id}`);
			}
		} catch {
			// fall through — user can navigate manually
		}
	}

	// Palette paths prepend `/workspaces/default/` for workspace-scoped nouns.
	// The hooks.server.ts resolver swaps `default` for the caller's active
	// workspace, so these links land on the right project automatically.
	const navItems: Array<{
		label: string;
		path: string;
		icon: typeof Bot;
		keywords?: string;
	}> = [
		{ label: 'Runs', path: '/workspaces/default/runs', icon: Activity, keywords: 'executions workflow runs recent' },
		{ label: 'Sessions', path: '/workspaces/default/sessions', icon: MessagesSquare, keywords: 'chat' },
		{ label: 'Agents', path: '/workspaces/default/agents', icon: Bot },
		{ label: 'Environments', path: '/workspaces/default/environments', icon: Layers, keywords: 'sandbox' },
		{ label: 'Credentials', path: '/workspaces/default/credentials', icon: KeyRound, keywords: 'secrets oauth vault connection' },
		{ label: 'Connections', path: '/workspaces/default/connections', icon: Plug, keywords: 'oauth mcp app integrations providers' },
		{ label: 'Workflows', path: '/workspaces/default/workflows', icon: Workflow },
		{ label: 'Library', path: '/workspaces/default/library', icon: Folder, keywords: 'skills files batches code reusable' },
		{ label: 'Library: Skills', path: '/workspaces/default/skills', icon: Sparkles, keywords: 'library' },
		{ label: 'Library: Files', path: '/workspaces/default/files', icon: FileText, keywords: 'library uploads' },
		{ label: 'Library: Batches', path: '/workspaces/default/batches', icon: Layers, keywords: 'library bulk' },
		{ label: 'Library: Custom code', path: '/code-functions', icon: Folder, keywords: 'library functions typescript python' },
		{ label: 'Evaluations', path: '/workspaces/default/evaluations', icon: Activity, keywords: 'evals datasets graders' },
		{ label: 'Benchmarks', path: '/workspaces/default/benchmarks', icon: Trophy, keywords: 'swe-bench swebench grading harness' },
		{ label: 'Usage', path: '/workspaces/default/usage', icon: BarChart3 },
		{ label: 'Observability (traces)', path: '/observability', icon: FileText, keywords: 'traces logs telemetry' },
		{ label: 'Sandboxes', path: '/sandboxes', icon: Container },
		{ label: 'Workbench', path: '/workbench', icon: MessagesSquare, keywords: 'mcp chat prototype' },
		{ label: 'Admin: Dapr system', path: '/admin/dapr', icon: Activity, keywords: 'admin' },
		{ label: 'Admin: Agent runtimes', path: '/admin/runtimes', icon: Activity, keywords: 'admin pods' },
		{ label: 'Admin: Workflow instances', path: '/admin/instances', icon: Activity, keywords: 'admin monitor' },
		{ label: 'Admin: Activities', path: '/admin/activities', icon: Activity, keywords: 'admin dapr' },
		{ label: 'Admin: GitOps', path: '/admin/gitops', icon: GitBranch, keywords: 'admin promoter deployments release pins' },
		{ label: 'Admin: GitOps system', path: '/admin/gitops/system', icon: GitBranch, keywords: 'admin gitops lanes skaffold ryzen dev outer loop' },
		{ label: 'API keys', path: '/workspaces/default/settings/keys', icon: Key },
		{ label: 'Limits', path: '/workspaces/default/settings/limits', icon: Gauge },
		{ label: 'Members', path: '/settings/members', icon: Users },
		{ label: 'Security', path: '/settings/security', icon: Settings }
	];

	const quickCreates: Array<{ label: string; path: string; icon: typeof Plus }> = [
		{ label: 'New session', path: '/workspaces/default/sessions/new', icon: Plus },
		{ label: 'New agent', path: '/workspaces/default/agents/new', icon: Plus },
		{ label: 'New agent (from template)', path: '/workspaces/default/agents/new?template=1', icon: Sparkles },
		{ label: 'New environment', path: '/workspaces/default/environments/new', icon: Plus }
	];
</script>

<Dialog bind:open>
	<DialogContent class="p-0 sm:max-w-2xl overflow-hidden" showCloseButton={false}>
		<Command.Root label="Global search" class="rounded-lg border-none shadow-md">
			<Command.Input
				placeholder="Jump to a session, agent, or page… (⌘K)"
				bind:value={search}
			/>
			<Command.List class="max-h-[420px]">
				<Command.Empty>No matches.</Command.Empty>

				<Command.Group heading="Create">
					{#each quickCreates as q (q.path)}
						<Command.Item onSelect={() => go(q.path)}>
							<q.icon class="size-4 mr-2 text-muted-foreground" />
							{q.label}
						</Command.Item>
					{/each}
				</Command.Group>

				{#if sessions.length > 0}
					<Command.Group heading="Sessions">
						{#each sessions.slice(0, 12) as s (s.id)}
							<Command.Item
								value={`${s.title ?? s.id} ${s.agentId} ${s.id}`}
								onSelect={() => go(`/workspaces/default/sessions/${s.id}`)}
							>
								<MessageSquare class="size-4 mr-2 text-muted-foreground" />
								<div class="flex-1 min-w-0">
									<div class="truncate">{s.title ?? 'Untitled session'}</div>
									<div class="text-[10px] text-muted-foreground">
										{s.status} · {s.agentId}
									</div>
								</div>
							</Command.Item>
						{/each}
					</Command.Group>
				{/if}

				{#if agents.length > 0}
					<Command.Group heading="Agents">
						{#each agents as a (a.id)}
							<Command.Item
								value={`${a.name} ${a.slug ?? ''} ${a.id}`}
								onSelect={() => go(`/workspaces/default/agents/${a.id}`)}
							>
								<Bot class="size-4 mr-2 text-muted-foreground" />
								<div class="flex-1 min-w-0">
									<div class="truncate">{a.avatar ?? '🤖'} {a.name}</div>
									<div class="text-[10px] text-muted-foreground truncate">{a.id}</div>
								</div>
							</Command.Item>
							<Command.Item
								value={`Run agent ${a.name} new session`}
								onSelect={() => createSessionForAgent(a.id)}
							>
								<Rocket class="size-4 mr-2 text-amber-500" />
								<span class="text-muted-foreground">Start session with</span>
								<span class="ml-1">{a.name}</span>
							</Command.Item>
						{/each}
					</Command.Group>
				{/if}

				<Command.Group heading="Navigate">
					{#each navItems as n (n.path)}
						<Command.Item
							value={`${n.label} ${n.keywords ?? ''}`}
							onSelect={() => go(n.path)}
						>
							<n.icon class="size-4 mr-2 text-muted-foreground" />
							{n.label}
							<Folder class="size-3 ml-auto text-muted-foreground opacity-50" />
						</Command.Item>
					{/each}
				</Command.Group>
			</Command.List>
		</Command.Root>
	</DialogContent>
</Dialog>
