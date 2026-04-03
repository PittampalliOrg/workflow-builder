<script lang="ts">
	import { getContext } from 'svelte';
	import { page } from '$app/state';
	import {
		GitBranch,
		Plug,
		Bot,
		Activity,
		Settings,
		ChevronLeft,
		ChevronRight,
		MessageSquare,
		Moon,
		Sun,
		LogOut,
		Eye,
		ChevronsUpDown
	} from 'lucide-svelte';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Avatar, AvatarImage, AvatarFallback } from '$lib/components/ui/avatar';
	import type { createUiStore } from '$lib/stores/ui.svelte';

	interface Props {
		collapsed: boolean;
		onToggle: () => void;
		user?: { name: string | null; email: string | null; image: string | null } | null;
	}

	let { collapsed, onToggle, user = null }: Props = $props();
	const ui = getContext<ReturnType<typeof createUiStore>>('ui');

	const navItems = [
		{ href: '/workflows', label: 'Workflows', icon: GitBranch },
		{ href: '/connections', label: 'Connections', icon: Plug },
		{ href: '/agents', label: 'Agents', icon: Bot },
		{ href: '/mcp-chat', label: 'MCP Chat', icon: MessageSquare },
		{ href: '/monitor', label: 'Monitor', icon: Activity },
		{ href: '/observability', label: 'Observability', icon: Eye },
		{ href: '/settings', label: 'Settings', icon: Settings }
	];

	function isActive(href: string): boolean {
		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}

	function toggleTheme() {
		const next = ui.theme === 'dark' ? 'light' : 'dark';
		ui.setTheme(next);
		document.cookie = `theme=${next};path=/;max-age=${60 * 60 * 24 * 365};SameSite=Lax`;
	}

	async function signOut() {
		await fetch('/api/v1/auth/sign-out', { method: 'POST' });
		window.location.href = '/auth/sign-in';
	}

	let initials = $derived.by(() => {
		if (user?.name) return user.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
		if (user?.email) return user.email[0].toUpperCase();
		return 'U';
	});

	let displayName = $derived(user?.name || user?.email?.split('@')[0] || 'User');
</script>

<aside
	class="flex h-full flex-col border-r border-border bg-card transition-[width] duration-200 ease-linear"
	style="width: {collapsed ? '3.5rem' : '14rem'};"
>
	<!-- Header -->
	<div class="flex h-12 items-center border-b border-border {collapsed ? 'justify-center px-0' : 'justify-between px-3'}">
		{#if !collapsed}
			<a href="/workflows" class="text-xs font-semibold tracking-tight text-foreground">
				Workflow Builder
			</a>
		{/if}
		<Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" onclick={onToggle}>
			{#if collapsed}
				<ChevronRight size={14} />
			{:else}
				<ChevronLeft size={14} />
			{/if}
		</Button>
	</div>

	<!-- Navigation -->
	<nav class="flex-1 overflow-y-auto p-2">
		<div class="flex flex-col gap-0.5">
			{#each navItems as item}
				{#if collapsed}
					<Tooltip.Root>
						<Tooltip.Trigger>
							<a
								href={item.href}
								class="flex h-8 w-full items-center justify-center rounded-md transition-colors {isActive(item.href)
									? 'bg-accent text-accent-foreground'
									: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
							>
								<item.icon size={15} />
							</a>
						</Tooltip.Trigger>
						<Tooltip.Content side="right">{item.label}</Tooltip.Content>
					</Tooltip.Root>
				{:else}
					<a
						href={item.href}
						class="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-xs transition-colors {isActive(item.href)
							? 'bg-accent font-medium text-accent-foreground'
							: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
					>
						<item.icon size={15} class="shrink-0" />
						<span>{item.label}</span>
					</a>
				{/if}
			{/each}
		</div>
	</nav>

	<!-- Footer -->
	<Separator />
	<div class="p-2">
		<div class="flex flex-col gap-0.5">
			<!-- Theme toggle -->
			{#if collapsed}
				<Tooltip.Root>
					<Tooltip.Trigger>
						<button
							onclick={toggleTheme}
							class="flex h-8 w-full items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
						>
							{#if ui.theme === 'dark'}
								<Sun size={15} />
							{:else}
								<Moon size={15} />
							{/if}
						</button>
					</Tooltip.Trigger>
					<Tooltip.Content side="right">{ui.theme === 'dark' ? 'Light mode' : 'Dark mode'}</Tooltip.Content>
				</Tooltip.Root>
			{:else}
				<button
					onclick={toggleTheme}
					class="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
				>
					{#if ui.theme === 'dark'}
						<Sun size={15} class="shrink-0" />
					{:else}
						<Moon size={15} class="shrink-0" />
					{/if}
					<span>{ui.theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
				</button>
			{/if}

			<!-- User avatar -->
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					<button
						class="flex h-8 w-full items-center rounded-md transition-colors hover:bg-accent/50 {collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5'}"
					>
						<Avatar class="h-5 w-5 shrink-0">
							{#if user?.image}
								<AvatarImage src={user.image} alt={displayName} />
							{/if}
							<AvatarFallback class="text-[8px] font-medium">{initials}</AvatarFallback>
						</Avatar>
						{#if !collapsed}
							<span class="min-w-0 flex-1 truncate text-left text-xs text-foreground">{displayName}</span>
							<ChevronsUpDown size={11} class="shrink-0 text-muted-foreground" />
						{/if}
					</button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Content side={collapsed ? 'right' : 'top'} align="start" class="w-48">
					{#if user?.email}
						<div class="px-2 py-1.5">
							<p class="text-xs font-medium">{displayName}</p>
							<p class="text-[10px] text-muted-foreground truncate">{user.email}</p>
						</div>
						<DropdownMenu.Separator />
					{/if}
					<DropdownMenu.Item onclick={signOut} class="text-xs cursor-pointer">
						<LogOut size={12} class="mr-2" />
						Sign out
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>
	</div>
</aside>
