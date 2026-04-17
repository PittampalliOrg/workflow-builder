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

	// Initialize theme from server data (cookie) or system preference
	onMount(() => {
		const savedTheme = data.theme;
		if (savedTheme === 'dark' || savedTheme === 'light') {
			ui.setTheme(savedTheme);
		} else {
			ui.setTheme('system');
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
		<Sidebar collapsed={ui.sidebarCollapsed} onToggle={ui.toggleSidebar} user={data.user} />
		<main class="flex-1 overflow-hidden">
			{#key routeKey}
				{@render children()}
			{/key}
		</main>
	</div>
	{#if browser}
		<GlobalPalette />
	{/if}
{/if}

<Toaster richColors closeButton />
