<script lang="ts">
	import * as Sheet from '$lib/components/ui/sheet';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import { Copy, Check, ExternalLink, Loader2 } from 'lucide-svelte';

	type InstanceDetail = {
		id: string;
		instanceId: string;
		repo: string | null;
		baseCommit: string | null;
		problemStatement: string | null;
		hintsText: string | null;
		testMetadata: Record<string, unknown> | null;
		goldPatch: string | null;
		metadata: Record<string, unknown> | null;
		suiteSlug: string;
		suiteName: string;
	};

	type Props = {
		open: boolean;
		instanceId: string | null;
		suiteSlug: string | null;
		onOpenChange: (next: boolean) => void;
	};

	let {
		open = $bindable(false),
		instanceId,
		suiteSlug,
		onOpenChange
	}: Props = $props();

	let detail = $state<InstanceDetail | null>(null);
	let loading = $state(false);
	let errorMessage = $state<string | null>(null);
	let activeTab = $state<'problem' | 'tests' | 'gold' | 'hints'>('problem');
	let copied = $state<string | null>(null);

	const fetchKey = $derived(open && suiteSlug && instanceId ? `${suiteSlug}::${instanceId}` : null);

	$effect(() => {
		if (!open || !suiteSlug || !instanceId) {
			detail = null;
			errorMessage = null;
			return;
		}
		void load(suiteSlug, instanceId);
	});

	async function load(slug: string, id: string) {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch(
				`/api/benchmarks/instances/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`
			);
			if (!res.ok) throw new Error(`Failed to load instance (${res.status})`);
			const body = (await res.json()) as { instance: InstanceDetail };
			detail = body.instance;
			activeTab = 'problem';
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function copyToClipboard(key: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = key;
			setTimeout(() => {
				if (copied === key) copied = null;
			}, 1200);
		} catch {
			// noop
		}
	}

	const failToPass = $derived.by(() => {
		const md = detail?.testMetadata ?? {};
		const v =
			(md as Record<string, unknown>).FAIL_TO_PASS ??
			(md as Record<string, unknown>).fail_to_pass;
		return Array.isArray(v) ? (v as string[]) : [];
	});
	const passToPass = $derived.by(() => {
		const md = detail?.testMetadata ?? {};
		const v =
			(md as Record<string, unknown>).PASS_TO_PASS ??
			(md as Record<string, unknown>).pass_to_pass;
		return Array.isArray(v) ? (v as string[]) : [];
	});
	const testPatch = $derived.by(() => {
		const md = detail?.testMetadata ?? {};
		const v = (md as Record<string, unknown>).test_patch;
		return typeof v === 'string' ? v : '';
	});
	const versionField = $derived.by(() => {
		const md = detail?.testMetadata ?? {};
		const v = (md as Record<string, unknown>).version;
		return v != null ? String(v) : null;
	});
	const envSetupCommit = $derived.by(() => {
		const md = detail?.testMetadata ?? {};
		const v = (md as Record<string, unknown>).environment_setup_commit;
		return typeof v === 'string' ? v : null;
	});
</script>

