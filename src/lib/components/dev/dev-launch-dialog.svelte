<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { NativeSelect, NativeSelectOption } from '$lib/components/ui/native-select';
	import {
		Dialog,
		DialogContent,
		DialogDescription,
		DialogFooter,
		DialogHeader,
		DialogTitle
	} from '$lib/components/ui/dialog';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { ShieldCheck, Rocket } from '@lucide/svelte';

	export interface ServiceCatalogEntry {
		service: string;
		needsDapr: boolean;
		port: number;
		syncMode: string;
		repoUrl: string;
		repoSubdir: string;
		tailnetHost: string | null;
	}

	let {
		open = $bindable(false),
		services,
		previewNativeServices = [],
		previewEnvironment = null,
		devWorkflowId,
		devWorkflowName,
		lifecycleWorkflowId = null,
		lifecycleWorkflowName = 'preview-development-lifecycle',
		onlaunched
	}: {
		open?: boolean;
		services: ServiceCatalogEntry[];
		previewNativeServices?: readonly string[];
		previewEnvironment?: {
			id: string;
			profile: string;
			platformRevision: string | null;
			sourceRevision: string | null;
			origin: string | null;
		} | null;
		devWorkflowId: string | null;
		devWorkflowName: string;
		lifecycleWorkflowId?: string | null;
		lifecycleWorkflowName?: string;
		onlaunched: (executionId: string, lifecycle: boolean) => void;
	} = $props();

	let selectedService = $state(services[0]?.service ?? 'workflow-builder');
	let selectedServices = $state<Record<string, boolean>>({});
	let repoUrl = $state('');
	let environmentName = $state('');
	let intent = $state('');
	let ttlHours = $state(24);
	let keepAlive = $state(previewEnvironment !== null);
	let launching = $state(false);
	let errorMessage = $state<string | null>(null);

	const descriptor = $derived(services.find((s) => s.service === selectedService) ?? null);
	const insideAppPreview = $derived(
		previewEnvironment?.profile === 'app-live' && previewNativeServices.length > 0
	);
	const hostLifecycle = $derived(previewEnvironment === null);
	const effectiveWorkflowId = $derived(
		hostLifecycle ? lifecycleWorkflowId : devWorkflowId
	);
	const effectiveWorkflowName = $derived(
		hostLifecycle ? lifecycleWorkflowName : devWorkflowName
	);
	const selectedPreviewServices = $derived(
		previewNativeServices.filter((service) => selectedServices[service] !== false)
	);

	$effect(() => {
		const next = { ...selectedServices };
		let changed = false;
		for (const service of previewNativeServices) {
			if (!(service in next)) {
				next[service] = true;
				changed = true;
			}
		}
		if (changed) selectedServices = next;
	});

	async function launch() {
		if (!effectiveWorkflowId) {
			errorMessage = `The "${effectiveWorkflowName}" workflow isn't seeded in this workspace yet.`;
			return;
		}
		const requestedServices =
			hostLifecycle || insideAppPreview ? selectedPreviewServices : [selectedService];
		if (requestedServices.length === 0) {
			errorMessage = 'Select at least one service';
			return;
		}
		if (hostLifecycle) {
			if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(environmentName.trim())) {
				errorMessage = 'Enter a valid preview environment name';
				return;
			}
			if (!intent.trim()) {
				errorMessage = 'Describe the work for the development agent';
				return;
			}
			if (!Number.isInteger(ttlHours) || ttlHours < 2 || ttlHours > 24) {
				errorMessage = 'TTL must be an integer from 2 to 24 hours';
				return;
			}
		}
		launching = true;
		errorMessage = null;
		try {
			const input: Record<string, unknown> = hostLifecycle
				? {
						intent: intent.trim(),
						environmentName: environmentName.trim(),
						services: requestedServices,
						ttlHours,
						retainAfterCompletion: keepAlive
					}
				: {
						service: requestedServices[0],
						services: requestedServices,
						keepPreview: keepAlive ? 'true' : 'false',
						...(intent.trim() ? { intent: intent.trim() } : {})
					};
			if (!hostLifecycle && repoUrl.trim()) input.repoUrl = repoUrl.trim();
			const res = await fetch(`/api/dev-environments/workflows/${effectiveWorkflowId}/execute`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ input })
			});
			const data = (await res.json().catch(() => ({}))) as {
				executionId?: string;
				message?: string;
				error?: string;
			};
			if (!res.ok || !data.executionId) {
				errorMessage = data.message || data.error || `Launch failed (${res.status})`;
				return;
			}
			open = false;
			onlaunched(data.executionId, hostLifecycle);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			launching = false;
		}
	}
</script>

