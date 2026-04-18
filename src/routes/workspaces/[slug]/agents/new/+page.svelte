<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { ArrowLeft, Sparkles } from 'lucide-svelte';

	const slug = $derived((page.params.slug as string) ?? 'default');

	type Template = {
		slug: string;
		name: string;
		description: string;
		avatar: string;
		tags: string[];
		highlights: string[];
	};

	const templates: Template[] = [
		{
			slug: 'default-sandbox-agent',
			name: 'General Assistant',
			description: 'Workspace tools only. A good starting point for most agents.',
			avatar: '🤖',
			tags: ['general'],
			highlights: ['execute_command, read_file, write_file', 'No MCP servers', 'Default sandbox']
		},
		{
			slug: 'github-mcp-agent',
			name: 'GitHub / Code Agent',
			description: 'GitHub MCP access for repository discovery and code navigation.',
			avatar: '👨‍💻',
			tags: ['code', 'mcp'],
			highlights: [
				'GitHub MCP server preset',
				'Read-only repository tools',
				'Workspace + MCP combined'
			]
		},
		{
			slug: 'browser-testing-agent',
			name: 'Browser Testing Agent',
			description: 'Playwright + Chrome DevTools MCP for browser automation.',
			avatar: '🌐',
			tags: ['testing', 'browser'],
			highlights: ['Playwright MCP', 'Chrome DevTools', 'Screenshot + validation tools']
		},
		{
			slug: 'full-testing-agent',
			name: 'Full Testing Agent',
			description: 'Workspace tools + browser automation for end-to-end app demos.',
			avatar: '🧪',
			tags: ['testing'],
			highlights: ['All workspace tools', 'Browser MCP suite', 'E2E validation flows']
		}
	];

	const preselected = page.url.searchParams.get('template');
	let selected = $state<string | null>(
		templates.some((t) => t.slug === preselected) ? preselected : null
	);
	let blank = $state(false);
	let name = $state('');
	let creating = $state(false);
	let errorMessage = $state<string | null>(null);

	let chosenTemplate = $derived(templates.find((t) => t.slug === selected) ?? null);

	async function submit() {
		creating = true;
		errorMessage = null;
		try {
			const url = blank || !selected ? '/api/agents' : `/api/agents?fromTemplate=${selected}`;
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: name.trim() || chosenTemplate?.name || 'Untitled Agent'
				})
			});
			if (!res.ok) {
				errorMessage = `Create failed (${res.status})`;
				return;
			}
			const { agent } = await res.json();
			goto(`/workspaces/${slug}/agents/${agent.id}`);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			creating = false;
		}
	}
</script>

<div class="max-w-5xl mx-auto w-full p-6 flex flex-col gap-6">
	<div class="flex items-center gap-2">
		<Button variant="ghost" size="sm" onclick={() => goto(`/workspaces/${slug}/agents`)}>
			<ArrowLeft class="size-4" /> Back
		</Button>
		<h1 class="text-2xl font-semibold">New Agent</h1>
	</div>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	<div class="grid grid-cols-1 md:grid-cols-[2fr_3fr] gap-6">
		<div class="space-y-3">
			<h2 class="text-sm font-medium text-muted-foreground">Pick a template</h2>
			{#each templates as tpl}
				<Card
					class="cursor-pointer hover:border-primary transition-colors {selected === tpl.slug &&
					!blank
						? 'border-primary ring-1 ring-primary'
						: ''}"
				>
					<button
						type="button"
						class="w-full text-left"
						onclick={() => {
							selected = tpl.slug;
							blank = false;
							if (!name.trim()) name = tpl.name;
						}}
					>
						<CardHeader class="flex-row items-center gap-3 space-y-0">
							<div class="size-10 rounded bg-primary/10 flex items-center justify-center text-xl">
								{tpl.avatar}
							</div>
							<div class="flex-1 min-w-0">
								<CardTitle class="text-base">{tpl.name}</CardTitle>
								<CardDescription class="text-xs line-clamp-2">
									{tpl.description}
								</CardDescription>
							</div>
						</CardHeader>
					</button>
				</Card>
			{/each}
			<button
				type="button"
				class="w-full rounded border border-dashed p-4 text-left hover:border-primary transition-colors {blank
					? 'border-primary ring-1 ring-primary'
					: ''}"
				onclick={() => {
					blank = true;
					selected = null;
				}}
			>
				<div class="text-sm font-medium">Start from blank</div>
				<div class="text-xs text-muted-foreground">Default tools, no MCP servers, no skills.</div>
			</button>
		</div>

		<Card>
			<CardHeader>
				<CardTitle class="flex items-center gap-2">
					<Sparkles class="size-4" /> Preview
				</CardTitle>
				<CardDescription>
					{chosenTemplate
						? chosenTemplate.description
						: blank
							? 'A minimal agent you can configure from scratch.'
							: 'Select a template to preview what you will create.'}
				</CardDescription>
			</CardHeader>
			<CardContent class="space-y-4">
				<div>
					<Label for="agent-name">Name</Label>
					<Input
						id="agent-name"
						bind:value={name}
						placeholder={chosenTemplate?.name ?? 'My agent'}
						class="mt-1"
					/>
				</div>
				{#if chosenTemplate}
					<div>
						<div class="text-xs font-medium text-muted-foreground mb-2">What you get</div>
						<ul class="text-sm space-y-1">
							{#each chosenTemplate.highlights as h}
								<li class="flex items-start gap-2">
									<span class="text-primary">•</span>
									<span>{h}</span>
								</li>
							{/each}
						</ul>
					</div>
					<div class="flex flex-wrap gap-1">
						{#each chosenTemplate.tags as tag}
							<Badge variant="secondary">#{tag}</Badge>
						{/each}
					</div>
				{/if}
				<div class="pt-4">
					<Button
						class="w-full"
						disabled={(!selected && !blank) || creating}
						onclick={submit}
					>
						{creating ? 'Creating…' : 'Create agent'}
					</Button>
				</div>
			</CardContent>
		</Card>
	</div>
</div>
