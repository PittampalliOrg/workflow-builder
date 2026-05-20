<script lang="ts">
	import {
		Activity,
		Box,
		Boxes,
		Braces,
		FolderGit2,
		GitBranch,
		Network,
		Settings,
		ShieldCheck,
	} from "@lucide/svelte";

	import EmbeddedAppShell, {
		type EmbeddedAppNavItem,
	} from "$lib/components/embedded-apps/EmbeddedAppShell.svelte";
	import { DEFAULT_ARGOCD_EMBED_BASE } from "$lib/embedded-apps/links";
	import type { PageData } from "./$types";

	let { data }: { data: PageData } = $props();

	const navItems: EmbeddedAppNavItem[] = [
		{
			id: "applications",
			label: "Applications",
			icon: Boxes,
			path: "/applications",
			match: (path) => path === "/" || path.startsWith("/applications"),
		},
		{
			id: "workflow-builder",
			label: "Workflow Builder apps",
			icon: GitBranch,
			path: "/applications?search=workflow-builder",
			match: (path) => path.includes("workflow-builder"),
		},
		{
			id: "promoter",
			label: "Promotions",
			icon: Activity,
			path: "/applications?search=promoter",
			match: (path) => path.includes("promoter"),
		},
		{
			id: "projects",
			label: "Projects",
			icon: FolderGit2,
			path: "/settings/projects",
			match: (path) => path.startsWith("/settings/projects"),
		},
		{
			id: "clusters",
			label: "Clusters",
			icon: Network,
			path: "/settings/clusters",
			match: (path) => path.startsWith("/settings/clusters"),
		},
		{
			id: "repositories",
			label: "Repositories",
			icon: Box,
			path: "/settings/repos",
			match: (path) => path.startsWith("/settings/repos"),
		},
		{
			id: "extensions",
			label: "Extensions",
			icon: Braces,
			path: "/extensions",
			match: (path) => path.startsWith("/extensions"),
		},
		{
			id: "settings",
			label: "Settings",
			icon: Settings,
			path: "/settings",
			match: (path) => path.startsWith("/settings"),
		},
	];

	const unifiedCss = `
		.sidebar,
		.sidebar__content,
		.sidebar__logo,
		nav.sidebar,
		[qe-id="applications-list-toolbar"] .argo-button--base:first-child {
			display: none !important;
		}
		.top-bar {
			left: 0 !important;
			width: 100% !important;
		}
		.application-details,
		.applications-list,
		.page,
		.page-wrapper,
		main {
			margin-left: 0 !important;
			padding-left: 0 !important;
			max-width: none !important;
			width: 100% !important;
		}
		body,
		#app {
			min-height: 100vh !important;
			background: #f7f8fa !important;
		}
	`;

	function pathLabel(path: string) {
		if (path === "/") return "Applications";
		try {
			return decodeURIComponent(path.replace(/^\//, ""));
		} catch {
			return path;
		}
	}
</script>

<EmbeddedAppShell
	workspaceSlug={data.slug}
	title="Argo CD"
	frameTitle="Argo CD"
	appIcon={ShieldCheck}
	appIconLabel="Argo CD"
	defaultEmbedBase={DEFAULT_ARGOCD_EMBED_BASE}
	embedBase={data.embedBase}
	path={data.path}
	externalHref={data.externalHref}
	externalLabel="Open in Argo CD"
	nativeChromeLabel="Show native Argo CD chrome"
	reloadLabel="Reload Argo CD"
	{navItems}
	{pathLabel}
	{unifiedCss}
/>
