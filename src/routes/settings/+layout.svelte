<script lang="ts">
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import { Users, Shield, Settings as SettingsIcon } from 'lucide-svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();

	// Platform-scoped settings only. Workspace-scoped API keys + Limits moved
	// to /workspaces/[slug]/settings/{keys,limits} in the Phase 3 cutover and
	// live under a different layout there.
	const tabs = [
		{ href: '/settings/members', label: 'Members', icon: Users },
		{ href: '/settings/security', label: 'Security and compliance', icon: Shield }
	];

	// Legacy /settings route still shows the monolithic page; the new tab
	// container wraps anything under /settings/{tab-slug}/ and renders that
	// content in a consistent shell.
	let showTabs = $derived.by(() => {
		const path = page.url.pathname;
		return tabs.some((t) => path.startsWith(t.href));
	});
</script>

{#if showTabs}
	<div class="flex flex-col h-full max-w-6xl mx-auto w-full p-6 gap-6">
		<header>
			<h1 class="text-2xl font-semibold flex items-center gap-2">
				<SettingsIcon class="size-6" /> Settings
			</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Manage API keys, rate limits, members, and security for this workspace.
			</p>
		</header>

		<div class="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6 flex-1 min-h-0">
			<nav class="flex flex-col gap-1">
				{#each tabs as tab}
					{@const active = page.url.pathname.startsWith(tab.href)}
					<a
						href={tab.href}
						class="flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors {active
							? 'bg-accent font-medium text-accent-foreground'
							: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
					>
						<tab.icon class="size-4 shrink-0" />
						<span class="truncate">{tab.label}</span>
					</a>
				{/each}
			</nav>

			<main class="min-w-0">
				{@render children()}
			</main>
		</div>
	</div>
{:else}
	{@render children()}
{/if}
