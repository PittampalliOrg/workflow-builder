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
	import {
		ArrowLeft,
		Clock,
		Code2,
		ExternalLink,
		History,
		Save,
		Bot,
		X,
		Plus
	} from 'lucide-svelte';
	import type {
		EnvironmentConfig,
		EnvironmentDetail,
		EnvironmentNetworking,
		EnvironmentVersionSummary
	} from '$lib/types/environments';

	const envId = page.params.id as string;

	let env = $state<EnvironmentDetail | null>(null);
	let config = $state<EnvironmentConfig | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let errorMessage = $state<string | null>(null);
	let dirty = $state(false);
	let tab = $state<'basics' | 'networking' | 'packages' | 'advanced'>('basics');
	let usages = $state<Array<{ agentId: string; agentName: string; agentSlug: string }>>([]);
	let versions = $state<EnvironmentVersionSummary[]>([]);
	let versionsOpen = $state(false);
	let newHost = $state('');
	let newPkg = $state('');

	async function load() {
		loading = true;
		try {
			const [a, u] = await Promise.all([
				fetch(`/api/v1/environments/${envId}`).then((r) => r.json()),
				fetch(`/api/v1/environments/${envId}/usages`)
					.then((r) => r.json())
					.catch(() => ({ usages: [] }))
			]);
			if (a.error) {
				errorMessage = a.error;
				return;
			}
			env = a.environment;
			config = structuredClone(a.environment.config);
			usages = u.usages ?? [];
			dirty = false;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
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
			config = structuredClone(updated.config);
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

	function addHost() {
		if (!config || newHost.trim() === '') return;
		if (config.networking.type !== 'allowed_hosts') return;
		const hosts = [...config.networking.allowedHosts, newHost.trim()];
		setNetworking({ type: 'allowed_hosts', allowedHosts: hosts });
		newHost = '';
	}

	function removeHost(host: string) {
		if (!config || config.networking.type !== 'allowed_hosts') return;
		const hosts = config.networking.allowedHosts.filter((h) => h !== host);
		setNetworking({ type: 'allowed_hosts', allowedHosts: hosts });
	}

	function addPackage() {
		if (!config || newPkg.trim() === '') return;
		const pkgs = [...(config.packages ?? []), newPkg.trim()];
		updateConfig('packages', pkgs);
		newPkg = '';
	}

	function removePackage(pkg: string) {
		if (!config) return;
		const pkgs = (config.packages ?? []).filter((p) => p !== pkg);
		updateConfig('packages', pkgs);
	}

	onMount(load);
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
		<Button variant="ghost" size="sm" onclick={() => goto('/environments')}>
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
						<TabsTrigger value="basics">Basics</TabsTrigger>
						<TabsTrigger value="networking">Networking</TabsTrigger>
						<TabsTrigger value="packages">Packages</TabsTrigger>
						<TabsTrigger value="advanced">Advanced</TabsTrigger>
					</TabsList>

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
									<Label>Template</Label>
									<Input
										value={config.sandboxTemplate}
										oninput={(e) =>
											updateConfig(
												'sandboxTemplate',
												(e.target as HTMLInputElement).value
											)}
									/>
									<p class="text-[11px] text-muted-foreground mt-1">
										Matches the container image name (e.g. <code>dapr-agent</code>).
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
								</div>
							</div>
						</div>
					</TabsContent>

					<TabsContent value="networking" class="space-y-4">
						<div class="space-y-3">
							<Label>Mode</Label>
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
									class="text-left p-4 rounded border {config.networking.type ===
									'allowed_hosts'
										? 'border-primary ring-1 ring-primary'
										: 'hover:border-primary/50'}"
									onclick={() =>
										setNetworking({
											type: 'allowed_hosts',
											allowedHosts:
												config!.networking.type === 'allowed_hosts'
													? config!.networking.allowedHosts
													: []
										})}
								>
									<div class="font-medium text-sm">Allowed hosts</div>
									<div class="text-xs text-muted-foreground">
										Lock egress to a list of hostnames (package managers + custom).
									</div>
								</button>
							</div>
						</div>

						{#if config.networking.type === 'allowed_hosts'}
							<div class="space-y-3 border-t pt-4">
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
									{#each config.networking.allowedHosts as host}
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
									{#if config.networking.allowedHosts.length === 0}
										<p class="text-xs text-muted-foreground">
											No hosts allowed yet. MCP servers must have their domain listed here
											or tool calls will silently fail.
										</p>
									{/if}
								</div>
							</div>
						{/if}
					</TabsContent>

					<TabsContent value="packages" class="space-y-4">
						<p class="text-sm text-muted-foreground">
							Packages preinstalled when the sandbox boots. Names map to the underlying package
							manager (pip, apt, etc. — depends on the sandbox template).
						</p>
						<div class="flex gap-2">
							<Input
								placeholder="pandas"
								bind:value={newPkg}
								onkeydown={(e) => {
									if (e.key === 'Enter') {
										e.preventDefault();
										addPackage();
									}
								}}
							/>
							<Button onclick={addPackage} disabled={!newPkg.trim()}>
								<Plus class="size-4" /> Add
							</Button>
						</div>
						<div class="flex flex-wrap gap-2">
							{#each config.packages ?? [] as pkg}
								<span
									class="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-mono"
								>
									{pkg}
									<button
										type="button"
										class="text-muted-foreground hover:text-destructive"
										onclick={() => removePackage(pkg)}
									>
										<X class="size-3" />
									</button>
								</span>
							{/each}
							{#if (config.packages ?? []).length === 0}
								<p class="text-xs text-muted-foreground">No preinstalled packages.</p>
							{/if}
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
											href="/agents/{u.agentId}"
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
