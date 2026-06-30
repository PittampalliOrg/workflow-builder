<script lang="ts">
	import { getContext, onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { DEFAULT_WORKSPACE_SLUG } from '$lib/utils/workspace-path';
	import { NAV_GROUPS, resolveNav, type NavGroup } from '$lib/navigation/nav-config';
	import {
		ChevronLeft,
		ChevronRight,
		Moon,
		Sun,
		LogOut,
		Briefcase,
		ChevronsUpDown,
		ChevronDown,
		Home
	} from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Avatar, AvatarImage, AvatarFallback } from '$lib/components/ui/avatar';
	import AiAssistantToggle from '$lib/components/ai-assistant/ai-assistant-toggle.svelte';
	import RuntimeStatusBadge from '$lib/components/runtime-status-badge.svelte';
	import NotificationBell from '$lib/components/chrome/notification-bell.svelte';
	import type { createUiStore } from '$lib/stores/ui.svelte';

	interface Props {
		collapsed: boolean;
		onToggle: () => void;
		user?: { name: string | null; email: string | null; image: string | null } | null;
		platformRole?: 'ADMIN' | 'MEMBER';
	}

	let { collapsed, onToggle, user = null, platformRole = 'MEMBER' }: Props = $props();
	const ui = getContext<ReturnType<typeof createUiStore>>('ui');
	let narrowViewport = $state(false);
	let navCollapsed = $derived(collapsed || narrowViewport);

	// Workspace state — fetched from /api/v1/workspaces on mount. Drives the
	// workspace switcher dropdown and supplies the `slug` context the nav
	// schema uses to build workspace-scoped hrefs.
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

	// When already on a workspace-scoped URL, preserve THAT slug in nav
	// links instead of the JWT-current workspace — so clicking nav items
	// doesn't bounce the user back to their default workspace.
	const urlSlug = $derived(
		(page.params.slug as string | undefined) ?? null,
	);
	const activeSlug = $derived(
		urlSlug ?? activeWorkspace?.slug ?? DEFAULT_WORKSPACE_SLUG,
	);

	// Resolve nav tree from schema using active workspace + role. `resolveNav`
	// filters admin-only groups/items when platformRole !== 'ADMIN'.
	const navGroups: NavGroup[] = $derived(
		resolveNav({ slug: activeSlug, platformRole })
	);

	// Each group can be expanded/collapsed. Defaults come from the schema
	// (`defaultOpen`), persisted to localStorage so preference survives
	// reloads — matches CMA's chevron-per-section behaviour.
	const SIDEBAR_STORAGE_KEY = 'sidebar:open-groups:v1';
	const DEFAULT_OPEN_GROUPS: Record<string, boolean> = Object.fromEntries(
		NAV_GROUPS.map((g) => [g.label, g.defaultOpen ?? false])
	);
	let openGroups = $state<Record<string, boolean>>({ ...DEFAULT_OPEN_GROUPS });

	onMount(() => {
		if (typeof localStorage === 'undefined') return;
		try {
			const raw = localStorage.getItem(SIDEBAR_STORAGE_KEY);
			if (!raw) return;
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const merged: Record<string, boolean> = { ...DEFAULT_OPEN_GROUPS };
			for (const key of Object.keys(DEFAULT_OPEN_GROUPS)) {
				if (typeof parsed[key] === 'boolean') merged[key] = parsed[key] as boolean;
			}
			openGroups = merged;
		} catch {
			/* corrupt storage — fall back to defaults */
		}
	});

	onMount(() => {
		if (typeof window === 'undefined') return;
		const query = window.matchMedia('(max-width: 700px)');
		const update = () => {
			narrowViewport = query.matches;
		};
		update();
		query.addEventListener('change', update);
		return () => query.removeEventListener('change', update);
	});

	// Auto-open the group containing the active route. Read `openGroups`
	// via untrack() so the spread doesn't create a self-dependency loop
	// (write → re-run → write → ...).
	$effect(() => {
		const pathname = page.url.pathname;
		const next = untrack(() => ({ ...openGroups }));
		let changed = false;
		for (const group of navGroups) {
			if (group.items.some((item) => item.match.test(pathname)) && !next[group.label]) {
				next[group.label] = true;
				changed = true;
			}
		}
		if (changed) openGroups = next;
	});

	function toggleGroup(label: string) {
		openGroups = { ...openGroups, [label]: !openGroups[label] };
		if (typeof localStorage !== 'undefined') {
			try {
				localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(openGroups));
			} catch {
				/* quota or private mode */
			}
		}
	}

	function isActive(match: RegExp): boolean {
		return match.test(page.url.pathname);
	}

	// Workflow editor embeds a Svelte Flow canvas whose reactive state doesn't
	// tear down cleanly on SPA navigation back to the list — force a full
	// reload when going from an editor page to the workflows list.
	function reloadAttrs(href: string): Record<string, string> {
		const editorPattern = /^\/workspaces\/[^/]+\/workflows\/[^/]+/;
		const isListHref =
			href === `/workspaces/${activeSlug}/workflows` ||
			/^\/workspaces\/[^/]+\/workflows$/.test(href);
		return isListHref && editorPattern.test(page.url.pathname)
			? { 'data-sveltekit-reload': '' }
			: {};
	}

	const dashboardActive = /^\/dashboard(\/|$)/;

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
	class="app-sidebar flex h-full flex-col border-r border-border bg-card transition-[width] duration-200 ease-linear"
	style="width: {navCollapsed ? '3.5rem' : '14rem'};"
