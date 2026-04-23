<script lang="ts">
	import { page } from '$app/state';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle,
	} from '$lib/components/ui/card';
	import { Puzzle, Files, Layers, Code, Library as LibraryIcon, ArrowRight } from 'lucide-svelte';

	const slug = $derived((page.params.slug as string) ?? 'default');

	// Phase 6 consolidation: Skills / Files / Batches / Custom Code are all
	// authoring catalogs agents + workflows pull from. Grouping them under one
	// sidebar entry matches CMA's "one place for reusable building blocks"
	// pattern. Each card keeps its own URL so deep-links survive.
	const sections = $derived([
		{
			id: 'skills',
			label: 'Skills',
			description:
				'Reusable instruction bundles + allowed-tool policies. Attach to agents for progressive-disclosure context.',
			icon: Puzzle,
			href: `/workspaces/${slug}/skills`,
		},
		{
			id: 'files',
			label: 'Files',
			description:
				'Static inputs agents + workflows read at runtime (prompts, schemas, fixtures, datasets).',
			icon: Files,
			href: `/workspaces/${slug}/files`,
		},
		{
			id: 'batches',
			label: 'Batches',
			description: 'Bulk run a workflow or agent across many inputs; track completion + results.',
			icon: Layers,
			href: `/workspaces/${slug}/batches`,
		},
		{
			id: 'code',
			label: 'Custom code',
			description:
				'TypeScript + Python functions you can call from workflow nodes. Org-scoped; shared across workspaces.',
			icon: Code,
			href: '/code-functions',
			external: true,
		},
	]);
</script>

<svelte:head>
	<title>Library</title>
</svelte:head>

<div class="flex flex-col gap-6 p-6 max-w-5xl mx-auto w-full">
	<header>
		<h1 class="text-2xl font-semibold flex items-center gap-2">
			<LibraryIcon class="size-6" /> Library
		</h1>
		<p class="text-sm text-muted-foreground mt-1">
			Reusable building blocks agents and workflows pull from — skills, static files, batch jobs,
			and custom code.
		</p>
	</header>

	<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
		{#each sections as s (s.id)}
			<a
				href={s.href}
				class="group block"
				target={s.external ? '_blank' : undefined}
				rel={s.external ? 'noopener' : undefined}
			>
				<Card class="h-full transition-colors group-hover:border-primary group-hover:bg-accent/30">
					<CardHeader>
						<div class="flex items-start justify-between gap-2">
							<div class="size-9 rounded-md bg-primary/10 flex items-center justify-center">
								<s.icon class="size-5 text-primary" />
							</div>
							<ArrowRight
								class="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
							/>
						</div>
						<CardTitle class="mt-3 text-base flex items-center gap-1.5">
							{s.label}
							{#if s.external}
								<span class="text-[10px] font-normal text-muted-foreground">(org-scoped)</span>
							{/if}
						</CardTitle>
						<CardDescription class="text-xs leading-relaxed">
							{s.description}
						</CardDescription>
					</CardHeader>
					<CardContent class="pt-0"></CardContent>
				</Card>
			</a>
		{/each}
	</div>
</div>
