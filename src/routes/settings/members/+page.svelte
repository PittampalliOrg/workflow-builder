<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Users, Plus, Trash2, Shield } from '@lucide/svelte';

	type Role = 'ADMIN' | 'EDITOR' | 'OPERATOR' | 'VIEWER';
	type Member = {
		id: string;
		userId: string;
		name: string | null;
		email: string | null;
		image: string | null;
		role: Role;
		createdAt: string;
	};

	const { data }: { data: { activeProject: {
		id: string;
		displayName: string;
		externalId: string;
		selfRole: Role | null;
	} | null } } = $props();

	const project = $derived(data.activeProject);
	const canManage = $derived(project?.selfRole === 'ADMIN');

	let members = $state<Member[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);

	let inviteOpen = $state(false);
	let inviteEmail = $state('');
	let inviteRole = $state<Role>('VIEWER');
	let inviting = $state(false);

	async function load() {
		if (!project) {
			loading = false;
			return;
		}
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/v1/projects/${project.id}/members`);
			if (!res.ok) {
				errorMessage = `Failed to load members (${res.status})`;
				return;
			}
			const body = (await res.json()) as { members: Member[] };
			members = body.members ?? [];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function invite() {
		if (!project || !inviteEmail.trim()) return;
		inviting = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/v1/projects/${project.id}/members`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole })
			});
			if (!res.ok) {
				errorMessage = `Invite failed (${res.status}): ${(await res.text()).slice(0, 200)}`;
				return;
			}
			inviteOpen = false;
			inviteEmail = '';
			inviteRole = 'VIEWER';
			await load();
		} finally {
			inviting = false;
		}
	}

	async function changeRole(member: Member, role: Role) {
		if (!project || member.role === role) return;
		const res = await fetch(
			`/api/v1/projects/${project.id}/members/${member.id}`,
			{
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ role })
			}
		);
		if (!res.ok) {
			errorMessage = `Role update failed (${res.status}): ${(await res.text()).slice(0, 200)}`;
			return;
		}
		await load();
	}

	async function remove(member: Member) {
		if (!project) return;
		if (!confirm(`Remove ${member.email ?? member.userId} from ${project.displayName}?`))
			return;
		const res = await fetch(
			`/api/v1/projects/${project.id}/members/${member.id}`,
			{ method: 'DELETE' }
		);
		if (!res.ok) {
			errorMessage = `Remove failed (${res.status}): ${(await res.text()).slice(0, 200)}`;
			return;
		}
		await load();
	}

	onMount(load);
	// Reload when the active workspace changes (X-Workspace header flips with URL).
	$effect(() => {
		// biome-ignore lint/correctness/noUnusedVariables: subscribe to reactive
		const p = page.url.pathname;
		void p;
		load();
	});
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="text-lg font-semibold flex items-center gap-2">
				<Users class="size-4" /> Members
			</h2>
			<p class="text-xs text-muted-foreground mt-1">
				{#if project}
					People with access to <span class="font-medium">{project.displayName}</span>.
				{:else}
					No active workspace — pick one from the sidebar switcher.
				{/if}
			</p>
		</div>
		{#if canManage}
			<Button onclick={() => (inviteOpen = true)}>
				<Plus class="size-4" /> Add member
			</Button>
		{/if}
	</div>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription class="text-xs">{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	{#if !project}
		<Alert>
			<AlertDescription class="text-xs">
				Settings → Members is scoped to a single workspace. Visit <a
					href="/workspaces"
					class="text-primary hover:underline">Workspaces</a
				> to pick one.
			</AlertDescription>
		</Alert>
	{:else}
		<Card>
			<CardHeader>
				<CardTitle class="text-base flex items-center gap-2">
					<Shield class="size-4" /> {project.displayName}
				</CardTitle>
				<CardDescription class="text-xs">
					{members.length}
					{members.length === 1 ? 'member' : 'members'} · you are
					<code class="text-[10px]">{project.selfRole ?? 'not a member'}</code>
				</CardDescription>
			</CardHeader>
			<CardContent class="p-0">
				{#if loading}
					<div class="p-4 text-xs text-muted-foreground">Loading members…</div>
				{:else if members.length === 0}
					<div class="p-4 text-xs text-muted-foreground">No members yet.</div>
				{:else}
					<table class="w-full text-xs">
						<thead class="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b">
							<tr>
								<th class="px-4 py-2 font-medium">Name</th>
								<th class="px-4 py-2 font-medium">Email</th>
								<th class="px-4 py-2 font-medium">Role</th>
								<th class="px-4 py-2 font-medium">Added</th>
								<th class="px-4 py-2 font-medium"></th>
							</tr>
						</thead>
						<tbody class="divide-y">
							{#each members as m (m.id)}
								<tr>
									<td class="px-4 py-2 flex items-center gap-2">
										{#if m.image}
											<img
												src={m.image}
												alt=""
												class="size-6 rounded-full border border-border"
											/>
										{/if}
										{m.name ?? m.userId.slice(0, 10)}
									</td>
									<td class="px-4 py-2 text-muted-foreground">
										{m.email ?? '—'}
									</td>
									<td class="px-4 py-2">
										{#if canManage}
											<select
												class="h-7 rounded-md border border-border bg-background px-2 text-[11px]"
												value={m.role}
												onchange={(e) =>
													changeRole(m, (e.currentTarget as HTMLSelectElement).value as Role)}
											>
												<option value="ADMIN">ADMIN</option>
												<option value="EDITOR">EDITOR</option>
												<option value="OPERATOR">OPERATOR</option>
												<option value="VIEWER">VIEWER</option>
											</select>
										{:else}
											<Badge variant="outline" class="text-[10px] uppercase">{m.role}</Badge>
										{/if}
									</td>
									<td class="px-4 py-2 text-muted-foreground">
										{new Date(m.createdAt).toLocaleDateString()}
									</td>
									<td class="px-4 py-2 text-right">
										{#if canManage}
											<Button
												variant="ghost"
												size="sm"
												class="h-7 text-[11px]"
												onclick={() => remove(m)}
											>
												<Trash2 class="size-3" />
											</Button>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</CardContent>
		</Card>

		<Card>
			<CardHeader>
				<CardTitle class="text-base">Role reference</CardTitle>
			</CardHeader>
			<CardContent>
				<table class="w-full text-xs">
					<thead class="text-left text-[10px] uppercase tracking-wide text-muted-foreground border-b">
						<tr>
							<th class="pb-2 font-medium">Role</th>
							<th class="pb-2 font-medium">Access</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						<tr>
							<td class="py-2 font-medium">ADMIN</td>
							<td class="py-2">Manage members, rotate MCP tokens, full CRUD on all resources.</td>
						</tr>
						<tr>
							<td class="py-2 font-medium">EDITOR</td>
							<td class="py-2">Create and edit agents, environments, vaults, sessions.</td>
						</tr>
						<tr>
							<td class="py-2 font-medium">OPERATOR</td>
							<td class="py-2">Run existing agents and manage sessions; no config changes.</td>
						</tr>
						<tr>
							<td class="py-2 font-medium">VIEWER</td>
							<td class="py-2">Read-only access to everything in the workspace.</td>
						</tr>
					</tbody>
				</table>
			</CardContent>
		</Card>
	{/if}
</div>

<Dialog.Root bind:open={inviteOpen}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Add member</Dialog.Title>
			<Dialog.Description>
				Add an existing user to this workspace by their platform email. Brand-new
				users must sign up first — we can't provision accounts from here.
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-3 py-2">
			<div class="space-y-1">
				<Label for="invite-email">Email</Label>
				<Input
					id="invite-email"
					type="email"
					placeholder="teammate@company.com"
					bind:value={inviteEmail}
				/>
			</div>
			<div class="space-y-1">
				<Label for="invite-role">Role</Label>
				<select
					id="invite-role"
					class="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
					bind:value={inviteRole}
				>
					<option value="ADMIN">ADMIN — full control</option>
					<option value="EDITOR">EDITOR — create + edit</option>
					<option value="OPERATOR">OPERATOR — run existing</option>
					<option value="VIEWER">VIEWER — read-only</option>
				</select>
			</div>
		</div>
		<Dialog.Footer>
			<Button variant="ghost" onclick={() => (inviteOpen = false)}>Cancel</Button>
			<Button disabled={!inviteEmail.trim() || inviting} onclick={invite}>
				<Plus class="size-4" />
				{inviting ? 'Adding…' : 'Add member'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
