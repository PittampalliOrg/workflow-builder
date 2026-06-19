<!--
  Renders all workflow_artifacts rows for an execution, grouped by slot.
  Primary artifacts render fully expanded with title/description above each.
  Secondary + aux groups collapse by default (clickable header to expand).

  Consumed by the run-detail Outputs tab and (a primary-only subset) by
  the Overview tab.
-->
<script lang="ts">
	import { ChevronDown, ChevronRight, FileText, Code2, Image, Link as LinkIcon, Layers, Rows3, Target, AppWindow } from "@lucide/svelte";
	import ArtifactRenderer from "./artifact-renderer.svelte";

	type Artifact = {
		id: string;
		nodeId: string | null;
		slot: "primary" | "secondary" | "aux" | null;
		kind: string;
		title: string;
		description: string | null;
		inlinePayload: unknown;
		fileId: string | null;
		contentType: string | null;
		metadata: Record<string, unknown> | null;
		createdAt: string | Date;
	};

	interface Props {
		artifacts: Artifact[];
		// "all" lists everything grouped; "primary" only renders primary slot
		// (used on the Overview tab to feature the headline outputs).
		mode?: "all" | "primary";
	}

	let { artifacts, mode = "all" }: Props = $props();

	const grouped = $derived.by(() => {
		const out: Record<string, Artifact[]> = { primary: [], secondary: [], aux: [], other: [] };
		for (const a of artifacts) {
			const bucket = a.slot && (a.slot in out) ? a.slot : "other";
			out[bucket].push(a);
		}
		return out;
	});

	function iconForKind(kind: string) {
		if (kind === "markdown" || kind === "text") return FileText;
		if (kind === "json" || kind === "table") return Code2;
		if (kind === "image") return Image;
		if (kind === "html") return AppWindow;
		if (kind === "link") return LinkIcon;
		if (kind === "card") return Layers;
		if (kind === "goal_spec") return Target;
		return Rows3;
	}

	let secondaryOpen = $state(true);
	let auxOpen = $state(false);
	let otherOpen = $state(false);
</script>

