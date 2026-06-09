<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import * as Command from '$lib/components/ui/command';
	import { Label } from '$lib/components/ui/label';
	import { ChevronsUpDown, GitBranch, ExternalLink } from '@lucide/svelte';

	type RepoSummary = {
		name: string;
		fullName: string;
		owner: string;
		description: string;
		url: string;
	};
	type ConnSummary = { externalId: string; displayName: string };

	interface Props {
		/** Workspace slug for the "Connect GitHub" deep link. */
		workspaceSlug: string;
		/** Emitted when a repo is chosen. repoUrl is the canonical clone URL and
		 * connectionExternalId is the GitHub OAuth connection that authorizes the
		 * clone. */
		onPick: (repo: {
			repoUrl: string;
			fullName: string;
			connectionExternalId: string;
		}) => void;
	}

	let { workspaceSlug, onPick }: Props = $props();

	let connections = $state<ConnSummary[]>([]);
	let connId = $state<string>('');
	let repos = $state<RepoSummary[]>([]);
	let loadingConns = $state(true);
	let loadingRepos = $state(false);
	let error = $state<string | null>(null);
	let loaded = $state(false);
	let open = $state(false);
	let search = $state('');

	const filtered = $derived(
		search.trim()
			? repos.filter((r) =>
					r.fullName.toLowerCase().includes(search.trim().toLowerCase())
				)
			: repos
	);

	async function loadConnections() {
		loadingConns = true;
		error = null;
		try {
			const res = await fetch('/api/app-connections?providerId=github');
			if (!res.ok) throw new Error(`Failed to load connections (${res.status})`);
			const data = (await res.json()) as Array<Record<string, unknown>>;
			connections = (Array.isArray(data) ? data : [])
				.filter((c) => !c.status || String(c.status) === 'ACTIVE')
				.map((c) => ({
					externalId: String(c.externalId),
					displayName: String(c.displayName || c.externalId)
				}));
			if (connections.length === 1) {
				connId = connections[0].externalId;
				await loadRepos();
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load GitHub connections';
		} finally {
			loadingConns = false;
			loaded = true;
		}
	}

	async function loadRepos() {
		if (!connId) {
			repos = [];
			return;
		}
		loadingRepos = true;
		error = null;
		try {
			const res = await fetch(
				`/api/scm/repos?connectionExternalId=${encodeURIComponent(connId)}`
			);
			if (!res.ok) throw new Error(`Failed to load repos (${res.status})`);
			const data = (await res.json()) as { repos?: RepoSummary[] };
			repos = data.repos ?? [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load repositories';
			repos = [];
		} finally {
			loadingRepos = false;
		}
	}

	function onConnChange(event: Event) {
		connId = (event.currentTarget as HTMLSelectElement).value;
		repos = [];
		search = '';
		void loadRepos();
	}

	function pick(repo: RepoSummary) {
		open = false;
		search = '';
		onPick({
			repoUrl: `https://github.com/${repo.fullName}.git`,
			fullName: repo.fullName,
			connectionExternalId: connId
		});
	}

	$effect(() => {
		if (!loaded) void loadConnections();
	});
</script>

<div class="space-y-1.5">
	{#if loadingConns}
		<div class="text-[10px] text-muted-foreground">Loading GitHub connections…</div>
	{:else if connections.length === 0}
		<a
			href={`/workspaces/${workspaceSlug}/connections`}
			class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
		>
			<GitBranch class="size-3.5" /> Connect GitHub <ExternalLink class="size-3" />
		</a>
		<p class="text-[10px] text-muted-foreground">
			Connect GitHub once to pick repos from a list. You can still paste a URL below.
		</p>
	{:else}
		<div>
			<Label class="text-[10px]" for="gh-conn">GitHub connection</Label>
			<select
				id="gh-conn"
				value={connId}
				onchange={onConnChange}
				class="flex h-7 w-full rounded-md border border-input bg-background px-2 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<option value="">Select a connection…</option>
				{#each connections as c (c.externalId)}
					<option value={c.externalId}>{c.displayName}</option>
				{/each}
			</select>
		</div>
		<div>
			<Label class="text-[10px]">Repository</Label>
			<Popover.Root bind:open>
				<Popover.Trigger
					disabled={!connId}
					class="flex h-7 w-full items-center justify-between rounded-md border border-input bg-background px-2 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
				>
					<span class="text-muted-foreground">
						{loadingRepos ? 'Loading repos…' : 'Search your repos…'}
					</span>
					<ChevronsUpDown class="size-3 text-muted-foreground" />
				</Popover.Trigger>
				<Popover.Content class="w-[320px] p-0" align="start" sideOffset={4}>
					<Command.Root shouldFilter={false}>
						<Command.Input
							bind:value={search}
							placeholder="Search repositories…"
							class="h-8 text-xs"
						/>
						<Command.List class="max-h-[260px]">
							<Command.Empty>
								{loadingRepos ? 'Loading…' : 'No repositories.'}
							</Command.Empty>
							<Command.Group>
								{#each filtered.slice(0, 100) as repo (repo.fullName)}
									<Command.Item
										value={repo.fullName}
										onSelect={() => pick(repo)}
										class="text-xs"
									>
										<span class="truncate">{repo.fullName}</span>
									</Command.Item>
								{/each}
							</Command.Group>
						</Command.List>
					</Command.Root>
				</Popover.Content>
			</Popover.Root>
		</div>
	{/if}
	{#if error}<div class="text-[10px] text-destructive">{error}</div>{/if}
</div>
