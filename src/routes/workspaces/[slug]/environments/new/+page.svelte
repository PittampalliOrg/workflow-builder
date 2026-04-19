<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { ArrowLeft, Sparkles } from 'lucide-svelte';
	import type { EnvironmentConfig } from '$lib/types/environments';
	import { page } from '$app/state';

	const slug = $derived((page.params.slug as string) ?? 'default');

	type Template = {
		slug: string;
		name: string;
		description: string;
		avatar: string;
		config: Partial<EnvironmentConfig>;
		baseEnvSlug: string | null;
		highlights: string[];
	};

	const templates: Template[] = [
		{
			slug: 'dapr-agent-default',
			name: 'Default sandbox',
			description: 'Inherits the dapr-agent built-in image, unrestricted networking, no extra packages.',
			avatar: '🧱',
			config: {
				sandboxMode: 'per-run',
				keepAfterRun: false,
				ttlSeconds: 7200,
				networking: { type: 'unrestricted' }
			},
			baseEnvSlug: 'dapr-agent',
			highlights: ['Inherits dapr-agent', 'per-run sandboxes', 'unrestricted egress']
		},
		{
			slug: 'dapr-agent-xlsx',
			name: 'Office docs sandbox',
			description: 'Inherits dapr-agent-xlsx for Excel/Word/PowerPoint workflows.',
			avatar: '📊',
			config: {
				sandboxMode: 'per-run',
				keepAfterRun: false,
				ttlSeconds: 7200,
				networking: { type: 'unrestricted' }
			},
			baseEnvSlug: 'dapr-agent-xlsx',
			highlights: ['Inherits dapr-agent-xlsx', 'openpyxl + python-docx + python-pptx preinstalled']
		},
		{
			slug: 'locked-down',
			name: 'Locked-down sandbox',
			description: 'Default image with Limited networking — only the hosts you list are reachable.',
			avatar: '🔒',
			config: {
				sandboxMode: 'per-run',
				keepAfterRun: false,
				ttlSeconds: 7200,
				networking: { type: 'limited', allowedHosts: [] }
			},
			baseEnvSlug: 'dapr-agent',
			highlights: ['Egress restricted to an allow-list', 'Edit hosts in the Networking tab']
		}
	];

	let selected = $state<string | null>(null);
	let blank = $state(false);
	let name = $state('');
	let creating = $state(false);
	let errorMessage = $state<string | null>(null);

	let chosen = $derived(templates.find((t) => t.slug === selected) ?? null);

	async function submit() {
		creating = true;
		errorMessage = null;
		try {
			const config = blank || !chosen ? undefined : chosen.config;
			const baseEnvSlug = blank || !chosen ? undefined : chosen.baseEnvSlug;
			const res = await fetch('/api/v1/environments', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: name.trim() || chosen?.name || 'Untitled Environment',
					config,
					baseEnvSlug
				})
			});
			if (!res.ok) {
				errorMessage = `Create failed (${res.status})`;
				return;
			}
			const { environment } = await res.json();
			goto(`/workspaces/${slug}/environments/${environment.id}`);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			creating = false;
		}
	}
</script>

<div class="max-w-5xl mx-auto w-full p-6 flex flex-col gap-6">
	<div class="flex items-center gap-2">
		<Button variant="ghost" size="sm" onclick={() => goto(`/workspaces/${slug}/environments`)}>
			<ArrowLeft class="size-4" /> Back
		</Button>
		<h1 class="text-2xl font-semibold">New Environment</h1>
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
							<div
								class="size-10 rounded bg-primary/10 flex items-center justify-center text-xl"
							>
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
				<div class="text-xs text-muted-foreground">
					Default config — tweak in the editor.
				</div>
			</button>
		</div>

		<Card>
			<CardHeader>
				<CardTitle class="flex items-center gap-2">
					<Sparkles class="size-4" /> Preview
				</CardTitle>
				<CardDescription>
					{chosen
						? chosen.description
						: blank
							? 'A minimal environment you can configure from scratch.'
							: 'Select a template.'}
				</CardDescription>
			</CardHeader>
			<CardContent class="space-y-4">
				<div>
					<Label for="env-name">Name</Label>
					<Input
						id="env-name"
						bind:value={name}
						placeholder={chosen?.name ?? 'My environment'}
						class="mt-1"
					/>
				</div>
				{#if chosen}
					<div>
						<div class="text-xs font-medium text-muted-foreground mb-2">What you get</div>
						<ul class="text-sm space-y-1">
							{#each chosen.highlights as h}
								<li class="flex items-start gap-2">
									<span class="text-primary">•</span>
									<span>{h}</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
				<div class="pt-4">
					<Button
						class="w-full"
						disabled={(!selected && !blank) || creating}
						onclick={submit}
					>
						{creating ? 'Creating…' : 'Create environment'}
					</Button>
				</div>
			</CardContent>
		</Card>
	</div>
</div>
