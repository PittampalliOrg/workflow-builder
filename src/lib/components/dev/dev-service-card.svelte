<script lang="ts">
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { ExternalLink, Loader2, Play, RefreshCw } from '@lucide/svelte';
	import type { DevEnvironmentSummary } from '$lib/components/dev/dev-environment-card.svelte';

	// B5: one per-service card on the environment detail page — health, sidecar
	// /__status (via the BFF proxy route), and run-command buttons for the
	// registry's allowlisted named commands (deps + testCommands).

	type SidecarStatus = {
		ok: boolean;
		dest?: string;
		lastSyncAt?: string | null;
		lastSyncBytes?: number | null;
		commands?: string[];
	};
	type StatusResponse = {
		service: string;
		status:
			| { ok: true; data: SidecarStatus }
			| { ok: false; reason: string; message?: string };
		allowedCommands: string[];
	};
	type RunResponse = {
		service: string;
		cmd: string;
		result:
			| {
					ok: true;
					data: {
						ok: boolean;
						cmd: string;
						exitCode: number | null;
						durationMs: number | null;
						truncated: boolean;
						output: string;
					};
			  }
			| { ok: false; reason: string; message?: string };
	};

	let { service }: { service: DevEnvironmentSummary } = $props();

	let sidecar = $state<SidecarStatus | null>(null);
	let sidecarFailure = $state<string | null>(null);
	let allowedCommands = $state<string[]>([]);
	let statusLoading = $state(false);
	let runningCmd = $state<string | null>(null);
	let runOutput = $state<{ cmd: string; ok: boolean; exitCode: number | null; output: string } | null>(
		null
	);

	async function loadStatus() {
		statusLoading = true;
		try {
			const res = await fetch(
				`/api/dev-environments/${service.executionId}/services/${encodeURIComponent(service.service)}/sidecar-status`
			);
			if (!res.ok) {
				sidecarFailure = `status unavailable (${res.status})`;
				return;
			}
			const body = (await res.json()) as StatusResponse;
			allowedCommands = body.allowedCommands ?? [];
			if (body.status.ok) {
				sidecar = body.status.data;
				sidecarFailure = null;
			} else {
				sidecar = null;
				sidecarFailure = `${body.status.reason}${body.status.message ? `: ${body.status.message}` : ''}`;
			}
		} catch (err) {
			sidecarFailure = err instanceof Error ? err.message : 'status request failed';
		} finally {
			statusLoading = false;
		}
	}

	async function run(cmd: string) {
		if (runningCmd) return;
		runningCmd = cmd;
		runOutput = null;
		try {
			const res = await fetch(
				`/api/dev-environments/${service.executionId}/services/${encodeURIComponent(service.service)}/run`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ cmd })
				}
			);
			const body = (await res.json().catch(() => null)) as RunResponse | null;
			if (!res.ok || !body) {
				runOutput = { cmd, ok: false, exitCode: null, output: `run failed (${res.status})` };
				return;
			}
			if (body.result.ok) {
				runOutput = {
					cmd,
					ok: body.result.data.ok,
					exitCode: body.result.data.exitCode,
					output: body.result.data.output
				};
			} else {
				runOutput = {
					cmd,
					ok: false,
					exitCode: null,
					output: `${body.result.reason}${body.result.message ? `: ${body.result.message}` : ''}`
				};
			}
		} catch (err) {
			runOutput = {
				cmd,
				ok: false,
				exitCode: null,
				output: err instanceof Error ? err.message : 'run request failed'
			};
		} finally {
			runningCmd = null;
		}
	}

	// The sidecar's own command list wins when present (it reflects what the pod
	// actually allows); the registry allowlist is the fallback before first load.
	const commands = $derived(sidecar?.commands?.length ? sidecar.commands : allowedCommands);

	onMount(() => {
		void loadStatus();
	});
</script>

<div class="rounded-lg border p-3 space-y-2">
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-2 min-w-0">
			<span
				class="size-2 shrink-0 rounded-full {service.ready ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}"
			></span>
			<span class="font-medium truncate">{service.service}</span>
			{#if service.daprAppId}
				<Badge variant="outline" class="text-[10px] font-mono">{service.daprAppId}</Badge>
			{/if}
		</div>
		<div class="flex items-center gap-1 shrink-0">
			{#if service.browseUrl}
				<a
					href={service.browseUrl}
					target="_blank"
					rel="noreferrer"
					class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
				>
					open <ExternalLink class="size-3" />
				</a>
			{/if}
			<Button
				size="icon"
				variant="ghost"
				class="size-7"
				onclick={() => void loadStatus()}
				title="Refresh sidecar status"
			>
				{#if statusLoading}<Loader2 class="size-3.5 animate-spin" />{:else}<RefreshCw
						class="size-3.5"
					/>{/if}
			</Button>
		</div>
	</div>

	<div class="text-xs text-muted-foreground space-y-0.5">
		{#if sidecar}
			<p>
				sidecar ok
				{#if sidecar.lastSyncAt}
					· last sync {new Date(sidecar.lastSyncAt).toLocaleTimeString()}
					{#if sidecar.lastSyncBytes != null}({Math.round(sidecar.lastSyncBytes / 1024)} KiB){/if}
				{:else}
					· no sync yet
				{/if}
			</p>
		{:else if sidecarFailure}
			<p>sidecar: {sidecarFailure}</p>
		{:else}
			<p>sidecar status loading…</p>
		{/if}
	</div>

	{#if commands.length > 0}
		<div class="flex flex-wrap items-center gap-1.5">
			{#each commands as cmd (cmd)}
				<Button
					size="sm"
					variant="outline"
					class="h-7 text-xs"
					disabled={runningCmd !== null || !service.ready}
					onclick={() => void run(cmd)}
				>
					{#if runningCmd === cmd}<Loader2 class="size-3 animate-spin" />{:else}<Play
							class="size-3"
						/>{/if}
					{cmd}
				</Button>
			{/each}
		</div>
	{/if}

	{#if runOutput}
		<div class="space-y-1">
			<p class="text-xs {runOutput.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}">
				{runOutput.cmd}: {runOutput.ok ? 'ok' : 'failed'}
				{#if runOutput.exitCode != null}(exit {runOutput.exitCode}){/if}
			</p>
			{#if runOutput.output}
				<pre class="max-h-48 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-snug">{runOutput.output}</pre>
			{/if}
		</div>
	{/if}
</div>
