<script lang="ts">
	import { onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		Card,
		CardContent,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import ResourceListShell from '$lib/components/console/resource-list-shell.svelte';
	import { Check, Code2, Copy, ExternalLink, Layers, RefreshCw } from '@lucide/svelte';
	import { page } from '$app/state';

	const slug = $derived((page.params.slug as string) ?? 'default');

	type BatchRow = {
		id: string;
		createdAt: string;
		processingStatus: string;
		requestCounts: {
			processing?: number;
			succeeded?: number;
			errored?: number;
			canceled?: number;
			expired?: number;
		};
	};

	type Lang = 'python' | 'typescript' | 'curl';

	let batches = $state<BatchRow[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let search = $state('');
	let language = $state<Lang>('python');
	let copied = $state(false);

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/v1/batches');
			if (res.status === 404 || res.status === 501) {
				// Batches API not yet proxied — empty state.
				batches = [];
				return;
			}
			if (!res.ok) {
				errorMessage = `Failed to load batches (${res.status})`;
				return;
			}
			const body = (await res.json()) as { batches?: BatchRow[] };
			batches = body.batches ?? [];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	const filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return batches;
		return batches.filter(
			(b) =>
				b.id.toLowerCase().includes(q) ||
				b.processingStatus.toLowerCase().includes(q)
		);
	});

	const template = $derived.by<string>(() => {
		switch (language) {
			case 'typescript':
				return `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // defaults to ANTHROPIC_API_KEY env var

const batch = await client.messages.batches.create({
	requests: [
		{
			custom_id: "first-prompt-in-my-batch",
			params: {
				model: "claude-haiku-4-5-20251001",
				max_tokens: 100,
				messages: [
					{ role: "user", content: "Tell me a fun fact about video games." }
				]
			}
		},
		{
			custom_id: "second-prompt-in-my-batch",
			params: {
				model: "claude-haiku-4-5-20251001",
				max_tokens: 100,
				messages: [
					{ role: "user", content: "Tell me a fun fact about bees." }
				]
			}
		}
	]
});

console.log(batch.id);
`;
			case 'curl':
				return `curl https://api.anthropic.com/v1/messages/batches \\
	--header "x-api-key: $ANTHROPIC_API_KEY" \\
	--header "anthropic-version: 2023-06-01" \\
	--header "content-type: application/json" \\
	--data '{
		"requests": [
			{
				"custom_id": "first-prompt-in-my-batch",
				"params": {
					"model": "claude-haiku-4-5-20251001",
					"max_tokens": 100,
					"messages": [
						{ "role": "user", "content": "Tell me a fun fact about video games." }
					]
				}
			}
		]
	}'
`;
			default:
				return `import anthropic

client = anthropic.Anthropic()  # uses ANTHROPIC_API_KEY env var

batch = client.messages.batches.create(
	requests=[
		{
			"custom_id": "first-prompt-in-my-batch",
			"params": {
				"model": "claude-haiku-4-5-20251001",
				"max_tokens": 100,
				"messages": [
					{"role": "user", "content": "Tell me a fun fact about video games."}
				],
			},
		},
		{
			"custom_id": "second-prompt-in-my-batch",
			"params": {
				"model": "claude-haiku-4-5-20251001",
				"max_tokens": 100,
				"messages": [
					{"role": "user", "content": "Tell me a fun fact about bees."}
				],
			},
		},
	]
)

print(batch.id)
`;
		}
	});

	async function copyCode() {
		try {
			await navigator.clipboard.writeText(template);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard might be blocked; silently ignore.
		}
	}

	function statusColor(status: string): string {
		switch (status) {
			case 'in_progress':
				return 'bg-blue-500/15 text-blue-600';
			case 'canceling':
				return 'bg-amber-500/15 text-amber-600';
			case 'ended':
				return 'bg-gray-400/15 text-gray-600';
			default:
				return 'bg-muted text-muted-foreground';
		}
	}

	function formatRelative(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return new Date(iso).toLocaleDateString();
	}

	onMount(load);
</script>

