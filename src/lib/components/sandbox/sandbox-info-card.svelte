<script lang="ts">
	import { page } from '$app/state';
	import { DEFAULT_WORKSPACE_SLUG } from '$lib/utils/workspace-path';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import SandboxPhaseBadge from './sandbox-phase-badge.svelte';
	import SandboxConditions from './sandbox-conditions.svelte';
	import { Loader2, ExternalLink, Copy, Check, Terminal as TerminalIcon } from '@lucide/svelte';
	import type { Sandbox } from '$lib/types/sandbox';

	interface Props {
		sandboxName: string;
	}

	let { sandboxName }: Props = $props();

	let detail = $state.raw<Record<string, unknown> | null>(null);
	let linkedExecutions = $state.raw<Array<{
		executionId: string;
		workflowId: string;
		workflowName: string;
		status: string;
		startedAt: string | null;
	}>>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let copiedCmd = $state<string | null>(null);
	const slug = $derived(
		(page.params.slug as string | undefined) ?? DEFAULT_WORKSPACE_SLUG,
	);

	$effect(() => {
		loading = true;
		Promise.allSettled([
			fetch(`/api/sandboxes/${encodeURIComponent(sandboxName)}`)
				.then((r) => (r.ok ? r.json() : null)),
			fetch(`/api/sandboxes/${encodeURIComponent(sandboxName)}/executions`)
				.then((r) => (r.ok ? r.json() : []))
		]).then(([detailRes, execsRes]) => {
			detail = detailRes.status === 'fulfilled' ? detailRes.value : null;
			linkedExecutions = execsRes.status === 'fulfilled' ? (execsRes.value ?? []) : [];
			loading = false;
		});
	});

	const sshCmd = $derived(`openshell sandbox ssh ${sandboxName}`);
	const execCmd = $derived(`openshell sandbox exec ${sandboxName} -- `);

	async function copyCommand(cmd: string) {
		await navigator.clipboard.writeText(cmd);
		copiedCmd = cmd;
		setTimeout(() => (copiedCmd = null), 2000);
	}

	function formatTimestamp(ts: string | number | undefined): string {
		if (!ts) return '-';
		try {
			const d = new Date(typeof ts === 'number' ? ts : ts);
			return d.toLocaleString('en-US', {
				month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
			});
		} catch {
			return String(ts);
		}
	}
</script>