<Dialog bind:open>
	<DialogContent class="sm:max-w-lg">
		<DialogHeader>
			<DialogTitle>{hostLifecycle ? 'Start preview development' : 'Launch dev environment'}</DialogTitle>
			<DialogDescription>
				{hostLifecycle
					? 'Provision an isolated app-live environment and start its workflow-backed coding session.'
					: 'Start a hot-reload coding session in this environment.'}
			</DialogDescription>
		</DialogHeader>

		{#if errorMessage}
			<Alert variant="destructive">
				<AlertDescription>{errorMessage}</AlertDescription>
			</Alert>
		{/if}

		<div class="space-y-4 py-1">
			{#if hostLifecycle}
				<div class="grid gap-3 sm:grid-cols-[1fr_7rem]">
					<div class="space-y-1.5">
						<Label for="dev-environment-name">Environment</Label>
						<Input
							id="dev-environment-name"
							placeholder="feature-dashboard"
							maxlength={40}
							bind:value={environmentName}
						/>
					</div>
					<div class="space-y-1.5">
						<Label for="dev-environment-ttl">TTL hours</Label>
						<Input
							id="dev-environment-ttl"
							type="number"
							min="2"
							max="24"
							step="1"
							bind:value={ttlHours}
						/>
					</div>
				</div>

				<div class="space-y-1.5">
					<Label for="dev-intent">Task</Label>
					<Textarea
						id="dev-intent"
						rows={5}
						maxlength={12000}
						placeholder="Describe the code change and expected behavior"
						bind:value={intent}
					/>
				</div>
			{:else}
				<div class="space-y-1.5">
					<Label for="dev-intent">Task <span class="text-muted-foreground">(optional)</span></Label>
					<Textarea
						id="dev-intent"
						rows={4}
						maxlength={12000}
						placeholder="Start immediately with this task, or leave blank for an interactive handoff"
						bind:value={intent}
					/>
				</div>
			{/if}

			{#if insideAppPreview && previewEnvironment}
				<div class="grid gap-1.5 rounded-md border bg-muted/20 p-3 text-xs">
					<div class="flex min-w-0 items-center justify-between gap-3">
						<span class="font-medium">{previewEnvironment.id}</span>
						<Badge variant="outline">preview-native</Badge>
					</div>
					{#if previewEnvironment.platformRevision}
						<code class="truncate text-[10px] text-muted-foreground" title={previewEnvironment.platformRevision}
							>stacks {previewEnvironment.platformRevision}</code
						>
					{/if}
					{#if previewEnvironment.sourceRevision}
						<code class="truncate text-[10px] text-muted-foreground" title={previewEnvironment.sourceRevision}
							>source {previewEnvironment.sourceRevision}</code
						>
					{/if}
				</div>
				<fieldset class="flex flex-wrap gap-x-4 gap-y-2">
					<legend class="mb-1 text-sm font-medium">Services</legend>
					{#each previewNativeServices as service (service)}
						<label class="inline-flex items-center gap-2 text-xs">
							<input
								type="checkbox"
								class="size-4 rounded border-input accent-primary"
								checked={selectedServices[service] !== false}
								onchange={(event) =>
									(selectedServices = {
										...selectedServices,
										[service]: event.currentTarget.checked
									})}
							/>
							{service}
						</label>
					{/each}
				</fieldset>
			{:else if hostLifecycle}
				<fieldset class="flex flex-wrap gap-x-4 gap-y-2">
					<legend class="mb-1 text-sm font-medium">Services</legend>
					{#each previewNativeServices as service (service)}
						<label class="inline-flex items-center gap-2 text-xs">
							<input
								type="checkbox"
								class="size-4 rounded border-input accent-primary"
								checked={selectedServices[service] !== false}
								onchange={(event) =>
									(selectedServices = {
										...selectedServices,
										[service]: event.currentTarget.checked
									})}
							/>
							{service}
						</label>
					{/each}
				</fieldset>
			{:else}
				<div class="space-y-1.5">
					<Label for="dev-service">Service</Label>
					<NativeSelect id="dev-service" bind:value={selectedService} class="w-full">
						{#each services as svc (svc.service)}
							<NativeSelectOption value={svc.service}>{svc.service}</NativeSelectOption>
						{/each}
					</NativeSelect>
					{#if descriptor}
						<div class="flex flex-wrap items-center gap-1.5 pt-1">
							<Badge variant="outline" class="text-[10px] font-mono text-muted-foreground"
								>:{descriptor.port} · {descriptor.syncMode}</Badge
							>
							{#if descriptor.needsDapr}
								<Badge
									variant="outline"
									class="text-[10px] gap-1 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-transparent"
								>
									<ShieldCheck class="size-3" /> Dapr shadow
								</Badge>
							{/if}
						</div>
					{/if}
				</div>
			{/if}

			{#if !hostLifecycle}
				<div class="space-y-1.5">
					<Label for="dev-repo">Repo URL <span class="text-muted-foreground">(optional)</span></Label>
					<Input
						id="dev-repo"
						placeholder={descriptor?.repoUrl ?? 'owner/repo'}
						bind:value={repoUrl}
					/>
					<p class="text-xs text-muted-foreground">
						Defaults to the service's source repo ({descriptor?.repoUrl ?? '—'}).
					</p>
				</div>
			{/if}

			<div class="flex items-center justify-between rounded-lg border p-3">
				<div class="space-y-0.5">
					<Label for="dev-keepalive">{hostLifecycle ? 'Retain after completion' : 'Keep alive after run'}</Label>
					<p class="text-xs text-muted-foreground">
						{hostLifecycle
							? 'Leave the environment available after the PR or discard decision.'
							: 'Survive workflow completion so you can keep iterating and browsing.'}
					</p>
				</div>
				<Switch id="dev-keepalive" bind:checked={keepAlive} />
			</div>
		</div>

		<DialogFooter>
			<Button variant="ghost" onclick={() => (open = false)} disabled={launching}>Cancel</Button>
			<Button
				onclick={launch}
				disabled={
					launching ||
					!effectiveWorkflowId ||
					((hostLifecycle || insideAppPreview) && selectedPreviewServices.length === 0) ||
					(hostLifecycle && (!environmentName.trim() || !intent.trim()))
				}
			>
				<Rocket class="size-4" />
				{launching ? 'Launching…' : hostLifecycle ? 'Provision & start' : 'Launch'}
			</Button>
		</DialogFooter>
	</DialogContent>
</Dialog>
