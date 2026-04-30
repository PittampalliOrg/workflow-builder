<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		Card,
		CardContent,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Download, FileText, RefreshCw } from '@lucide/svelte';

	interface Props {
		sessionId: string;
	}

	let { sessionId }: Props = $props();

	type OutputFile = {
		id: string;
		name: string;
		sizeBytes: number;
		contentType: string | null;
		sha1: string | null;
		createdAt: string;
	};

	let files = $state<OutputFile[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch(
				`/api/v1/files?purpose=output&scopeId=${encodeURIComponent(sessionId)}`
			);
			if (!res.ok) {
				errorMessage = `Failed to load outputs (${res.status})`;
				return;
			}
			const body = (await res.json()) as { files: OutputFile[] };
			files = body.files ?? [];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / 1024 / 1024).toFixed(2)} MB`;
	}

	function download(id: string) {
		window.open(`/api/v1/files/${id}/content`, '_blank');
	}

	$effect(() => {
		if (!sessionId) return;
		void load();
		// Light poll every 10s so artifacts written by the agent mid-session
		// show up without a full page reload. Stops when the component dies.
		pollTimer = setInterval(() => {
			void load();
		}, 10_000);
		return () => {
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = null;
		};
	});
</script>

<Card>
	<CardHeader class="pb-2 flex-row items-center justify-between">
		<CardTitle class="text-sm flex items-center gap-2">
			<FileText class="size-3.5" />
			Output artifacts
			{#if files.length > 0}
				<Badge variant="secondary" class="text-[10px]">{files.length}</Badge>
			{/if}
		</CardTitle>
		<Button variant="ghost" size="icon" class="size-6" onclick={load} title="Refresh">
			<RefreshCw class="size-3" />
		</Button>
	</CardHeader>
	<CardContent class="text-xs space-y-2">
		{#if loading && files.length === 0}
			<div class="text-muted-foreground">Loading…</div>
		{:else if errorMessage}
			<div class="text-destructive">{errorMessage}</div>
		{:else if files.length === 0}
			<div class="text-muted-foreground">
				No artifacts yet. Files the agent writes to
				<code>/sandbox/outputs/</code> upload here automatically when the
				session goes idle.
			</div>
		{:else}
			{#each files as f (f.id)}
				<div class="rounded border p-2 flex items-start gap-2">
					<FileText class="size-3.5 text-muted-foreground mt-0.5 shrink-0" />
					<div class="flex-1 min-w-0 space-y-0.5">
						<div class="font-medium truncate">{f.name}</div>
						<div class="flex items-center flex-wrap gap-x-2 text-[10px] text-muted-foreground">
							<span>{formatBytes(f.sizeBytes)}</span>
							{#if f.contentType}
								<span class="truncate">{f.contentType}</span>
							{/if}
							{#if f.sha1}
								<span class="font-mono">sha {f.sha1.slice(0, 8)}</span>
							{/if}
						</div>
					</div>
					<Button
						variant="ghost"
						size="icon"
						class="size-6 shrink-0"
						title="Download"
						onclick={() => download(f.id)}
					>
						<Download class="size-3" />
					</Button>
				</div>
			{/each}
		{/if}
	</CardContent>
</Card>
