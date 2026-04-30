<script lang="ts">
	import { Loader2, RefreshCw } from '@lucide/svelte';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Select from '$lib/components/ui/select';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';

	export type ScmConnectionSummary = {
		externalId: string;
		displayName: string;
		providerId: string;
		providerLabel?: string | null;
	};

	type OwnerSummary = {
		login: string;
		type: 'user' | 'org';
		label: string;
	};

	type RepoSummary = {
		name: string;
		fullName: string;
		description: string;
	};

	type IssueSummary = {
		number: number;
		title: string;
		body: string;
		state: string;
	};

	export type ScmTriggerValues = {
		connectionExternalId: string;
		provider: string;
		owner: string;
		repo: string;
		issue_number: number | null;
		title: string;
		body: string;
		sender: string;
	};

	interface Props {
		enabled?: boolean;
		mode?: 'create' | 'issue';
		fieldKeys?: string[];
		values?: ScmTriggerValues;
	}

	let {
		enabled = true,
		mode = 'create',
		fieldKeys = [],
		values = $bindable({
			connectionExternalId: '',
			provider: '',
			owner: '',
			repo: '',
			issue_number: null,
			title: '',
			body: '',
			sender: ''
		})
	}: Props = $props();

	let connections = $state<ScmConnectionSummary[]>([]);
	let owners = $state<OwnerSummary[]>([]);
	let repos = $state<RepoSummary[]>([]);
	let issues = $state<IssueSummary[]>([]);
	let loadingConnections = $state(false);
	let loadingOwners = $state(false);
	let loadingRepos = $state(false);
	let loadingIssues = $state(false);
	let loadError = $state<string | null>(null);
	let initialized = false;
	let customRepoMode = $state(false);
	const ownerCache = new Map<string, OwnerSummary[]>();
	const repoCache = new Map<string, RepoSummary[]>();
	const issueCache = new Map<string, IssueSummary[]>();
	let ownersRequestKey = 0;
	let reposRequestKey = 0;
	let issuesRequestKey = 0;
	const selectContentClass =
		'w-[min(var(--bits-select-anchor-width),calc(100vw-2rem))] max-w-[min(var(--bits-select-anchor-width),calc(100vw-2rem))]';

	const hasOwnerField = $derived(fieldKeys.includes('owner') || fieldKeys.length === 0);
	const hasRepoField = $derived(fieldKeys.includes('repo') || fieldKeys.length === 0);
	const hasIssueField = $derived(mode === 'issue');
	const canSelectOwner = $derived(owners.length > 0);

	function updateValues(patch: Partial<ScmTriggerValues>) {
		values = { ...values, ...patch };
	}

	function providerForConnection(externalId: string): string {
		return connections.find((connection) => connection.externalId === externalId)?.providerId || '';
	}

	function formatProviderLabel(providerId: string): string {
		return providerId === 'gitea' ? 'Gitea' : providerId === 'github' ? 'GitHub' : providerId;
	}

	function getConnectionLabel(connection: ScmConnectionSummary | undefined): string {
		if (!connection) return '';
		return `${formatProviderLabel(connection.providerId)}: ${connection.displayName}`;
	}

	function slugifyRepoName(value: string): string {
		return value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48);
	}

	function randomSuffix(): string {
		const bytes = new Uint8Array(2);
		globalThis.crypto?.getRandomValues(bytes);
		const randomValue =
			bytes[0] || bytes[1]
				? (bytes[0] * 256 + bytes[1]).toString(36)
				: Math.floor(Math.random() * 0xffff).toString(36);
		return randomValue.padStart(3, '0').slice(0, 3);
	}

	function generateRepositoryName(baseName = 'generated-app'): string {
		const base = slugifyRepoName(baseName) || 'generated-app';
		const timePart = Date.now().toString(36);
		let candidate = `${base}-${timePart}-${randomSuffix()}`;
		let attempts = 0;

		while (repos.some((repo) => repo.name === candidate) && attempts < 5) {
			candidate = `${base}-${Date.now().toString(36)}-${randomSuffix()}`;
			attempts += 1;
		}

		return candidate;
	}

	$effect(() => {
		if (!enabled) {
			initialized = false;
			return;
		}

		if (!initialized) {
			void loadConnections();
			initialized = true;
		}
	});

	async function loadConnections() {
		loadingConnections = true;
		loadError = null;
		try {
			const [githubRes, giteaRes] = await Promise.all([
				fetch('/api/app-connections?providerId=github'),
				fetch('/api/app-connections?providerId=gitea')
			]);

			const [github, gitea] = await Promise.all([
				githubRes.ok ? githubRes.json() : [],
				giteaRes.ok ? giteaRes.json() : []
			]);

			connections = [...github, ...gitea]
				.filter((connection) => connection.status === 'ACTIVE')
				.map((connection) => ({
					externalId: connection.externalId,
					displayName: connection.displayName,
					providerId: connection.providerId,
					providerLabel: connection.providerLabel
				}));

			if (!values.connectionExternalId && connections.length === 1) {
				selectConnection(connections[0].externalId);
			}
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'Failed to load connections';
			connections = [];
		} finally {
			loadingConnections = false;
		}
	}

	async function loadOwners(connectionExternalId: string) {
		const cacheKey = connectionExternalId;
		const cached = ownerCache.get(cacheKey);
		if (cached) {
			owners = cached;
			const provider = providerForConnection(connectionExternalId);
			if (provider && values.provider !== provider) updateValues({ provider });
			return;
		}

		const requestKey = ++ownersRequestKey;
		loadingOwners = true;
		loadError = null;
		try {
			const response = await fetch(
				`/api/scm/accounts?connectionExternalId=${encodeURIComponent(connectionExternalId)}`
			);
			if (!response.ok) throw new Error('Failed to load accounts');
			const data = await response.json();
			if (requestKey !== ownersRequestKey) return;
			if (!data.provider) {
				throw new Error('Selected connection is missing a usable access token. Reconnect it and try again.');
			}
			owners = data.owners || [];
			ownerCache.set(cacheKey, owners);
			const provider = data.provider || providerForConnection(connectionExternalId);
			if (provider && values.provider !== provider) {
				updateValues({ provider });
			}
			if (!values.owner && owners.length > 0) {
				const defaultOwner = owners[0].login;
				updateValues({ owner: defaultOwner, sender: defaultOwner });
				if (hasRepoField) {
					await loadRepos(connectionExternalId, defaultOwner);
				}
			}
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'Failed to load owners';
			owners = [];
		} finally {
			if (requestKey === ownersRequestKey) loadingOwners = false;
		}
	}

	async function loadRepos(connectionExternalId: string, owner: string) {
		const cacheKey = `${connectionExternalId}:${owner}`;
		const cached = repoCache.get(cacheKey);
		if (cached) {
			repos = cached;
			if (!customRepoMode && values.repo && !cached.some((repo) => repo.name === values.repo)) {
				updateValues({ repo: '' });
			}
			return;
		}

		const requestKey = ++reposRequestKey;
		loadingRepos = true;
		loadError = null;
		try {
			const params = new URLSearchParams({ connectionExternalId, owner });
			const response = await fetch(`/api/scm/repos?${params}`);
			if (!response.ok) throw new Error('Failed to load repositories');
			const data = await response.json();
			if (requestKey !== reposRequestKey) return;
			repos = data.repos || [];
			repoCache.set(cacheKey, repos);
			if (!customRepoMode && values.repo && !repos.some((repo) => repo.name === values.repo)) {
				updateValues({ repo: '' });
			}
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'Failed to load repositories';
		} finally {
			if (requestKey === reposRequestKey) loadingRepos = false;
		}
	}

	async function loadIssues(connectionExternalId: string, owner: string, repo: string) {
		const cacheKey = `${connectionExternalId}:${owner}:${repo}`;
		const cached = issueCache.get(cacheKey);
		if (cached) {
			issues = cached;
			return;
		}

		const requestKey = ++issuesRequestKey;
		loadingIssues = true;
		loadError = null;
		try {
			const params = new URLSearchParams({ connectionExternalId, owner, repo });
			const response = await fetch(`/api/scm/issues?${params}`);
			if (!response.ok) throw new Error('Failed to load issues');
			const data = await response.json();
			if (requestKey !== issuesRequestKey) return;
			issues = data.issues || [];
			issueCache.set(cacheKey, issues);
		} catch (error) {
			loadError = error instanceof Error ? error.message : 'Failed to load issues';
		} finally {
			if (requestKey === issuesRequestKey) loadingIssues = false;
		}
	}

	async function selectConnection(connectionExternalId: string) {
		const provider = providerForConnection(connectionExternalId);
		owners = [];
		repos = [];
		issues = [];
		customRepoMode = false;
		updateValues({
			connectionExternalId,
			provider,
			owner: '',
			repo: '',
			issue_number: null,
			title: '',
			body: '',
			sender: ''
		});
		await loadOwners(connectionExternalId);
	}

	async function selectOwner(nextOwner: string) {
		repos = [];
		issues = [];
		customRepoMode = false;
		updateValues({
			owner: nextOwner,
			sender: nextOwner,
			repo: '',
			issue_number: null,
			title: '',
			body: ''
		});
		if (values.connectionExternalId) {
			await loadRepos(values.connectionExternalId, nextOwner);
		}
	}

	async function selectRepo(nextRepo: string) {
		if (nextRepo === '__custom__') {
			customRepoMode = true;
			updateValues({
				repo: generateRepositoryName(),
				issue_number: null,
				title: '',
				body: ''
			});
			return;
		}

		customRepoMode = false;
		issues = [];
		updateValues({
			repo: nextRepo,
			issue_number: null,
			title: '',
			body: ''
		});
		if (mode === 'issue' && values.connectionExternalId && values.owner) {
			await loadIssues(values.connectionExternalId, values.owner, nextRepo);
		}
	}

	function selectIssue(issueNum: number) {
		const issue = issues.find((entry) => entry.number === issueNum);
		updateValues({
			issue_number: issueNum,
			title: issue?.title || '',
			body: issue?.body || ''
		});
	}