<ResourceListShell
	title="Batches"
	subtitle="Submit large prompt batches via the Anthropic Messages Batches API."
	itemLabel="batch"
	itemCount={filtered.length}
	onSearch={(v) => (search = v)}
	primaryLabel="Refresh"
	onPrimary={load}
	{loading}
	{errorMessage}
	isEmpty={batches.length === 0 || filtered.length === 0}
	{content}
	{empty}
/>

{#snippet content()}
	<div class="h-full overflow-y-auto p-6 space-y-2">
		{#each filtered as b (b.id)}
			<Card>
				<CardContent class="py-3">
					<div class="flex items-center justify-between gap-3 flex-wrap">
						<div class="min-w-0 flex-1">
							<code class="text-xs font-mono break-all">{b.id}</code>
							<div class="text-[10px] text-muted-foreground mt-1">
								Created {formatRelative(b.createdAt)}
							</div>
						</div>
						<div class="flex items-center gap-2">
							<span
								class="rounded-full px-2 py-0.5 text-[10px] font-medium {statusColor(
									b.processingStatus
								)}"
							>
								{b.processingStatus}
							</span>
							{#if b.requestCounts.processing}
								<Badge variant="outline" class="text-[10px]">
									{b.requestCounts.processing} in flight
								</Badge>
							{/if}
							{#if b.requestCounts.succeeded}
								<Badge variant="outline" class="text-[10px] text-emerald-600">
									{b.requestCounts.succeeded} ok
								</Badge>
							{/if}
							{#if b.requestCounts.errored}
								<Badge variant="outline" class="text-[10px] text-destructive">
									{b.requestCounts.errored} err
								</Badge>
							{/if}
						</div>
					</div>
				</CardContent>
			</Card>
		{/each}
	</div>
{/snippet}

{#snippet empty()}
	<div class="flex flex-col items-center justify-center text-center py-10 space-y-6">
		<div class="size-20 rounded-full bg-primary/10 flex items-center justify-center mb-2">
			<Layers class="size-10 text-primary" />
		</div>
		<div>
			<h2 class="text-xl font-semibold mb-1">No batches yet</h2>
			<p class="text-muted-foreground max-w-md">
				The Messages Batches API lets you submit up to 100,000 prompts in a single
				request, processed asynchronously at a 50 % discount. Batches ride on your
				existing API key — no new infrastructure to wire up.
			</p>
		</div>

		<Card class="w-full max-w-3xl text-left">
			<CardHeader class="pb-2 flex-row items-center justify-between">
				<CardTitle class="text-sm flex items-center gap-2">
					<Code2 class="size-4" /> Submit your first batch
				</CardTitle>
				<div class="flex items-center gap-1">
					{#each ['python', 'typescript', 'curl'] as lang (lang)}
						<Button
							variant={language === lang ? 'secondary' : 'ghost'}
							size="sm"
							class="h-7 text-[11px] capitalize"
							onclick={() => (language = lang as Lang)}
						>
							{lang}
						</Button>
					{/each}
					<Button
						variant="outline"
						size="sm"
						class="h-7 text-[11px]"
						onclick={copyCode}
					>
						{#if copied}
							<Check class="size-3" /> Copied
						{:else}
							<Copy class="size-3" /> Copy
						{/if}
					</Button>
				</div>
			</CardHeader>
			<CardContent class="pt-2">
				<pre class="text-[11px] overflow-x-auto bg-muted/50 rounded p-3 font-mono whitespace-pre">{template}</pre>
			</CardContent>
		</Card>

		<Alert class="max-w-2xl border-dashed">
			<AlertDescription class="text-xs">
				<RefreshCw class="inline size-3 mr-1" />
				Batch runs complete within ~24 hours. This page auto-lists submitted
				batches under your workspace's API key once the BFF proxies the upstream
				Anthropic batches API. For now it's a quickstart reference;
				<a
					href="https://docs.anthropic.com/en/docs/build-with-claude/batch-processing"
					target="_blank"
					rel="noreferrer"
					class="text-primary underline inline-flex items-center gap-1"
				>
					view the full docs
					<ExternalLink class="inline size-3" />
				</a>
				.
			</AlertDescription>
		</Alert>
	</div>
{/snippet}
