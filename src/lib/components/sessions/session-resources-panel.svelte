<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import {
		Card,
		CardContent,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import {
		Folder,
		GitBranch,
		Plus,
		Trash2,
		Upload,
		X
	} from 'lucide-svelte';
	import type { SessionResource } from '$lib/types/sessions';

	interface Props {
		sessionId: string;
	}

	let { sessionId }: Props = $props();

	let resources = $state<SessionResource[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let addingRepo = $state(false);
	let repoUrl = $state('');
	let repoRef = $state('main');
	let repoMountPath = $state('/mnt/session/repo');

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}/resources`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { resources: SessionResource[] };
			resources = body.resources ?? [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'failed';
		} finally {
			loading = false;
		}
	}

	async function removeResource(id: string) {
		const res = await fetch(`/api/v1/sessions/${sessionId}/resources/${id}`, {
			method: 'DELETE'
		});
		if (res.ok) {
			await load();
		}
	}

	async function addRepo() {
		if (!repoUrl.trim()) return;
		const res = await fetch(`/api/v1/sessions/${sessionId}/resources`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				type: 'github_repository',
				repoUrl: repoUrl.trim(),
				checkoutRef: repoRef.trim() || 'main',
				mountPath: repoMountPath.trim() || '/mnt/session/repo'
			})
		});
		if (res.ok) {
			repoUrl = '';
			addingRepo = false;
			await load();
		}
	}

	$effect(() => {
		if (sessionId) void load();
	});
</script>

<Card>
	<CardHeader class="pb-2">
		<CardTitle class="text-sm flex items-center gap-2">
			<Folder class="size-3.5" />
			Mounted resources
		</CardTitle>
	</CardHeader>
	<CardContent class="text-xs space-y-2">
		{#if loading}
			<div class="text-muted-foreground">Loading…</div>
		{:else if error}
			<div class="text-destructive">Failed: {error}</div>
		{:else if resources.length === 0 && !addingRepo}
			<div class="text-muted-foreground">No resources mounted.</div>
		{/if}

		{#each resources as r (r.id)}
			<div class="rounded border p-2 flex items-start gap-2">
				<div class="mt-0.5">
					{#if r.type === 'github_repository'}
						<GitBranch class="size-3.5 text-muted-foreground" />
					{:else}
						<Folder class="size-3.5 text-muted-foreground" />
					{/if}
				</div>
				<div class="flex-1 min-w-0 space-y-0.5">
					<div class="flex items-center gap-1 flex-wrap">
						<Badge variant="outline" class="text-[10px]">{r.type}</Badge>
						{#if r.mountPath}
							<code class="text-[10px] font-mono text-muted-foreground">{r.mountPath}</code>
						{/if}
					</div>
					{#if r.type === 'github_repository'}
						<div class="text-muted-foreground truncate">{r.repoUrl}</div>
						{#if r.checkoutRef}
							<div class="text-[10px] text-muted-foreground">ref: {r.checkoutRef}</div>
						{/if}
					{:else if r.fileId}
						<div class="text-[10px] text-muted-foreground">file id: {r.fileId}</div>
					{/if}
					{#if r.authTokenCredentialId}
						<div class="text-[10px] text-muted-foreground italic">auth credential bound (never echoed)</div>
					{/if}
				</div>
				<Button
					variant="ghost"
					size="icon"
					class="size-6 shrink-0"
					onclick={() => removeResource(r.id)}
					aria-label="Remove"
				>
					<Trash2 class="size-3" />
				</Button>
			</div>
		{/each}

		{#if addingRepo}
			<div class="rounded border border-dashed p-2 space-y-2">
				<div>
					<Label class="text-[10px]" for="repo-url">GitHub URL</Label>
					<Input
						id="repo-url"
						bind:value={repoUrl}
						placeholder="https://github.com/owner/repo"
						class="h-7 text-xs"
					/>
				</div>
				<div class="grid grid-cols-2 gap-2">
					<div>
						<Label class="text-[10px]" for="repo-ref">Branch/Ref</Label>
						<Input id="repo-ref" bind:value={repoRef} class="h-7 text-xs" />
					</div>
					<div>
						<Label class="text-[10px]" for="repo-mount">Mount path</Label>
						<Input id="repo-mount" bind:value={repoMountPath} class="h-7 text-xs" />
					</div>
				</div>
				<div class="flex gap-2">
					<Button size="sm" class="h-7 text-xs" onclick={addRepo} disabled={!repoUrl.trim()}>
						<Plus class="size-3" /> Mount
					</Button>
					<Button
						size="sm"
						variant="ghost"
						class="h-7 text-xs"
						onclick={() => {
							addingRepo = false;
							repoUrl = '';
						}}
					>
						<X class="size-3" /> Cancel
					</Button>
				</div>
			</div>
		{:else}
			<div class="flex gap-2 pt-1">
				<Button
					variant="outline"
					size="sm"
					class="h-7 text-[11px]"
					onclick={() => (addingRepo = true)}
				>
					<GitBranch class="size-3" /> Mount repo
				</Button>
				<Button
					variant="outline"
					size="sm"
					class="h-7 text-[11px]"
					disabled
					title="File upload coming in Wave 5"
				>
					<Upload class="size-3" /> Upload file
				</Button>
			</div>
		{/if}
	</CardContent>
</Card>