>
	<!-- Header -->
	<div class="sidebar-header flex h-12 items-center border-b border-border {navCollapsed ? 'justify-center px-0' : 'justify-between px-3'}">
		{#if !navCollapsed}
			<a
				href="/workspaces/{activeSlug}/workflows"
				class="flex items-center gap-2 text-xs font-semibold tracking-tight text-foreground"
			>
				<span>Workflow Builder</span>
			</a>
		{/if}
		<Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" onclick={onToggle}>
			{#if navCollapsed}
				<ChevronRight size={14} />
			{:else}
				<ChevronLeft size={14} />
			{/if}
		</Button>
	</div>

	<!-- Workspace switcher (CMA parity) -->
	{#if !navCollapsed && activeWorkspace}
		<div class="workspace-switcher px-3 py-2 border-b border-border">
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
								// Jump to the equivalent page in the chosen workspace.
								// Rewrites the `[slug]` segment in the current URL if
								// we're on a workspace-scoped page; otherwise lands on
								// the workspace's Agents page (matches CMA's default).
								const match = page.url.pathname.match(/^\/workspaces\/[^/]+(\/.*)?$/);
								const suffix = match?.[1] ?? '/agents';
								window.location.href = `/workspaces/${w.slug}${suffix}`;
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
					<DropdownMenu.Separator />
					<DropdownMenu.Item
						onSelect={() => {
							window.location.href = '/workspaces';
						}}
						class="gap-2 text-xs text-muted-foreground"
					>
						<Briefcase size={12} />
						<span>Manage workspaces</span>
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>
	{/if}

	<!-- Navigation -->
	<nav class="primary-nav flex-1 overflow-y-auto p-2">
		<!-- Dashboard: top-level link (matches CMA's dashboard shortcut above all groups) -->
		{#if navCollapsed}
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<a
							{...props}
							href="/dashboard"
							class="mb-1 flex h-8 w-full items-center justify-center rounded-md transition-colors {isActive(
								dashboardActive
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
					dashboardActive
				)
					? 'bg-accent font-medium text-accent-foreground'
					: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}"
			>
				<Home size={15} class="shrink-0" />
				<span>Dashboard</span>
			</a>
		{/if}

		<!-- Grouped nav -->
		<div class="mobile-nav-groups flex flex-col gap-0.5">
			{#each navGroups as group (group.id)}
				{#if navCollapsed}
					<!-- Collapsed: show group-level icon, flatten items into tooltips -->
					{#each group.items as item (item.id)}
						{@const itemHref = item.href({ slug: activeSlug, platformRole })}
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<a
										{...props}
										{...reloadAttrs(itemHref)}
										href={itemHref}
										class="flex h-8 w-full items-center justify-center rounded-md transition-colors {isActive(
											item.match
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
								{#each group.items as item (item.id)}
									{@const itemHref = item.href({ slug: activeSlug, platformRole })}
									<a
										href={itemHref}
										{...reloadAttrs(itemHref)}
										class="flex h-7 items-center gap-2.5 rounded-md px-2.5 pl-5 text-xs transition-colors {isActive(
											item.match
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
	<div class="sidebar-footer p-2">
		<div class="flex flex-col gap-0.5">
			<!-- Current environment + running image metadata -->
			<RuntimeStatusBadge collapsed={navCollapsed} {platformRole} />

			<!-- App-wide deployment notifications (admin-gated; data is admin-only) -->
			{#if platformRole === 'ADMIN'}
				<NotificationBell collapsed={navCollapsed} />
			{/if}

			<!-- AI Assistant toggle -->
			<AiAssistantToggle collapsed={navCollapsed} />

			<!-- Theme toggle -->
			{#if navCollapsed}
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
							class="flex h-8 w-full items-center rounded-md transition-colors hover:bg-accent/50 {navCollapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5'}"
						>
							<Avatar class="h-5 w-5 shrink-0">
								{#if user?.image}
									<AvatarImage src={user.image} alt={displayName} />
								{/if}
								<AvatarFallback class="text-[8px] font-medium">{initials}</AvatarFallback>
							</Avatar>
							{#if !navCollapsed}
								<span class="min-w-0 flex-1 truncate text-left text-xs text-foreground">{displayName}</span>
								<ChevronsUpDown size={11} class="shrink-0 text-muted-foreground" />
							{/if}
						</button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content side={navCollapsed ? 'right' : 'top'} align="start" class="w-48">
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

<style>
	@media (max-width: 700px) {
		:global(body) {
			padding-bottom: 3.75rem;
		}

		.app-sidebar {
			position: fixed;
			inset: auto 0 0 0;
			z-index: 50;
			width: 100% !important;
			height: 3.75rem;
			flex-direction: row;
			border-top: 1px solid var(--border);
			border-right: 0;
			box-shadow: 0 -12px 32px rgb(0 0 0 / 0.18);
		}

		.sidebar-header,
		.workspace-switcher,
		.sidebar-footer {
			display: none;
		}

		.primary-nav {
			display: flex;
			min-width: 0;
			overflow-x: auto;
			overflow-y: hidden;
			padding: 0.55rem;
			scrollbar-width: none;
		}

		.primary-nav::-webkit-scrollbar {
			display: none;
		}

		.mobile-nav-groups {
			flex: 0 0 auto;
			flex-direction: row;
			gap: 0.25rem;
		}

		.primary-nav a {
			min-width: 2.35rem;
		}
	}
</style>
