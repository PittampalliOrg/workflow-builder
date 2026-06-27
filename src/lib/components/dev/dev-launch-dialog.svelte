<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
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
		tailnetHost: string;
	}

	let {
		open = $bindable(false),
		services,
		devWorkflowId,
		devWorkflowName,
		onlaunched
	}: {
		open?: boolean;
		services: ServiceCatalogEntry[];
		devWorkflowId: string | null;
		devWorkflowName: string;
		onlaunched: (executionId: string) => void;
	} = $props();

	let selectedService = $state(services[0]?.service ?? 'workflow-builder');
	let repoUrl = $state('');
	let keepAlive = $state(true);
	let launching = $state(false);
	let errorMessage = $state<string | null>(null);

	const descriptor = $derived(services.find((s) => s.service === selectedService) ?? null);

	async function launch() {
		if (!devWorkflowId) {
			errorMessage = `The "${devWorkflowName}" workflow isn't seeded in this workspace yet.`;
			return;
		}
		launching = true;
		errorMessage = null;
		try {
			const input: Record<string, unknown> = {
				service: selectedService,
				keepPreview: keepAlive ? 'true' : 'false'
			};
			if (repoUrl.trim()) input.repoUrl = repoUrl.trim();
			const res = await fetch(`/api/workflows/${devWorkflowId}/execute`, {
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
			onlaunched(data.executionId);
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
			<DialogTitle>Launch dev environment</DialogTitle>
			<DialogDescription>
				Spins up an ephemeral dev-server preview for the service and hands off into an interactive
				coding-agent session sharing the same workspace.
			</DialogDescription>
		</DialogHeader>

		{#if errorMessage}
			<Alert variant="destructive">
				<AlertDescription>{errorMessage}</AlertDescription>
			</Alert>
		{/if}

		<div class="space-y-4 py-1">
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
								<ShieldCheck class="size-3" /> Dapr-shadow (isolated app-id · pubsub-dev · real DB)
							</Badge>
						{/if}
					</div>
				{/if}
			</div>

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

			<div class="flex items-center justify-between rounded-lg border p-3">
				<div class="space-y-0.5">
					<Label for="dev-keepalive">Keep alive after run</Label>
					<p class="text-xs text-muted-foreground">
						Survive workflow completion so you can keep iterating + browsing.
					</p>
				</div>
				<Switch id="dev-keepalive" bind:checked={keepAlive} />
			</div>
		</div>

		<DialogFooter>
			<Button variant="ghost" onclick={() => (open = false)} disabled={launching}>Cancel</Button>
			<Button onclick={launch} disabled={launching || !devWorkflowId}>
				<Rocket class="size-4" />
				{launching ? 'Launching…' : 'Launch'}
			</Button>
		</DialogFooter>
	</DialogContent>
</Dialog>
