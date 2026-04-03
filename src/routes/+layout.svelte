<script lang="ts">
	import '../app.css';
	import '@xyflow/svelte/dist/style.css';
	import { setContext, onMount } from 'svelte';
	import { page } from '$app/state';
	import { createUiStore } from '$lib/stores/ui.svelte';
	import Sidebar from '$lib/components/sidebar.svelte';
	import { Toaster } from '$lib/components/ui/sonner';

	let { children, data } = $props();

	const ui = createUiStore();
	setContext('ui', ui);

	let isAuthPage = $derived(page.url.pathname.startsWith('/auth'));

	// Initialize theme from server data (cookie) or system preference
	onMount(() => {
		const savedTheme = data.theme;
		if (savedTheme === 'dark' || savedTheme === 'light') {
			ui.setTheme(savedTheme);
		} else {
			ui.setTheme('system');
		}
	});
</script>

<svelte:head>
	<title>Workflow Builder</title>
	<meta name="description" content="AI Workflow Builder - Visual Workflow Automation" />
</svelte:head>

{#if isAuthPage}
	{@render children()}
{:else}
	<div class="flex h-full">
		<Sidebar collapsed={ui.sidebarCollapsed} onToggle={ui.toggleSidebar} user={data.user} />
		<main class="flex-1 overflow-hidden">
			{@render children()}
		</main>
	</div>
{/if}

<Toaster richColors closeButton />
