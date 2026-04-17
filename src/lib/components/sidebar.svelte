<script lang="ts">
	import { getContext, onMount, untrack } from 'svelte';
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
		Code,
		ChevronsUpDown,
		Server,
		Container,
		Network,
		Puzzle,
		RotateCcw,
		Layers,
		KeyRound,
		MessagesSquare,
		ChevronDown,
		Home,
		BarChart3,
		DollarSign,
		FileText,
		Files,
		Rocket,
		Shield,
		Users,
		Key,
		Gauge,
		Wrench
	} from 'lucide-svelte';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Avatar, AvatarImage, AvatarFallback } from '$lib/components/ui/avatar';
	import AiAssistantToggle from '$lib/components/ai-assistant/ai-assistant-toggle.svelte';
	import type { createUiStore } from '$lib/stores/ui.svelte';

	interface Props {
		collapsed: boolean;
		onToggle: () => void;
		user?: { name: string | null; email: string | null; image: string | null } | null;
	}

	let { collapsed, onToggle, user = null }: Props = $props();
	const ui = getContext<ReturnType<typeof createUiStore>>('ui');

	type NavItem = { href: string; label: string; icon: typeof GitBranch };
	type NavGroup = { label: string; icon: typeof GitBranch; badge?: string; items: NavItem[] };

	// CMA-mirrored nav IA. Groups + labels match platform.claude.com/dashboard exactly.
	const navGroups: NavGroup[] = [
		{
			label: 'Build',
			icon: Wrench,
			items: [
				{ href: '/mcp-chat', label: 'Workbench', icon: MessageSquare },
				{ href: '/workflows', label: 'Workflows', icon: GitBranch },
				{ href: '/workflow-ops/names', label: 'Workflow Ops', icon: RotateCcw },
				{ href: '/code-functions', label: 'Code Functions', icon: Code }
			]
		},
		{
			label: 'Managed Agents',
			icon: Bot,
			badge: 'New',
			items: [
				{ href: '/agents/quickstart', label: 'Quickstart', icon: Rocket },
				{ href: '/agents', label: 'Agents', icon: Bot },
				{ href: '/sessions', label: 'Sessions', icon: MessagesSquare },
				{ href: '/environments', label: 'Environments', icon: Layers },
				{ href: '/vaults', label: 'Credential vaults', icon: KeyRound },
				{ href: '/skills', label: 'Skills', icon: Puzzle },
				{ href: '/files', label: 'Files', icon: Files },
				{ href: '/connections', label: 'Connections', icon: Plug }
			]
		},
		{
			label: 'Analytics',
			icon: BarChart3,
			items: [
				{ href: '/usage', label: 'Usage', icon: BarChart3 },
				{ href: '/cost', label: 'Cost', icon: DollarSign },
				{ href: '/observability', label: 'Logs', icon: FileText }
			]
		},
		{
			label: 'Operate',
			icon: Activity,
			items: [
				{ href: '/monitor', label: 'Monitor', icon: Activity },
				{ href: '/sandboxes', label: 'Sandboxes', icon: Container },
				{ href: '/activities', label: 'Activities', icon: Server },
				{ href: '/dapr-system', label: 'Dapr System', icon: Network }
			]
		},
		{
			label: 'Manage',
			icon: Settings,
			items: [
				{ href: '/settings/api-keys', label: 'API keys', icon: Key },
				{ href: '/settings/limits', label: 'Limits', icon: Gauge },
				{ href: '/settings/members', label: 'Members', icon: Users },
				{ href: '/settings/security', label: 'Security & compliance', icon: Shield }
			]
		}
	];

	// Each group can be expanded/collapsed. Default: active group open, others closed.
	let openGroups = $state<Record<string, boolean>>({
		Build: true,
		'Managed Agents': true,
		Analytics: false,
		Operate: false,
		Manage: false
	});

	// Auto-open the group containing the active route. Read `openGroups`
	// via untrack() so the spread doesn't create a self-dependency loop
	// (write → re-run → write → ...).
	$effect(() => {
		const pathname = page.url.pathname;
		const next = untrack(() => ({ ...openGroups }));
		let changed = false;
		for (const group of navGroups) {
			if (group.items.some((item) => isActive(item.href)) && !next[group.label]) {
				next[group.label] = true;
				changed = true;
			}
		}
		if (changed) openGroups = next;
		void pathname; // keep pathname as the effect's tracked dependency
	});

	function toggleGroup(label: string) {
		openGroups = { ...openGroups, [label]: !openGroups[label] };
	}

	function isActive(href: string): boolean {
		if (href === '/workflow-ops/names') return page.url.pathname.startsWith('/workflow-ops');
		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}

	function reloadAttrs(href: string): Record<string, string> {
		return href === '/workflows' && page.url.pathname.startsWith('/workflows/')
			? { 'data-sveltekit-reload': '' }
			: {};
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

	type Workspace = {
		id: string;
		slug: string;
		displayName: string;
		externalId: string;
		role: string;
		isCurrent: boolean;
	};
	let workspaces = $state<Workspace[]>([]);
	let activeWorkspace = $derived(
		workspaces.find((w) => w.isCurrent) ?? workspaces[0] ?? null
	);

	onMount(async () => {
		try {
			const res = await fetch('/api/v1/workspaces');
			if (res.ok) {
				const data = await res.json();
				workspaces = data.workspaces ?? [];
			}
		} catch {
			/* best effort */
		}
	});
</script>

<aside
	class="flex h-full flex-col border-r border-border bg-card transition-[width] duration-200 ease-linear"
	style="width: {collapsed ? '3.5rem' : '14rem'};"
>
	<!-- Header -->
	<div class="flex h-12 items-center border-b border-border {collapsed ? 'justify-center px-0' : 'justify-between px-3'}">
		{#if !collapsed}
			<a
				href="/workflows"
				{...reloadAttrs('/workflows')}
				class="text-xs font-semibold tracking-tight text-foreground"
			>
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

	<!-- Workspace switcher (CMA parity) -->
	{#if !collapsed && activeWorkspace}
		<div class="px-3 py-2 border-b border-border">
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<button
							{...props}
							class="flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs hover:bg-accent/50"
						>
							<div class="size-5 rounded bg-primary/10 flex items-center justify-center text-[10px] font-semibold">
								{activeWorkspace.displayName[0]?.toUpperCase() ?? 'W'}
							</div>
							<span class="flex-1 text-left truncate font-medium">
								{activeWorkspace.displayName}
							</span>
							<ChevronsUpDown size={12} class="shrink-0 text-muted-foreground" />
						</button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="w-[calc(14rem-1.5rem)]">
					<DropdownMenu.Label class="text-[10px] uppercase tracking-wide text-muted-foreground">
						Workspaces
					</DropdownMenu.Label>
					{#each workspaces as w (w.id)}
						<DropdownMenu.Item
							onSelect={() => {
								// Flat CMA routes — workspace scope is resolved from JWT
								window.location.href = `/agents`;
							}}
							class="gap-2"
						>
							<div class="size-5 rounded bg-primary/10 flex items-center justify-center text-[10px] font-semibold">
								{w.displayName[0]?.toUpperCase() ?? 'W'}
							</div>
							<span class="flex-1 truncate">{w.displayName}</span>
							{#if w.isCurrent}
								<span class="text-[10px] text-primary">active</span>
							{/if}
						</DropdownMenu.Item>
					{/each}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>
	{/if}

	<!-- Navigation -->
	<nav class="flex-1 overflow-y-auto p-2">
		<!-- Dashboard: top-level link (matches CMA's dashboard shortcut above all groups) -->
		{#if collapsed}
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<a
							{...props}
							href="/dashboard"
							class="mb-1 flex h-8 w-full items-center justify-center rounded-md transition-colors {isActive(
								'/dashboard'
							)
								? 'bg-accent text-accent-foreground'
								: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
						>
							<Home size={15} />
						</a>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content side="right">Dashboard</Tooltip.Content>
			</Tooltip.Root>
		{:else}
			<a
				href="/dashboard"
				class="mb-1 flex h-8 items-center gap-2.5 rounded-md px-2.5 text-xs transition-colors {isActive(
					'/dashboard'
				)
					? 'bg-accent font-medium text-accent-foreground'
					: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
			>
				<Home size={15} class="shrink-0" />
				<span>Dashboard</span>
			</a>
		{/if}

		<!-- Grouped nav -->
		<div class="flex flex-col gap-0.5">
			{#each navGroups as group (group.label)}
				{#if collapsed}
					<!-- Collapsed: show group-level icon, flatten items into tooltips -->
					{#each group.items as item (item.href)}
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<a
										{...props}
										{...reloadAttrs(item.href)}
										href={item.href}
										class="flex h-8 w-full items-center justify-center rounded-md transition-colors {isActive(
											item.href
										)
											? 'bg-accent text-accent-foreground'
											: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
									>
										<item.icon size={15} />
									</a>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content side="right">
								{group.label} → {item.label}
							</Tooltip.Content>
						</Tooltip.Root>
					{/each}
					{#if group !== navGroups[navGroups.length - 1]}
						<div class="my-1 border-t border-border/50"></div>
					{/if}
				{:else}
					<!-- Expanded: collapsible group with header + item list -->
					<div class="flex flex-col">
						<button
							type="button"
							onclick={() => toggleGroup(group.label)}
							class="flex h-7 items-center justify-between gap-2 rounded-md px-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80 transition-colors hover:bg-accent/30 hover:text-foreground"
						>
							<span class="flex items-center gap-1">
								{group.label}
								{#if group.badge}
									<span
										class="rounded-full bg-primary/15 px-1.5 py-px text-[9px] font-medium uppercase tracking-normal text-primary"
									>
										{group.badge}
									</span>
								{/if}
							</span>
							<ChevronDown
								size={11}
								class="transition-transform {openGroups[group.label] ? '' : '-rotate-90'}"
							/>
						</button>
						{#if openGroups[group.label]}
							<div class="mb-1 ml-0 flex flex-col gap-0.5">
								{#each group.items as item (item.href)}
									<a
										href={item.href}
										{...reloadAttrs(item.href)}
										class="flex h-7 items-center gap-2.5 rounded-md px-2.5 pl-5 text-xs transition-colors {isActive(
											item.href
										)
											? 'bg-accent font-medium text-accent-foreground'
											: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
									>
										<item.icon size={13} class="shrink-0" />
										<span>{item.label}</span>
									</a>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			{/each}
		</div>
	</nav>

	<!-- Footer -->
	<Separator />
	<div class="p-2">
		<div class="flex flex-col gap-0.5">
			<!-- AI Assistant toggle -->
			<AiAssistantToggle {collapsed} />

			<!-- Theme toggle -->
			{#if collapsed}
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<button
								{...props}
								onclick={toggleTheme}
								class="flex h-8 w-full items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
							>
								{#if ui.theme === 'dark'}
									<Sun size={15} />
								{:else}
									<Moon size={15} />
								{/if}
							</button>
						{/snippet}
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
					{#snippet child({ props })}
						<button
							{...props}
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
					{/snippet}
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
