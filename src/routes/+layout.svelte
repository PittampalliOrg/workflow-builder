<script lang="ts">
	import '../app.css';
	import '@xyflow/svelte/dist/style.css';
	import { setContext, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { createUiStore } from '$lib/stores/ui.svelte';
	import { createAiAssistantStore } from '$lib/stores/ai-assistant.svelte';
	import { createBuildWorkflowStore } from '$lib/stores/build-workflow.svelte';
	import Sidebar from '$lib/components/sidebar.svelte';
	import GlobalPalette from '$lib/components/cmdk/global-palette.svelte';
	import FeedbackWidget from '$lib/components/chrome/feedback-widget.svelte';
	import { Toaster } from '$lib/components/ui/sonner';

	let { children, data } = $props();

	const ui = createUiStore();
	setContext('ui', ui);

	const aiAssistant = createAiAssistantStore();
	setContext('ai-assistant', aiAssistant);

	const buildWorkflow = createBuildWorkflowStore();
	setContext('build-workflow', buildWorkflow);

	let isAuthPage = $derived(page.url.pathname.startsWith('/auth'));
	let routeKey = $derived(page.url.pathname);

	// Initialize theme from server data (cookie) or system preference.
	// Also install the X-Workspace fetch wrapper so workspace-scoped URL
	// context follows API calls automatically — hooks.server.ts reads the
	// header and overrides locals.session.projectId for the duration of
	// the request. Matches CMA's pattern of scoping API reads by the
	// active workspace even though the JWT itself is org-scoped.
	onMount(() => {
		const savedTheme = data.theme;
		if (savedTheme === 'dark' || savedTheme === 'light') {
			ui.setTheme(savedTheme);
		} else {
			ui.setTheme('system');
		}

		if (typeof window !== 'undefined' && !('__wsFetchPatched' in window)) {
			const orig = window.fetch.bind(window);
			window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
				const slug = page.params?.slug;
				if (!slug) return orig(input, init);
				// Only attach for same-origin requests; don't leak the
				// header to third-party hosts.
				const urlStr =
					typeof input === 'string'
						? input
						: input instanceof URL
							? input.href
							: input.url;
				const isSameOrigin =
					urlStr.startsWith('/') ||
					urlStr.startsWith(window.location.origin);
				if (!isSameOrigin) return orig(input, init);
				const headers = new Headers(init?.headers ?? {});
				if (!headers.has('X-Workspace')) {
					headers.set('X-Workspace', slug);
				}
				return orig(input, { ...(init ?? {}), headers });
			}) as typeof window.fetch;
			(window as Window & { __wsFetchPatched?: boolean }).__wsFetchPatched =
				true;
		}
	});

	function handleGlobalKeydown(e: KeyboardEvent) {
		const mod = e.metaKey || e.ctrlKey;
		// Cmd/Ctrl+Shift+A = Toggle right panel with AI tab
		if (mod && e.shiftKey && e.key === 'a') {
			e.preventDefault();
			ui.toggleRightPanel('ai');
		}
		// Cmd/Ctrl+Shift+R = Toggle right panel with Runs tab
		if (mod && e.shiftKey && e.key === 'r') {
			e.preventDefault();
			ui.toggleRightPanel('runs');
		}
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<svelte:head>
	<title>Workflow Builder</title>
	<meta name="description" content="AI Workflow Builder - Visual Workflow Automation" />
</svelte:head>

{#if isAuthPage}
	{#key routeKey}
		{@render children()}
	{/key}
{:else}
	<div class="flex h-full">
		<Sidebar
			collapsed={ui.sidebarCollapsed}
			onToggle={ui.toggleSidebar}
			user={data.user}
			platformRole={data.platformRole}
		/>
		<main class="flex-1 overflow-hidden">
			{#key routeKey}
				{@render children()}
			{/key}
		</main>
	</div>
	{#if browser}
		<GlobalPalette />
		<FeedbackWidget />
	{/if}
{/if}

<Toaster richColors closeButton />
