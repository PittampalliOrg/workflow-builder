<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import { GitBranch, Plus, Trash2, X } from '@lucide/svelte';
	import CredentialPicker from '$lib/components/credentials/credential-picker.svelte';
	import type { SessionRepositoryInput } from '$lib/types/sessions';

	interface Props {
		value: SessionRepositoryInput[];
		onChange: (repos: SessionRepositoryInput[]) => void;
	}

	let { value, onChange }: Props = $props();

	let adding = $state(false);
	let repoUrl = $state('');
	let repoRef = $state('main');
	let repoMountPath = $state('');
	let repoCredentialId = $state<string | null>(null);

	function resetForm() {
		adding = false;
		repoUrl = '';
		repoRef = 'main';
		repoMountPath = '';
		repoCredentialId = null;
	}

	function add() {
		const url = repoUrl.trim();
		if (!url) return;
		const next: SessionRepositoryInput = {
			repoUrl: url,
			checkoutRef: repoRef.trim() || undefined,
			mountPath: repoMountPath.trim() || undefined,
			authTokenCredentialId: repoCredentialId ?? undefined
		};
		onChange([...value, next]);
		resetForm();
	}

	function remove(index: number) {
		onChange(value.filter((_, i) => i !== index));
	}
</script>

<div class="space-y-2">
	{#each value as repo, i (i)}
		<div class="rounded border p-2 flex items-start gap-2 text-xs">
			<GitBranch class="size-3.5 text-muted-foreground mt-0.5" />
			<div class="flex-1 min-w-0 space-y-0.5">
				<div class="truncate">{repo.repoUrl}</div>
				<div class="flex items-center gap-1 flex-wrap text-[10px] text-muted-foreground">
					{#if repo.checkoutRef}<Badge variant="outline" class="text-[10px]">{repo.checkoutRef}</Badge>{/if}
					{#if repo.mountPath}<code class="font-mono">{repo.mountPath}</code>{/if}
					{#if repo.authTokenCredentialId}<span class="italic">auth bound</span>{/if}
				</div>
			</div>
			<Button
				variant="ghost"
				size="icon"
				class="size-6 shrink-0"
				onclick={() => remove(i)}
				aria-label="Remove repository"
			>
				<Trash2 class="size-3" />
			</Button>
		</div>
	{/each}

	{#if adding}
		<div class="rounded border border-dashed p-2 space-y-2">
			<div>
				<Label class="text-[10px]" for="new-repo-url">GitHub URL</Label>
				<Input
					id="new-repo-url"
					bind:value={repoUrl}
					placeholder="https://github.com/owner/repo"
					class="h-7 text-xs"
				/>
			</div>
			<div class="grid grid-cols-2 gap-2">
				<div>
					<Label class="text-[10px]" for="new-repo-ref">Branch/Ref</Label>
					<Input id="new-repo-ref" bind:value={repoRef} class="h-7 text-xs" />
				</div>
				<div>
					<Label class="text-[10px]" for="new-repo-mount">Mount path</Label>
					<Input
						id="new-repo-mount"
						bind:value={repoMountPath}
						placeholder="/sandbox/<repo>"
						class="h-7 text-xs"
					/>
				</div>
			</div>
			<CredentialPicker
				id="new-repo-credential"
				label="Auth credential (private repos)"
				value={repoCredentialId}
				onChange={(id) => (repoCredentialId = id)}
			/>
			<div class="flex gap-2">
				<Button size="sm" class="h-7 text-xs" onclick={add} disabled={!repoUrl.trim()}>
					<Plus class="size-3" /> Add
				</Button>
				<Button size="sm" variant="ghost" class="h-7 text-xs" onclick={resetForm}>
					<X class="size-3" /> Cancel
				</Button>
			</div>
		</div>
	{:else}
		<Button variant="outline" size="sm" class="h-7 text-[11px]" onclick={() => (adding = true)}>
			<GitBranch class="size-3" /> Add repository
		</Button>
	{/if}
</div>
