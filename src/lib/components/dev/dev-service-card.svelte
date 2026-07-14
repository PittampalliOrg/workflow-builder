<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '$lib/components/ui/collapsible';
	import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '$lib/components/ui/tooltip';
	import { ChevronDown, Cpu, ExternalLink, Loader2, Play, RefreshCw, Server } from '@lucide/svelte';
	import type { DevEnvironmentSummary } from '$lib/components/dev/dev-environment-card.svelte';
	import { relativeTime } from '$lib/components/dev/preview-lifecycle';
	import type { SidecarLastRunView } from '$lib/types/dev-previews';
	import {
		getSidecarStatus,
		runSidecarCmd
	} from '../../../routes/workspaces/[slug]/dev/[executionId]/data.remote';

	// B5: one per-service card on the environment detail page — health, sidecar
	// /__status (via the application sidecar service), and run-command buttons for
	// the registry's allowlisted named commands. Fetched via remote functions;
	// status refreshes on demand and after each run (no blanket polling).

	let { service }: { service: DevEnvironmentSummary } = $props();

	const statusQuery = getSidecarStatus({
		executionId: service.executionId,
		service: service.service
	});
	const view = $derived(statusQuery.current);
	const statusData = $derived(view?.status.ok ? view.status.data : null);
	const statusFailure = $derived(
		view && !view.status.ok
			? `${view.status.reason}${view.status.message ? `: ${view.status.message}` : ''}`
			: null
	);
	// The sidecar's own command list wins (it reflects what the pod allows); the
	// registry allowlist is the fallback before first load.
	const commands = $derived(
		statusData?.commands?.length ? statusData.commands : (view?.allowedCommands ?? [])
	);
	const lastRun = $derived<SidecarLastRunView | null>(statusData?.lastRun ?? null);

	let runningCmd = $state<string | null>(null);
	let runOutput = $state<{
		cmd: string;
		ok: boolean;
		exitCode: number | null;
		output: string;
		executedIn: 'app' | 'sidecar' | null;
	} | null>(null);
	let outputOpen = $state(false);

	async function run(cmd: string) {
		if (runningCmd) return;
		runningCmd = cmd;
		runOutput = null;
		try {
			const res = await runSidecarCmd({
				executionId: service.executionId,
				service: service.service,
				cmd
			});
			if (res.result.ok) {
				const d = res.result.data;
				runOutput = {
					cmd,
					ok: d.ok,
					exitCode: d.exitCode,
					output: d.output,
					executedIn: d.executedIn
				};
			} else {
				runOutput = {
					cmd,
					ok: false,
					exitCode: null,
					output: `${res.result.reason}${res.result.message ? `: ${res.result.message}` : ''}`,
					executedIn: null
				};
			}
		} catch (err) {
			runOutput = {
				cmd,
				ok: false,
				exitCode: null,
				output: err instanceof Error ? err.message : 'run request failed',
				executedIn: null
			};
		} finally {
			runningCmd = null;
			// Auto-open the output on failure; refresh status so lastRun updates.
			if (runOutput && !runOutput.ok) outputOpen = true;
			void statusQuery.refresh();
		}
	}
</script>

<div class="rounded-lg border p-3 space-y-2">
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-2 min-w-0">
			<span
				class="size-2 shrink-0 rounded-full {service.ready
					? 'bg-emerald-500'
					: 'bg-amber-500 animate-pulse'}"
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
				onclick={() => void statusQuery.refresh()}
				title="Refresh sidecar status"
			>
				<RefreshCw class="size-3.5" />
			</Button>
		</div>
	</div>

	<div class="text-xs text-muted-foreground space-y-0.5">
		{#if statusData}
			<p>
				sidecar ok
				{#if statusData.lastSyncAt}
					· last sync {new Date(statusData.lastSyncAt).toLocaleTimeString()}
					{#if statusData.lastSyncBytes != null}({Math.round(statusData.lastSyncBytes / 1024)} KiB){/if}
					{#if statusData.lastSyncTimingsMs}· apply {statusData.lastSyncTimingsMs.total} ms{/if}
				{:else}
					· no sync yet
				{/if}
			</p>
		{:else if statusFailure}
			<p>sidecar: {statusFailure}</p>
		{:else}
			<p>sidecar status loading…</p>
		{/if}
	</div>

	{#if lastRun}
		<div class="flex items-center gap-2 flex-wrap text-[11px]">
			<span class="font-mono text-muted-foreground">last run:</span>
			<span class="font-mono">{lastRun.cmd}</span>
			<Badge
				variant="outline"
				class="text-[10px] {lastRun.exitCode === 0
					? 'text-emerald-600 dark:text-emerald-400'
					: 'text-destructive'}"
			>
				exit {lastRun.exitCode ?? '?'}
			</Badge>
			{#if lastRun.executedIn}
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger>
							<Badge variant="outline" class="text-[10px] gap-1">
								{#if lastRun.executedIn === 'app'}<Cpu class="size-3" />{:else}<Server
										class="size-3"
									/>{/if}
								{lastRun.executedIn}
							</Badge>
						</TooltipTrigger>
						<TooltipContent>
							<p class="max-w-[220px] text-xs">
								{lastRun.executedIn === 'app'
									? 'Ran in the app container via the exec bridge (the real service toolchain).'
									: 'Ran in the node-only dev-sync sidecar (pre-bridge fallback).'}
							</p>
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			{/if}
			{#if lastRun.durationMs != null}
				<span class="text-muted-foreground">{(lastRun.durationMs / 1000).toFixed(1)}s</span>
			{/if}
			{#if relativeTime(lastRun.finishedAt)}
				<span class="text-muted-foreground">{relativeTime(lastRun.finishedAt)}</span>
			{/if}
		</div>
	{/if}

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
		<Collapsible bind:open={outputOpen}>
			<CollapsibleTrigger
				class="flex items-center gap-1 text-xs {runOutput.ok
					? 'text-emerald-600 dark:text-emerald-400'
					: 'text-destructive'}"
			>
				<ChevronDown class="size-3 transition-transform {outputOpen ? '' : '-rotate-90'}" />
				{runOutput.cmd}: {runOutput.ok ? 'ok' : 'failed'}
				{#if runOutput.exitCode != null}(exit {runOutput.exitCode}){/if}
			</CollapsibleTrigger>
			<CollapsibleContent>
				{#if runOutput.output}
					<pre
						class="mt-1 max-h-48 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-snug">{runOutput.output}</pre>
				{/if}
			</CollapsibleContent>
		</Collapsible>
	{/if}
</div>