{#if loading}
	<div class="flex items-center justify-center py-12">
		<Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
	</div>
{:else if error}
	<div class="py-12 text-center text-sm text-muted-foreground">
		Failed to load sandbox details.
	</div>
{:else if detail}
	<div class="space-y-6">
		<!-- Metadata Card -->
		<div class="rounded-lg border border-border p-4">
			<h3 class="mb-3 text-sm font-semibold">Sandbox Details</h3>
			<div class="grid grid-cols-2 gap-3 text-sm">
				<div>
					<span class="text-muted-foreground">Name</span>
					<p class="font-mono">{detail.name ?? sandboxName}</p>
				</div>
				<div>
					<span class="text-muted-foreground">Phase</span>
					<p><SandboxPhaseBadge phase={(detail.phase as Sandbox['phase']) ?? 'UNKNOWN'} /></p>
				</div>
				<div>
					<span class="text-muted-foreground">Type</span>
					<p><Badge variant="outline" class="text-xs">{detail.type ?? 'openshell'}</Badge></p>
				</div>
				<div>
					<span class="text-muted-foreground">Namespace</span>
					<p class="font-mono">{detail.namespace ?? '-'}</p>
				</div>
				{#if detail.id}
					<div>
						<span class="text-muted-foreground">ID</span>
						<p class="truncate font-mono text-xs" title={String(detail.id)}>{detail.id}</p>
					</div>
				{/if}
				{#if detail.image}
					<div>
						<span class="text-muted-foreground">Image</span>
						<p class="truncate font-mono text-xs" title={String(detail.image)}>{detail.image}</p>
					</div>
				{/if}
				{#if detail.runtime && typeof detail.runtime === 'object'}
					{@const runtime = detail.runtime as Record<string, unknown>}
					<div>
						<span class="text-muted-foreground">Dapr App ID</span>
						<p class="font-mono">{runtime.appId ?? '-'}</p>
					</div>
					<div>
						<span class="text-muted-foreground">State Store</span>
						<p class="font-mono">{runtime.stateStore ?? '-'}</p>
					</div>
					<div>
						<span class="text-muted-foreground">Service</span>
						<p class="truncate font-mono text-xs" title={String(runtime.serviceUrl ?? '')}>{runtime.serviceName ?? runtime.serviceUrl ?? '-'}</p>
					</div>
				{/if}
				{#if detail.createdAt || detail.created}
					<div>
						<span class="text-muted-foreground">Created</span>
						<p>{formatTimestamp(String(detail.createdAt ?? detail.created))}</p>
					</div>
				{/if}
				{#if detail.current_policy_version}
					<div>
						<span class="text-muted-foreground">Policy Version</span>
						<p>{detail.current_policy_version}</p>
					</div>
				{/if}
			</div>
		</div>

		<!-- Providers -->
		{#if Array.isArray(detail.providers) && detail.providers.length > 0}
			<div class="rounded-lg border border-border p-4">
				<h3 class="mb-3 text-sm font-semibold">Providers</h3>
				<div class="flex flex-wrap gap-2">
					{#each detail.providers as provider}
						<Badge variant="secondary">{provider}</Badge>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Linked Executions -->
		{#if linkedExecutions.length > 0}
			<div class="rounded-lg border border-border p-4">
				<h3 class="mb-3 text-sm font-semibold">Linked Executions</h3>
				<div class="space-y-2">
					{#each linkedExecutions as exec}
						<a
							href="/workspaces/{slug}/workflows/{exec.workflowId}/runs/{exec.executionId}"
							class="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
						>
							<div class="flex items-center gap-2">
								<Badge variant={exec.status === 'success' ? 'secondary' : exec.status === 'error' ? 'destructive' : 'default'}>
									{exec.status}
								</Badge>
								<span class="font-medium">{exec.workflowName}</span>
							</div>
							<div class="flex items-center gap-2 text-xs text-muted-foreground">
								<span>{exec.startedAt ? formatTimestamp(exec.startedAt) : ''}</span>
								<ExternalLink class="h-3 w-3" />
							</div>
						</a>
					{/each}
				</div>
			</div>
		{/if}

		{#if detail.type === 'agent-runtime'}
			<div class="rounded-lg border border-border p-4">
				<h3 class="mb-3 text-sm font-semibold">Runtime Management</h3>
				<p class="text-sm text-muted-foreground">
					This sandbox is a long-lived Kubernetes-managed agent runtime. Use workflows with
					<code>{detail.name ?? sandboxName}</code> as the agent runtime; lifecycle changes are applied through the stacks deployment configuration.
				</p>
				{#if detail.runtime && typeof detail.runtime === 'object'}
					{@const runtime = detail.runtime as Record<string, unknown>}
					{#if Array.isArray(runtime.tools) && runtime.tools.length > 0}
						<div class="mt-3 flex flex-wrap gap-2">
							{#each runtime.tools as tool}
								<Badge variant="secondary">{tool}</Badge>
							{/each}
						</div>
					{/if}
				{/if}
			</div>
		{:else}
			<!-- Connect -->
			<div class="rounded-lg border border-border p-4">
				<h3 class="mb-3 text-sm font-semibold">Connect</h3>
				<div class="space-y-2">
					<div class="flex items-center gap-2 rounded bg-zinc-950 px-3 py-2">
						<code class="flex-1 font-mono text-xs text-zinc-300">{sshCmd}</code>
						<button onclick={() => copyCommand(sshCmd)} class="text-zinc-500 hover:text-zinc-300">
							{#if copiedCmd === sshCmd}
								<Check class="h-3.5 w-3.5 text-green-400" />
							{:else}
								<Copy class="h-3.5 w-3.5" />
							{/if}
						</button>
					</div>
					<div class="flex items-center gap-2 rounded bg-zinc-950 px-3 py-2">
						<code class="flex-1 font-mono text-xs text-zinc-300">{execCmd}<span class="text-zinc-500">{'<command>'}</span></code>
						<button onclick={() => copyCommand(execCmd)} class="text-zinc-500 hover:text-zinc-300">
							{#if copiedCmd === execCmd}
								<Check class="h-3.5 w-3.5 text-green-400" />
							{:else}
								<Copy class="h-3.5 w-3.5" />
							{/if}
						</button>
					</div>
				</div>
			</div>
		{/if}

		<!-- Conditions -->
		{#if Array.isArray(detail.conditions) && detail.conditions.length > 0}
			<SandboxConditions conditions={detail.conditions} />
		{/if}
	</div>
{/if}