<Sheet.Root {open} {onOpenChange}>
	<Sheet.Content side="right" class="w-full sm:max-w-2xl flex flex-col">
		<Sheet.Header class="space-y-2">
			<div class="flex items-center justify-between gap-3">
				<Sheet.Title class="font-mono text-sm break-all">
					{instanceId ?? '—'}
				</Sheet.Title>
				{#if detail}
					<div class="flex items-center gap-1.5">
						<Badge variant="default" class="text-[10px]">{detail.suiteName}</Badge>
						<Button
							variant="ghost"
							size="sm"
							class="h-6 w-6 p-0"
							onclick={() => copyToClipboard('id', detail!.instanceId)}
							aria-label="Copy instance ID"
						>
							{#if copied === 'id'}
								<Check class="h-3 w-3 text-emerald-500" />
							{:else}
								<Copy class="h-3 w-3" />
							{/if}
						</Button>
					</div>
				{/if}
			</div>
			<Sheet.Description class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
				{#if detail}
					{#if detail.repo}
						<span class="font-mono">{detail.repo}</span>
						<a
							href={`https://github.com/${detail.repo}`}
							target="_blank"
							rel="noreferrer"
							class="inline-flex items-center gap-0.5 text-primary hover:underline"
						>
							<ExternalLink class="h-3 w-3" />
						</a>
					{/if}
					{#if detail.baseCommit}
						<span>base <code class="font-mono">{detail.baseCommit.slice(0, 12)}</code></span>
					{/if}
					{#if envSetupCommit}
						<span>env-setup <code class="font-mono">{envSetupCommit.slice(0, 12)}</code></span>
					{/if}
					{#if versionField}
						<span>v{versionField}</span>
					{/if}
				{/if}
			</Sheet.Description>
		</Sheet.Header>

		<div class="flex-1 overflow-hidden flex flex-col">
			{#if loading}
				<div class="flex flex-1 items-center justify-center">
					<Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
				</div>
			{:else if errorMessage}
				<div class="px-4 py-6 text-sm text-destructive">{errorMessage}</div>
			{:else if !detail}
				<div class="px-4 py-6 text-sm text-muted-foreground">No instance loaded.</div>
			{:else}
				<Tabs value={activeTab} onValueChange={(v) => (activeTab = v as typeof activeTab)} class="flex-1 flex flex-col overflow-hidden">
					<TabsList class="mx-4 mt-2 h-9">
						<TabsTrigger value="problem" class="text-xs">Problem</TabsTrigger>
						<TabsTrigger value="tests" class="text-xs">
							Tests
							<span class="ml-1 text-muted-foreground tabular-nums">
								{failToPass.length}/{passToPass.length}
							</span>
						</TabsTrigger>
						<TabsTrigger value="gold" class="text-xs">
							Gold patch
							{#if !detail.goldPatch}
								<span class="ml-1 text-muted-foreground">—</span>
							{/if}
						</TabsTrigger>
						{#if detail.hintsText}
							<TabsTrigger value="hints" class="text-xs">Hints</TabsTrigger>
						{/if}
					</TabsList>

					<div class="flex-1 overflow-y-auto px-4 py-3">
						<TabsContent value="problem" class="m-0">
							{#if detail.problemStatement}
								<pre class="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-foreground">{detail.problemStatement}</pre>
							{:else}
								<p class="text-sm text-muted-foreground">No problem statement available.</p>
							{/if}
						</TabsContent>

						<TabsContent value="tests" class="m-0 space-y-4">
							<section>
								<div class="flex items-center justify-between mb-1.5">
									<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
										FAIL_TO_PASS <span class="ml-1 tabular-nums">({failToPass.length})</span>
									</h3>
									{#if failToPass.length > 0}
										<Button
											variant="ghost"
											size="sm"
											class="h-6 px-2 text-[11px]"
											onclick={() => copyToClipboard('f2p', failToPass.join('\n'))}
										>
											{#if copied === 'f2p'}
												<Check class="h-3 w-3 text-emerald-500" />
											{:else}
												<Copy class="h-3 w-3" />
											{/if}
										</Button>
									{/if}
								</div>
								{#if failToPass.length === 0}
									<p class="text-xs text-muted-foreground">None.</p>
								{:else}
									<ul class="space-y-0.5 rounded border border-border bg-muted/20 p-2 max-h-40 overflow-y-auto">
										{#each failToPass as t (t)}
											<li class="font-mono text-[11px] text-foreground">{t}</li>
										{/each}
									</ul>
								{/if}
							</section>

							<section>
								<div class="flex items-center justify-between mb-1.5">
									<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
										PASS_TO_PASS <span class="ml-1 tabular-nums">({passToPass.length})</span>
									</h3>
									{#if passToPass.length > 0}
										<Button
											variant="ghost"
											size="sm"
											class="h-6 px-2 text-[11px]"
											onclick={() => copyToClipboard('p2p', passToPass.join('\n'))}
										>
											{#if copied === 'p2p'}
												<Check class="h-3 w-3 text-emerald-500" />
											{:else}
												<Copy class="h-3 w-3" />
											{/if}
										</Button>
									{/if}
								</div>
								{#if passToPass.length === 0}
									<p class="text-xs text-muted-foreground">None.</p>
								{:else}
									<ul class="space-y-0.5 rounded border border-border bg-muted/20 p-2 max-h-40 overflow-y-auto">
										{#each passToPass as t (t)}
											<li class="font-mono text-[11px] text-muted-foreground">{t}</li>
										{/each}
									</ul>
								{/if}
							</section>

							{#if testPatch}
								<section>
									<div class="flex items-center justify-between mb-1.5">
										<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
											Test patch
										</h3>
										<Button
											variant="ghost"
											size="sm"
											class="h-6 px-2 text-[11px]"
											onclick={() => copyToClipboard('testpatch', testPatch)}
										>
											{#if copied === 'testpatch'}
												<Check class="h-3 w-3 text-emerald-500" />
											{:else}
												<Copy class="h-3 w-3" />
											{/if}
										</Button>
									</div>
									<pre class="whitespace-pre-wrap rounded border border-border bg-muted/30 p-2 font-mono text-[11px] leading-snug max-h-72 overflow-y-auto">{testPatch}</pre>
								</section>
							{/if}
						</TabsContent>

						<TabsContent value="gold" class="m-0">
							{#if detail.goldPatch}
								<div class="flex items-center justify-end mb-1.5">
									<Button
										variant="ghost"
										size="sm"
										class="h-6 px-2 text-[11px]"
										onclick={() => copyToClipboard('gold', detail!.goldPatch ?? '')}
									>
										{#if copied === 'gold'}
											<Check class="h-3 w-3 text-emerald-500" />
										{:else}
											<Copy class="h-3 w-3" />
										{/if}
										Copy
									</Button>
								</div>
								<pre class="whitespace-pre-wrap rounded border border-border bg-muted/30 p-3 font-mono text-[11px] leading-snug">{detail.goldPatch}</pre>
							{:else}
								<p class="text-sm text-muted-foreground">No gold patch recorded for this instance.</p>
							{/if}
						</TabsContent>

						{#if detail.hintsText}
							<TabsContent value="hints" class="m-0">
								<pre class="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-foreground">{detail.hintsText}</pre>
							</TabsContent>
						{/if}
					</div>
				</Tabs>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