</script>

<div class="space-y-3">
	{#if loadError}
		<Alert variant="destructive">
			<AlertDescription>{loadError}</AlertDescription>
		</Alert>
	{/if}

	<div class="min-w-0 space-y-1.5">
		<Label>
			SCM Connection <span class="text-destructive">*</span>
			{#if loadingConnections}<Loader2 size={12} class="inline animate-spin ml-1" />{/if}
		</Label>
		<Select.Root
			type="single"
			value={values.connectionExternalId}
			onValueChange={(connectionExternalId) => selectConnection(connectionExternalId)}
			disabled={loadingConnections || connections.length === 0}
		>
			<Select.Trigger class="w-full max-w-full min-w-0 overflow-hidden">
				<span class={`block min-w-0 flex-1 truncate ${!values.connectionExternalId ? 'text-muted-foreground' : ''}`}>
					{#if values.connectionExternalId}
						{getConnectionLabel(connections.find((connection) => connection.externalId === values.connectionExternalId))}
					{:else if loadingConnections}
						Loading connections...
					{:else if connections.length === 0}
						No GitHub or Gitea connections available
					{:else}
						Select a connection...
					{/if}
				</span>
			</Select.Trigger>
			<Select.Content class={selectContentClass}>
				{#each connections as connection}
					<Select.Item value={connection.externalId}>
						<span class="block max-w-[calc(100%-1.5rem)] min-w-0 truncate">
							{getConnectionLabel(connection)}
						</span>
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</div>

	{#if values.provider}
		<div class="min-w-0 space-y-1.5">
			<Label>Provider</Label>
			<Input value={values.provider === 'gitea' ? 'Gitea' : 'GitHub'} readonly />
		</div>
	{/if}

	{#if hasOwnerField}
		<div class="space-y-1.5">
			<Label>
				Owner <span class="text-destructive">*</span>
				{#if loadingOwners}<Loader2 size={12} class="inline animate-spin ml-1" />{/if}
			</Label>
			{#if canSelectOwner}
				<Select.Root
					type="single"
					value={values.owner}
					onValueChange={(nextOwner) => selectOwner(nextOwner)}
					disabled={loadingOwners}
				>
					<Select.Trigger class="w-full max-w-full min-w-0 overflow-hidden">
						<span class={`block min-w-0 flex-1 truncate ${!values.owner ? 'text-muted-foreground' : ''}`}>
							{values.owner || 'Select owner...'}
						</span>
					</Select.Trigger>
					<Select.Content class={selectContentClass}>
						{#each owners as owner}
							<Select.Item value={owner.login}>
								<span class="block max-w-[calc(100%-1.5rem)] min-w-0 truncate">{owner.label}</span>
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			{:else}
				<Input
					value={values.owner}
					oninput={(event) => updateValues({ owner: event.currentTarget.value, sender: event.currentTarget.value })}
					placeholder="Repository owner"
				/>
			{/if}
		</div>
	{/if}

	{#if hasRepoField}
		<div class="min-w-0 space-y-1.5">
			<Label>
				Repository <span class="text-destructive">*</span>
				{#if loadingRepos}<Loader2 size={12} class="inline animate-spin ml-1" />{/if}
			</Label>
			{#if customRepoMode}
				<div class="min-w-0 space-y-2">
					<div class="flex min-w-0 gap-2">
						<Input
							class="min-w-0 flex-1"
							value={values.repo}
							oninput={(event) => updateValues({ repo: event.currentTarget.value })}
							placeholder="New repository name"
						/>
						<button
							type="button"
							class="inline-flex shrink-0 items-center gap-1 rounded-md border border-input bg-background px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
							onclick={() => updateValues({ repo: generateRepositoryName() })}
							title="Generate another unique repository name"
						>
							<RefreshCw size={12} />
							Regenerate
						</button>
					</div>
					<button
						type="button"
						class="text-xs text-muted-foreground underline-offset-2 hover:underline"
						onclick={() => {
							customRepoMode = false;
							updateValues({ repo: '' });
						}}
					>
						Choose from existing repositories
					</button>
				</div>
			{:else}
				<Select.Root
					type="single"
					value={values.repo}
					onValueChange={(nextRepo) => selectRepo(nextRepo)}
					disabled={loadingRepos || (!values.owner && !values.connectionExternalId)}
				>
					<Select.Trigger class="w-full max-w-full min-w-0 overflow-hidden">
						<span class={`block min-w-0 flex-1 truncate ${!values.repo ? 'text-muted-foreground' : ''}`}>
							{#if values.repo}
								{values.repo}
							{:else if !values.owner}
								Select owner first
							{:else if loadingRepos}
								Loading repositories...
							{:else if repos.length === 0}
								No repositories found
							{:else}
								Select repository...
							{/if}
						</span>
					</Select.Trigger>
					<Select.Content class={selectContentClass}>
						{#each repos as repo}
							<Select.Item value={repo.name}>
								<span class="block max-w-[calc(100%-1.5rem)] min-w-0 truncate">
									{repo.name}{repo.description ? ` — ${repo.description}` : ''}
								</span>
							</Select.Item>
						{/each}
						{#if mode === 'create'}
							<Select.Item value="__custom__">
								<span class="block max-w-[calc(100%-1.5rem)] min-w-0 truncate">Use a new repository name...</span>
							</Select.Item>
						{/if}
					</Select.Content>
				</Select.Root>
			{/if}
		</div>
	{/if}

	{#if hasIssueField}
		<div class="min-w-0 space-y-1.5">
			<Label>
				Issue <span class="text-destructive">*</span>
				{#if loadingIssues}<Loader2 size={12} class="inline animate-spin ml-1" />{/if}
			</Label>
			<Select.Root
				type="single"
				value={values.issue_number?.toString() || ''}
				onValueChange={(nextIssue) => selectIssue(Number(nextIssue))}
				disabled={loadingIssues || issues.length === 0 || !values.repo}
			>
				<Select.Trigger class="w-full max-w-full min-w-0 overflow-hidden">
					<span class={`block min-w-0 flex-1 truncate ${!values.issue_number ? 'text-muted-foreground' : ''}`}>
						{#if values.issue_number}
							#{values.issue_number} — {issues.find((issue) => issue.number === values.issue_number)?.title || ''}
						{:else if !values.repo}
							Select repository first
						{:else if loadingIssues}
							Loading issues...
						{:else if issues.length === 0}
							No open issues
						{:else}
							Select issue...
						{/if}
					</span>
				</Select.Trigger>
				<Select.Content class={selectContentClass}>
					{#each issues as issue}
						<Select.Item value={issue.number.toString()}>
							<span class="block max-w-[calc(100%-1.5rem)] min-w-0 truncate">#{issue.number} — {issue.title}</span>
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>

		<div class="space-y-1.5">
			<Label>Title <span class="text-destructive">*</span></Label>
			<Input
				value={values.title}
				oninput={(event) => updateValues({ title: event.currentTarget.value })}
				placeholder="Issue title"
			/>
		</div>

		<div class="space-y-1.5">
			<Label>Body <span class="text-destructive">*</span></Label>
			<Textarea
				value={values.body}
				oninput={(event) => updateValues({ body: event.currentTarget.value })}
				rows={4}
				placeholder="Issue body / description"
			/>
		</div>
	{/if}
</div>