{#if mode === "primary"}
	{#if grouped.primary.length === 0}
		<div class="text-sm text-muted-foreground italic">No primary outputs declared for this execution.</div>
	{:else}
		<div class="grid gap-4">
			{#each grouped.primary as a (a.id)}
				{@const Icon = iconForKind(a.kind)}
				<section class="rounded border p-3 bg-card">
					<header class="mb-2 flex items-start justify-between gap-2">
						<div class="flex items-center gap-2">
							<Icon class="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
							<div>
								<h3 class="text-sm font-semibold">{a.title}</h3>
								{#if a.description}<p class="text-xs text-muted-foreground">{a.description}</p>{/if}
							</div>
						</div>
						<span class="text-xs text-muted-foreground font-mono shrink-0">{a.kind}</span>
					</header>
					<ArtifactRenderer
						kind={a.kind}
						title={a.title}
						description={a.description}
						inlinePayload={a.inlinePayload}
						fileId={a.fileId}
						contentType={a.contentType}
						metadata={a.metadata}
					/>
				</section>
			{/each}
		</div>
	{/if}
{:else}
	{#if artifacts.length === 0}
		<div class="text-sm text-muted-foreground italic p-3">No artifacts persisted for this execution.</div>
	{:else}
		<div class="grid gap-3">
			<!-- primary: always open -->
			{#if grouped.primary.length > 0}
				<div class="grid gap-3">
					{#each grouped.primary as a (a.id)}
						{@const Icon = iconForKind(a.kind)}
						<section class="rounded border p-3 bg-card">
							<header class="mb-2 flex items-start justify-between gap-2">
								<div class="flex items-center gap-2">
									<Icon class="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
									<div>
										<h3 class="text-sm font-semibold">{a.title}</h3>
										{#if a.description}<p class="text-xs text-muted-foreground">{a.description}</p>{/if}
										{#if a.nodeId}<p class="text-[10px] text-muted-foreground font-mono">node: {a.nodeId}</p>{/if}
									</div>
								</div>
								<span class="text-xs text-muted-foreground font-mono shrink-0">{a.kind}</span>
							</header>
							<ArtifactRenderer
								kind={a.kind}
								title={a.title}
								description={a.description}
								inlinePayload={a.inlinePayload}
								fileId={a.fileId}
								contentType={a.contentType}
								metadata={a.metadata}
							/>
						</section>
					{/each}
				</div>
			{/if}

			<!-- secondary: open by default -->
			{#if grouped.secondary.length > 0}
				<button
					type="button"
					onclick={() => (secondaryOpen = !secondaryOpen)}
					class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
				>
					{#if secondaryOpen}<ChevronDown class="h-3.5 w-3.5" />{:else}<ChevronRight class="h-3.5 w-3.5" />{/if}
					Secondary outputs ({grouped.secondary.length})
				</button>
				{#if secondaryOpen}
					<div class="grid gap-2 pl-4 border-l">
						{#each grouped.secondary as a (a.id)}
							<section class="rounded border p-2 bg-card">
								<header class="mb-1.5 flex items-start justify-between gap-2">
									<div>
										<h4 class="text-xs font-medium">{a.title}</h4>
										{#if a.description}<p class="text-[10px] text-muted-foreground">{a.description}</p>{/if}
									</div>
									<span class="text-[10px] text-muted-foreground font-mono shrink-0">{a.kind}</span>
								</header>
								<ArtifactRenderer kind={a.kind} title={a.title} description={a.description} inlinePayload={a.inlinePayload} fileId={a.fileId} contentType={a.contentType} metadata={a.metadata} />
							</section>
						{/each}
					</div>
				{/if}
			{/if}

			<!-- aux: collapsed by default -->
			{#if grouped.aux.length > 0}
				<button
					type="button"
					onclick={() => (auxOpen = !auxOpen)}
					class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
				>
					{#if auxOpen}<ChevronDown class="h-3.5 w-3.5" />{:else}<ChevronRight class="h-3.5 w-3.5" />{/if}
					Auxiliary outputs ({grouped.aux.length})
				</button>
				{#if auxOpen}
					<div class="grid gap-2 pl-4 border-l">
						{#each grouped.aux as a (a.id)}
							<section class="rounded border p-2 bg-card">
								<header class="mb-1.5 flex items-start justify-between gap-2">
									<div>
										<h4 class="text-xs font-medium">{a.title}</h4>
										{#if a.description}<p class="text-[10px] text-muted-foreground">{a.description}</p>{/if}
										{#if a.nodeId}<p class="text-[9px] text-muted-foreground font-mono">node: {a.nodeId}</p>{/if}
									</div>
									<span class="text-[10px] text-muted-foreground font-mono shrink-0">{a.kind}</span>
								</header>
								<ArtifactRenderer kind={a.kind} title={a.title} description={a.description} inlinePayload={a.inlinePayload} fileId={a.fileId} contentType={a.contentType} metadata={a.metadata} />
							</section>
						{/each}
					</div>
				{/if}
			{/if}

			<!-- other: collapsed by default -->
			{#if grouped.other.length > 0}
				<button
					type="button"
					onclick={() => (otherOpen = !otherOpen)}
					class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
				>
					{#if otherOpen}<ChevronDown class="h-3.5 w-3.5" />{:else}<ChevronRight class="h-3.5 w-3.5" />{/if}
					Unsorted outputs ({grouped.other.length})
				</button>
				{#if otherOpen}
					<div class="grid gap-2 pl-4 border-l">
						{#each grouped.other as a (a.id)}
							<section class="rounded border p-2 bg-card">
								<header class="mb-1.5 flex items-start justify-between gap-2">
									<div><h4 class="text-xs font-medium">{a.title}</h4></div>
									<span class="text-[10px] text-muted-foreground font-mono shrink-0">{a.kind}</span>
								</header>
								<ArtifactRenderer kind={a.kind} title={a.title} description={a.description} inlinePayload={a.inlinePayload} fileId={a.fileId} contentType={a.contentType} metadata={a.metadata} />
							</section>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	{/if}
{/if}
