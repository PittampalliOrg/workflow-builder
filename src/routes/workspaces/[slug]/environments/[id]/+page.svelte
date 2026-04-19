<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Badge } from '$lib/components/ui/badge';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Switch } from '$lib/components/ui/switch';
	import {
		Tabs,
		TabsContent,
		TabsList,
		TabsTrigger
	} from '$lib/components/ui/tabs';
	import {
		Card,
		CardContent,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import {
		Sheet,
		SheetContent,
		SheetHeader,
		SheetTitle,
		SheetTrigger
	} from '$lib/components/ui/sheet';
	import {
		Popover,
		PopoverContent,
		PopoverTrigger
	} from '$lib/components/ui/popover';
	import ApiSnippet from '$lib/components/console/api-snippet.svelte';
	import EnvironmentOverview from '$lib/components/environments/environment-overview.svelte';
	import {
		ArrowLeft,
		Clock,
		Code2,
		ExternalLink,
		History,
		Save,
		Bot,
		X,
		Plus,
		Hammer,
		FileCode2
	} from 'lucide-svelte';
	import type {
		CmaPackages,
		EnvironmentConfig,
		EnvironmentDetail,
		EnvironmentNetworking,
		EnvironmentNetworkingLimited,
		EnvironmentSummary,
		EnvironmentVersionSummary,
		PackageManager
	} from '$lib/types/environments';
	import { PACKAGE_MANAGERS } from '$lib/types/environments';

	const slug = $derived((page.params.slug as string) ?? 'default');

	const envId = page.params.id as string;

	let env = $state<EnvironmentDetail | null>(null);
	let config = $state<EnvironmentConfig | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let errorMessage = $state<string | null>(null);
	let dirty = $state(false);
	let tab = $state<'overview' | 'basics' | 'networking' | 'packages' | 'build' | 'advanced'>(
		'overview'
	);
	let usages = $state<Array<{ agentId: string; agentName: string; agentSlug: string }>>([]);
	let versions = $state<EnvironmentVersionSummary[]>([]);
	let versionsOpen = $state(false);
	let newHost = $state('');
	let newPkgManager = $state<PackageManager>('pip');
	let newPkgSpec = $state('');
	let newMetaKey = $state('');
	let newMetaValue = $state('');
	// List of other envs available as a base for 1-level inheritance. We fetch
	// the full env list once so the Basics tab's Base-env picker can list other
	// builtins without a per-keystroke roundtrip.
	let allEnvs = $state<EnvironmentSummary[]>([]);
	let dockerfilePreview = $state<string | null>(null);
	let dockerfileLoading = $state(false);
	let building = $state(false);
	let buildMessage = $state<string | null>(null);

	async function load() {
		loading = true;
		try {
			const [a, u, eAll] = await Promise.all([
				fetch(`/api/v1/environments/${envId}`).then((r) => r.json()),
				fetch(`/api/v1/environments/${envId}/usages`)
					.then((r) => r.json())
					.catch(() => ({ usages: [] })),
				fetch('/api/v1/environments')
					.then((r) => r.json())
					.catch(() => ({ environments: [] }))
			]);
			if (a.error) {
				errorMessage = a.error;
				return;
			}
			env = a.environment;
			// structuredClone on a Svelte $state proxy throws DataCloneError — go
			// through JSON to drop the proxy wrappers before re-assigning.
			config = JSON.parse(JSON.stringify(a.environment.config)) as EnvironmentConfig;
			usages = u.usages ?? [];
			allEnvs = eAll.environments ?? [];
			dirty = false;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function loadDockerfilePreview() {
		if (!env) return;
		dockerfileLoading = true;
		try {
			const res = await fetch(`/api/v1/environments/${env.id}/dockerfile-preview`);
			if (res.ok) {
				const data = (await res.json()) as { dockerfile: string };
				dockerfilePreview = data.dockerfile;
			} else {
				dockerfilePreview = `# preview failed: ${res.status}`;
			}
		} catch (err) {
			dockerfilePreview = `# preview failed: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			dockerfileLoading = false;
		}
	}

	async function triggerBuild() {
		if (!env) return;
		building = true;
		buildMessage = null;
		try {
			const res = await fetch(`/api/v1/environments/${env.id}/build`, { method: 'POST' });
			const data = await res.json();
			if (!res.ok) {
				buildMessage = data.error ?? `build failed (${res.status})`;
				return;
			}
			buildMessage = `Queued build: ${(data.commitSha ?? '').slice(0, 12)}`;
			await load();
		} catch (err) {
			buildMessage = err instanceof Error ? err.message : String(err);
		} finally {
			building = false;
		}
	}

	async function loadVersions() {
		const res = await fetch(`/api/v1/environments/${envId}/versions`);
		if (res.ok) {
			const data = await res.json();
			versions = data.versions ?? [];
		}
	}

	async function save() {
		if (!env || !config) return;
		saving = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/v1/environments/${envId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: env.name,
					description: env.description,
					avatar: env.avatar,
					tags: env.tags,
					config
				})
			});
			if (!res.ok) {
				errorMessage = `Save failed (${res.status})`;
				return;
			}
			const { environment: updated } = await res.json();
			env = updated;
			config = JSON.parse(JSON.stringify(updated.config)) as EnvironmentConfig;
			dirty = false;
		} finally {
			saving = false;
		}
	}

	async function restore(version: number) {
		const res = await fetch(`/api/v1/environments/${envId}/versions/${version}`, {
			method: 'POST'
		});
		if (res.ok) {
			await load();
			versionsOpen = false;
		}
	}

	function markDirty() {
		dirty = true;
	}

	function updateConfig<K extends keyof EnvironmentConfig>(
		key: K,
		value: EnvironmentConfig[K]
	) {
		if (!config) return;
		config = { ...config, [key]: value };
		markDirty();
	}

	function setNetworking(next: EnvironmentNetworking) {
		updateConfig('networking', next);
	}

	/** Preserve the current Limited-mode extras (allowedHosts + toggles) across
	 * host edits so the toggle states don't reset when a host is added. */
	function currentLimited(): EnvironmentNetworkingLimited {
		if (config?.networking.type === 'limited') return config.networking;
		return { type: 'limited', allowedHosts: [] };
	}

	function addHost() {
		if (!config || newHost.trim() === '') return;
		if (config.networking.type !== 'limited') return;
		const base = currentLimited();
		const hosts = [...(base.allowedHosts ?? []), newHost.trim()];
		setNetworking({ ...base, allowedHosts: hosts });
		newHost = '';
	}

	function removeHost(host: string) {
		if (!config || config.networking.type !== 'limited') return;
		const base = currentLimited();
		const hosts = (base.allowedHosts ?? []).filter((h) => h !== host);
		setNetworking({ ...base, allowedHosts: hosts });
	}

	function toggleLimitedFlag(flag: 'allowMcpServers' | 'allowPackageManagers', value: boolean) {
		if (!config || config.networking.type !== 'limited') return;
		setNetworking({ ...currentLimited(), [flag]: value });
	}

	function addPackage() {
		if (!config || newPkgSpec.trim() === '') return;
		const spec = newPkgSpec.trim();
		const existing = config.packages ?? {};
		const current = existing[newPkgManager] ?? [];
		// Dedup on spec so re-adding the same row is idempotent.
		if (current.includes(spec)) return;
		const next: CmaPackages = {
			...existing,
			[newPkgManager]: [...current, spec]
		};
		updateConfig('packages', next);
		newPkgSpec = '';
	}

	function removePackage(manager: PackageManager, spec: string) {
		if (!config) return;
		const existing = config.packages ?? {};
		const current = existing[manager] ?? [];
		const filtered = current.filter((s) => s !== spec);
		const next: CmaPackages = { ...existing };
		if (filtered.length === 0) {
			delete next[manager];
		} else {
			next[manager] = filtered;
		}
		updateConfig('packages', next);
	}

	// Flatten {apt: [...], pip: [...]} into a single list for rendering.
	function flattenPackages(pkgs: CmaPackages | undefined): Array<{ manager: PackageManager; spec: string }> {
		const out: Array<{ manager: PackageManager; spec: string }> = [];
		for (const manager of PACKAGE_MANAGERS) {
			const specs = pkgs?.[manager] ?? [];
			for (const spec of specs) out.push({ manager, spec });
		}
		return out;
	}

	function addMetadata() {
		if (!config || newMetaKey.trim() === '' || newMetaValue.trim() === '') return;
		const key = newMetaKey.trim().toLowerCase();
		const meta = { ...(config.metadata ?? {}), [key]: newMetaValue };
		updateConfig('metadata', meta);
		newMetaKey = '';
		newMetaValue = '';
	}

	function removeMetadata(key: string) {
		if (!config) return;
		const meta = { ...(config.metadata ?? {}) };
		delete meta[key];
		updateConfig('metadata', meta);
	}

	// Base-env picker (1-level inheritance). A builtin env — or a user env that
	// itself inherits from root — can be chosen as a parent. We exclude self
	// and archived envs, plus any env that already inherits from this one to
	// prevent cycles (1-level spec forbids chains anyway).
	const baseCandidates = $derived.by(() => {
		if (!env) return [] as EnvironmentSummary[];
		return allEnvs.filter(
			(e) => e.id !== env!.id && !e.isArchived && e.baseEnvSlug === null
		);
	});

	const selectedBase = $derived.by(() => {
		if (!env?.baseEnvSlug) return null;
		return allEnvs.find((e) => e.slug === env!.baseEnvSlug) ?? null;
	});

	async function updateBaseEnv(slug: string | null) {
		if (!env) return;
		saving = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/v1/environments/${env.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ baseEnvSlug: slug })
			});
			if (!res.ok) {
				errorMessage = `Base env save failed (${res.status})`;
				return;
			}
			await load();
		} finally {
			saving = false;
		}
	}

	onMount(() => {
		load();
	});

	$effect(() => {
		if (tab === 'build' && env && dockerfilePreview === null && !dockerfileLoading) {
			loadDockerfilePreview();
		}
	});
</script>

<svelte:window
	onkeydown={(e) => {
		if ((e.metaKey || e.ctrlKey) && e.key === 's') {
			e.preventDefault();
			save();
		}
	}}
/>

<div class="flex flex-col h-screen">
	<header class="border-b p-3 flex items-center gap-3 flex-wrap">
		<Button variant="ghost" size="sm" onclick={() => goto(`/workspaces/${slug}/environments`)}>
			<ArrowLeft class="size-4" />
		</Button>
		<div class="flex items-center gap-2 flex-1 min-w-0">
			<div class="size-8 rounded bg-primary/10 flex items-center justify-center text-base">
				{env?.avatar ?? '🧱'}
			</div>
			<div class="flex-1 min-w-0">
				<Input
					class="border-0 shadow-none h-8 px-2 font-semibold text-base focus-visible:ring-1"
					value={env?.name ?? ''}
					oninput={(e) => {
						if (env) {
							env = { ...env, name: (e.target as HTMLInputElement).value };
							markDirty();
						}
					}}
				/>
				<div class="text-xs text-muted-foreground px-2">
					{env?.slug ?? ''} · v{env?.currentVersion ?? '—'}
					{#if dirty}
						<span class="text-amber-500">· unsaved</span>
					{/if}
				</div>
			</div>
		</div>
		<Sheet bind:open={versionsOpen}>
			<SheetTrigger>
				<Button variant="outline" size="sm" onclick={loadVersions}>
					<History class="size-4" /> History
				</Button>
			</SheetTrigger>
			<SheetContent class="w-[400px] sm:max-w-[400px]">
				<SheetHeader>
					<SheetTitle>Version history</SheetTitle>
				</SheetHeader>
				<div class="mt-4 space-y-2">
					{#each versions as v}
						<div class="flex items-center justify-between p-2 rounded border">
							<div>
								<div class="font-medium text-sm">v{v.version}</div>
								<div class="text-xs text-muted-foreground">
									<Clock class="inline size-3" />
									{new Date(v.createdAt).toLocaleString()}
								</div>
								{#if v.changelog}
									<div class="text-xs mt-1">{v.changelog}</div>
								{/if}
							</div>
							{#if v.version !== env?.currentVersion}
								<Button size="sm" variant="outline" onclick={() => restore(v.version)}>
									Restore
								</Button>
							{:else}
								<Badge variant="secondary">current</Badge>
							{/if}
						</div>
					{/each}
					{#if versions.length === 0}
						<div class="text-sm text-muted-foreground py-8 text-center">
							No history yet.
						</div>
					{/if}
				</div>
			</SheetContent>
		</Sheet>
		<Popover>
			<PopoverTrigger>
				<Button variant="outline" size="sm" title="Show API snippet">
					<Code2 class="size-4" /> Code
				</Button>
			</PopoverTrigger>
			<PopoverContent class="w-[560px] p-3" align="end">
				<div class="text-xs font-semibold mb-1">Use this environment via the API</div>
				<p class="text-xs text-muted-foreground mb-2">
					Reference the environment id when creating or updating an agent.
				</p>
				<ApiSnippet
					curl={`curl -X POST $WORKFLOW_BUILDER_URL/api/agents \\\n  -H 'Authorization: Bearer $WB_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"name":"My agent","environmentId":"${envId}"}'`}
					python={`import requests\n\nres = requests.post(\n    f"{WORKFLOW_BUILDER_URL}/api/agents",\n    headers={"Authorization": f"Bearer {WB_API_KEY}"},\n    json={"name": "My agent", "environmentId": "${envId}"},\n)\nprint(res.json())`}
					typescript={`await fetch(\`\${WORKFLOW_BUILDER_URL}/api/agents\`, {\n  method: 'POST',\n  headers: {\n    Authorization: \`Bearer \${WB_API_KEY}\`,\n    'Content-Type': 'application/json'\n  },\n  body: JSON.stringify({ name: 'My agent', environmentId: '${envId}' })\n});`}
				/>
			</PopoverContent>
		</Popover>
		<Button disabled={!dirty || saving} onclick={save}>
			<Save class="size-4" />
			{saving ? 'Saving…' : 'Save'}
		</Button>
	</header>

	{#if errorMessage}
		<Alert variant="destructive" class="m-3">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	{#if loading || !env || !config}
		<div class="p-6 space-y-4">
			<Skeleton class="h-16" />
			<Skeleton class="h-96" />
		</div>
	{:else}
		<div class="flex-1 grid grid-cols-1 lg:grid-cols-[2fr_1fr] overflow-hidden">
			<div class="overflow-y-auto p-6">
				<Tabs value={tab} onValueChange={(v) => (tab = v as typeof tab)}>
					<TabsList class="mb-4">
						<TabsTrigger value="overview">Overview</TabsTrigger>
						<TabsTrigger value="basics">Basics</TabsTrigger>
						<TabsTrigger value="networking">Networking</TabsTrigger>
						<TabsTrigger value="packages">Packages</TabsTrigger>
						<TabsTrigger value="build">Build</TabsTrigger>
						<TabsTrigger value="advanced">Advanced</TabsTrigger>
					</TabsList>

					<TabsContent value="overview" class="space-y-4">
						{#if env}
							<EnvironmentOverview {env} />
						{/if}
					</TabsContent>

					<TabsContent value="basics" class="space-y-4">
						<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
							<div class="md:col-span-2">
								<Label>Description</Label>
								<Textarea
									rows={2}
									value={env.description ?? ''}
									oninput={(e) => {
										if (!env) return;
										env = {
											...env,
											description: (e.target as HTMLTextAreaElement).value
										};
										markDirty();
									}}
								/>
							</div>
							<div>
								<Label>Avatar (emoji)</Label>
								<Input
									value={env.avatar ?? ''}
									oninput={(e) => {
										if (!env) return;
										env = {
											...env,
											avatar: (e.target as HTMLInputElement).value || null
										};
										markDirty();
									}}
								/>
							</div>
							<div>
								<Label>Tags (comma-separated)</Label>
								<Input
									value={env.tags.join(', ')}
									oninput={(e) => {
										if (!env) return;
										env = {
											...env,
											tags: (e.target as HTMLInputElement).value
												.split(',')
												.map((t) => t.trim())
												.filter(Boolean)
										};
										markDirty();
									}}
								/>
							</div>
						</div>

						<div class="space-y-3 border-t pt-4">
							<h3 class="font-semibold text-sm">Sandbox</h3>
							<div class="grid grid-cols-2 gap-3">
								<div>
									<Label>Base environment</Label>
									<select
										class="w-full mt-1 rounded-md border bg-background px-3 py-2 text-sm"
										value={env.baseEnvSlug ?? ''}
										onchange={(e) => {
											const v = (e.target as HTMLSelectElement).value;
											updateBaseEnv(v === '' ? null : v);
										}}
									>
										<option value="">root (openshell-sandbox)</option>
										{#each baseCandidates as b (b.slug)}
											<option value={b.slug}>
												{b.name} ({b.slug}){b.isBuiltin ? ' · built-in' : ''}
											</option>
										{/each}
									</select>
									<p class="text-[11px] text-muted-foreground mt-1">
										This environment's Dockerfile FROMs the chosen parent. 1-level only;
										parent must inherit from root.
									</p>
								</div>
								<div>
									<Label>Mode</Label>
									<select
										class="w-full mt-1 rounded-md border bg-background px-3 py-2 text-sm"
										value={config.sandboxMode}
										onchange={(e) =>
											updateConfig(
												'sandboxMode',
												(e.target as HTMLSelectElement)
													.value as EnvironmentConfig['sandboxMode']
											)}
									>
										<option value="per-run">per-run</option>
										<option value="per-node">per-node</option>
										<option value="shared-runtime">shared-runtime</option>
										<option value="provided">provided</option>
									</select>
								</div>
								<div class="col-span-2 flex items-center justify-between gap-2 border rounded p-3">
									<div>
										<div class="text-sm font-medium">Keep after run</div>
										<div class="text-xs text-muted-foreground">
											Preserve the sandbox for TTL seconds after the run completes.
										</div>
									</div>
									<Switch
										checked={config.keepAfterRun}
										onCheckedChange={(v) => updateConfig('keepAfterRun', v)}
									/>
								</div>
								<div class="col-span-2">
									<Label>TTL (seconds)</Label>
									<Input
										type="number"
										value={config.ttlSeconds ?? 0}
										oninput={(e) => {
											const n = Number((e.target as HTMLInputElement).value);
											updateConfig('ttlSeconds', Number.isFinite(n) ? n : undefined);
										}}
									/>
									<p class="mt-1 text-xs text-muted-foreground">
										Workspace sandbox TTL — how long the per-run sandbox stays alive after a
										workflow finishes. Distinct from the agent-runtime idle TTL below.
									</p>
								</div>
								<div class="col-span-2">
									<Label>Agent-runtime idle TTL (seconds)</Label>
									<Input
										type="number"
										min="60"
										value={config.agentRuntimeIdleTtlSeconds ?? 1800}
										oninput={(e) => {
											const n = Number((e.target as HTMLInputElement).value);
											updateConfig(
												'agentRuntimeIdleTtlSeconds',
												Number.isFinite(n) && n >= 60 ? n : undefined
											);
										}}
									/>
									<p class="mt-1 text-xs text-muted-foreground">
										Scale the per-agent runtime pod to 0 after this many seconds without a
										session dispatch. Default 1800 (30 min). Minimum 60.
									</p>
								</div>
								{#if selectedBase}
									<div class="col-span-2 rounded border bg-muted/20 p-3 space-y-2">
										<div class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
											Inherits from: {selectedBase.name}
										</div>
										{#if selectedBase.description}
											<p class="text-xs text-muted-foreground">
												{selectedBase.description}
											</p>
										{/if}
										{#if selectedBase.build?.imageTag}
											<div class="font-mono text-[10px] text-muted-foreground truncate">
												{selectedBase.build.imageTag}
											</div>
										{/if}
									</div>
								{/if}
							</div>
						</div>
					</TabsContent>

					<TabsContent value="networking" class="space-y-4">
						<p class="text-sm text-muted-foreground">
							Configure network access policies for this environment.
						</p>
						<div class="space-y-3">
							<Label>Type</Label>
							<div class="grid grid-cols-2 gap-3">
								<button
									type="button"
									class="text-left p-4 rounded border {config.networking.type === 'unrestricted'
										? 'border-primary ring-1 ring-primary'
										: 'hover:border-primary/50'}"
									onclick={() => setNetworking({ type: 'unrestricted' })}
								>
									<div class="font-medium text-sm">Unrestricted</div>
									<div class="text-xs text-muted-foreground">
										Full outbound egress (except platform blocklist).
									</div>
								</button>
								<button
									type="button"
									class="text-left p-4 rounded border {config.networking.type === 'limited'
										? 'border-primary ring-1 ring-primary'
										: 'hover:border-primary/50'}"
									onclick={() =>
										setNetworking({
											type: 'limited',
											allowedHosts:
												config!.networking.type === 'limited'
													? (config!.networking.allowedHosts ?? [])
													: []
										})}
								>
									<div class="font-medium text-sm">Limited</div>
									<div class="text-xs text-muted-foreground">
										Allow-list hosts + optional package-manager / MCP carve-outs.
									</div>
								</button>
							</div>
						</div>

						{#if config.networking.type === 'limited'}
							{@const lim = config.networking}
							<div class="space-y-4 border-t pt-4">
								<div class="flex items-center justify-between">
									<div>
										<div class="text-sm">Allow MCP server network access</div>
										<div class="text-xs text-muted-foreground">
											Permit the sandbox to reach configured MCP endpoints even when
											they're not in the allowed-hosts list.
										</div>
									</div>
									<Switch
										checked={lim.allowMcpServers ?? false}
										onCheckedChange={(v) => toggleLimitedFlag('allowMcpServers', v)}
									/>
								</div>
								<div class="flex items-center justify-between">
									<div>
										<div class="text-sm">Allow package manager network access</div>
										<div class="text-xs text-muted-foreground">
											Permit pip / npm / apt / go / cargo / gem to reach their default
											registries so declared packages can install.
										</div>
									</div>
									<Switch
										checked={lim.allowPackageManagers ?? false}
										onCheckedChange={(v) => toggleLimitedFlag('allowPackageManagers', v)}
									/>
								</div>
								<div class="space-y-2">
									<Label>Allowed hosts</Label>
									<div class="flex gap-2">
										<Input
											placeholder="api.example.com"
											bind:value={newHost}
											onkeydown={(e) => {
												if (e.key === 'Enter') {
													e.preventDefault();
													addHost();
												}
											}}
										/>
										<Button onclick={addHost} disabled={!newHost.trim()}>
											<Plus class="size-4" /> Add
										</Button>
									</div>
									<div class="flex flex-wrap gap-2">
										{#each lim.allowedHosts ?? [] as host}
											<span
												class="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-mono"
											>
												{host}
												<button
													type="button"
													class="text-muted-foreground hover:text-destructive"
													onclick={() => removeHost(host)}
												>
													<X class="size-3" />
												</button>
											</span>
										{/each}
										{#if (lim.allowedHosts ?? []).length === 0}
											<p class="text-xs text-muted-foreground">
												No hosts allowed yet. MCP servers must have their domain listed
												here, or enable "Allow MCP server network access" above.
											</p>
										{/if}
									</div>
								</div>
							</div>
						{/if}
					</TabsContent>

					<TabsContent value="packages" class="space-y-4">
						<p class="text-sm text-muted-foreground">
							Packages are baked into the image at build time. Save, then head to
							the <strong>Build</strong> tab to trigger a rebuild. Install order:
							apt → cargo → gem → go → npm → pip.
						</p>
						<div class="flex gap-2">
							<select
								class="h-9 w-28 shrink-0 rounded border bg-background px-2 text-sm"
								bind:value={newPkgManager}
							>
								{#each PACKAGE_MANAGERS as m}
									<option value={m}>{m}</option>
								{/each}
							</select>
							<Input
								placeholder="package package==1.0.0"
								bind:value={newPkgSpec}
								onkeydown={(e) => {
									if (e.key === 'Enter') {
										e.preventDefault();
										addPackage();
									}
								}}
							/>
							<Button onclick={addPackage} disabled={!newPkgSpec.trim()}>
								<Plus class="size-4" /> Add
							</Button>
						</div>
						{@const flat = flattenPackages(config.packages)}
						<div class="space-y-1.5">
							{#each flat as pkg (pkg.manager + ':' + pkg.spec)}
								<div
									class="flex items-center gap-2 rounded border px-3 py-2 text-sm"
								>
									<Badge variant="outline" class="w-14 justify-center font-mono text-[10px]">
										{pkg.manager}
									</Badge>
									<span class="flex-1 font-mono text-xs">{pkg.spec}</span>
									<button
										type="button"
										class="text-muted-foreground hover:text-destructive"
										onclick={() => removePackage(pkg.manager, pkg.spec)}
									>
										<X class="size-4" />
									</button>
								</div>
							{/each}
							{#if flat.length === 0}
								<p class="text-xs text-muted-foreground">No packages configured.</p>
							{/if}
						</div>

						<div class="border-t pt-4 space-y-2">
							<Label>Metadata</Label>
							<p class="text-xs text-muted-foreground">
								Custom key-value tags. Keys must be lowercase.
							</p>
							<div class="flex gap-2">
								<Input
									placeholder="client_key"
									bind:value={newMetaKey}
									onkeydown={(e) => {
										if (e.key === 'Enter') {
											e.preventDefault();
											addMetadata();
										}
									}}
								/>
								<Input
									placeholder="value"
									bind:value={newMetaValue}
									onkeydown={(e) => {
										if (e.key === 'Enter') {
											e.preventDefault();
											addMetadata();
										}
									}}
								/>
								<Button
									onclick={addMetadata}
									disabled={!newMetaKey.trim() || !newMetaValue.trim()}
								>
									<Plus class="size-4" /> Add
								</Button>
							</div>
							<div class="space-y-1.5">
								{#each Object.entries(config.metadata ?? {}) as [k, v] (k)}
									<div
										class="flex items-center gap-2 rounded border px-3 py-2 text-sm"
									>
										<span class="font-mono text-xs text-muted-foreground">{k}</span>
										<span class="text-muted-foreground/50">=</span>
										<span class="flex-1 font-mono text-xs">{v}</span>
										<button
											type="button"
											class="text-muted-foreground hover:text-destructive"
											onclick={() => removeMetadata(k)}
										>
											<X class="size-4" />
										</button>
									</div>
								{/each}
							</div>
						</div>
					</TabsContent>

					<TabsContent value="build" class="space-y-4">
						<div class="rounded border p-4 space-y-3">
							<div class="flex items-center justify-between gap-3">
								<div>
									<div class="text-sm font-semibold">Image build</div>
									<div class="text-xs text-muted-foreground">
										Rebuild this environment's image. Saves packages first, then
										commits a generated Dockerfile to Gitea — Tekton picks it up
										from there.
									</div>
								</div>
								<Button onclick={triggerBuild} disabled={building || dirty}>
									<Hammer class="size-4" />
									{building ? 'Queuing…' : 'Build'}
								</Button>
							</div>
							{#if dirty}
								<p class="text-xs text-amber-600">Save pending changes before building.</p>
							{/if}
							{#if buildMessage}
								<p class="text-xs text-muted-foreground">{buildMessage}</p>
							{/if}
							<div class="grid grid-cols-2 gap-3 text-xs">
								<div>
									<div class="text-muted-foreground">Status</div>
									<Badge
										variant={env.build?.lastBuildStatus === 'built'
											? 'secondary'
											: env.build?.lastBuildStatus === 'failed'
												? 'destructive'
												: 'outline'}
									>
										{env.build?.lastBuildStatus ?? 'unbuilt'}
									</Badge>
								</div>
								<div>
									<div class="text-muted-foreground">Last build</div>
									<div>
										{env.build?.lastBuildAt
											? new Date(env.build.lastBuildAt).toLocaleString()
											: '—'}
									</div>
								</div>
								<div class="col-span-2">
									<div class="text-muted-foreground">Image tag</div>
									<div class="font-mono text-[11px] truncate">
										{env.build?.imageTag ?? '—'}
									</div>
								</div>
								<div class="col-span-2">
									<div class="text-muted-foreground">Last build SHA</div>
									<div class="font-mono text-[11px] truncate">
										{env.build?.lastBuildSha ?? '—'}
									</div>
								</div>
								{#if env.build?.lastBuildError}
									<div class="col-span-2">
										<div class="text-muted-foreground">Error</div>
										<div class="font-mono text-[11px] text-destructive whitespace-pre-wrap">
											{env.build.lastBuildError}
										</div>
									</div>
								{/if}
							</div>
						</div>

						<div class="rounded border p-4 space-y-2">
							<div class="flex items-center justify-between">
								<div class="flex items-center gap-2">
									<FileCode2 class="size-4" />
									<div class="text-sm font-semibold">Dockerfile preview</div>
								</div>
								<Button
									variant="outline"
									size="sm"
									onclick={loadDockerfilePreview}
									disabled={dockerfileLoading}
								>
									{dockerfileLoading ? 'Loading…' : 'Refresh'}
								</Button>
							</div>
							<p class="text-xs text-muted-foreground">
								Generated from the current packages manifest. This is what gets
								committed to Gitea when you hit Build.
							</p>
							<pre
								class="rounded bg-muted/40 p-3 text-[11px] font-mono overflow-auto max-h-[480px]"
							>{dockerfilePreview ?? (dockerfileLoading ? 'Loading…' : '# Click Refresh to generate preview')}</pre>
						</div>
					</TabsContent>

					<TabsContent value="advanced" class="space-y-4">
						<h3 class="font-semibold text-sm">Resource limits</h3>
						<div class="grid grid-cols-3 gap-3">
							<div>
								<Label>Memory (MB)</Label>
								<Input
									type="number"
									value={config.resourceLimits?.memoryMb ?? ''}
									placeholder="default"
									oninput={(e) => {
										const n = Number((e.target as HTMLInputElement).value);
										updateConfig('resourceLimits', {
											...(config!.resourceLimits ?? {}),
											memoryMb: Number.isFinite(n) && n > 0 ? n : undefined
										});
									}}
								/>
							</div>
							<div>
								<Label>CPU (millicores)</Label>
								<Input
									type="number"
									value={config.resourceLimits?.cpuMillicores ?? ''}
									placeholder="default"
									oninput={(e) => {
										const n = Number((e.target as HTMLInputElement).value);
										updateConfig('resourceLimits', {
											...(config!.resourceLimits ?? {}),
											cpuMillicores: Number.isFinite(n) && n > 0 ? n : undefined
										});
									}}
								/>
							</div>
							<div>
								<Label>Disk (MB)</Label>
								<Input
									type="number"
									value={config.resourceLimits?.diskMb ?? ''}
									placeholder="default"
									oninput={(e) => {
										const n = Number((e.target as HTMLInputElement).value);
										updateConfig('resourceLimits', {
											...(config!.resourceLimits ?? {}),
											diskMb: Number.isFinite(n) && n > 0 ? n : undefined
										});
									}}
								/>
							</div>
						</div>
					</TabsContent>
				</Tabs>
			</div>

			<aside class="border-l overflow-y-auto p-4 space-y-4 bg-muted/30">
				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm flex items-center gap-2">
							<Bot class="size-4" /> Used by ({usages.length})
						</CardTitle>
					</CardHeader>
					<CardContent>
						{#if usages.length === 0}
							<p class="text-xs text-muted-foreground">
								No agents reference this environment yet.
							</p>
						{:else}
							<ul class="space-y-1">
								{#each usages as u}
									<li>
										<a
											href="/workspaces/{slug}/agents/{u.agentId}"
											class="text-sm hover:underline flex items-center gap-1"
										>
											{u.agentName}
											<ExternalLink class="size-3" />
										</a>
									</li>
								{/each}
							</ul>
						{/if}
					</CardContent>
				</Card>
			</aside>
		</div>
	{/if}
</div>
