<script lang="ts">
	import {
		Activity,
		BarChart3,
		Brain,
		FlaskConical,
		LineChart,
		PackageOpen,
		Search,
	} from "@lucide/svelte";

	import EmbeddedAppShell, {
		type EmbeddedAppNavItem,
	} from "$lib/components/embedded-apps/EmbeddedAppShell.svelte";
	import { DEFAULT_MLFLOW_EMBED_BASE } from "$lib/embedded-apps/links";
	import type { PageData } from "./$types";

	let { data }: { data: PageData } = $props();

	const navItems: EmbeddedAppNavItem[] = [
		{
			id: "overview",
			label: "Overview",
			icon: Activity,
			path: "/",
			match: (path) => path === "/" || path === "/#/" || path === "/#/experiments",
		},
		{
			id: "experiments",
			label: "Experiments",
			icon: FlaskConical,
			path: "/#/experiments",
			match: (path) => path.includes("/experiments"),
		},
		{
			id: "traces",
			label: "Traces",
			icon: Search,
			path: "/#/traces",
			match: (path) => path.includes("/traces"),
		},
		{
			id: "models",
			label: "Models",
			icon: Brain,
			path: "/#/models",
			match: (path) => path.includes("/models") || path.includes("/registered-models"),
		},
		{
			id: "runs",
			label: "Runs",
			icon: LineChart,
			path: "/#/experiments",
			match: (path) => path.includes("/runs"),
		},
		{
			id: "artifacts",
			label: "Artifacts",
			icon: PackageOpen,
			path: "/#/experiments",
			match: (path) => path.includes("/artifacts"),
		},
	];

	const unifiedCss = `
		nav[role="navigation"],
		aside,
		[class*="Sidebar"],
		[class*="sidebar"],
		[class*="Navigation"],
		[class*="navigation"] {
			display: none !important;
		}
		header,
		[class*="Header"],
		[class*="header"] {
			min-height: 0 !important;
		}
		body,
		#root,
		.mlflow-ui-container {
			min-height: 100vh !important;
			background: hsl(0 0% 100%) !important;
		}
		#root > div,
		main,
		[role="main"] {
			margin-left: 0 !important;
			padding-left: 0 !important;
			width: 100% !important;
			max-width: none !important;
		}
	`;

	function pathLabel(path: string) {
		if (path === "/" || path === "/#/") return "Overview";
		try {
			return decodeURIComponent(path.replace(/^\/#\/?/, ""));
		} catch {
			return path;
		}
	}
</script>

<EmbeddedAppShell
	workspaceSlug={data.slug}
	title="MLflow"
	frameTitle="MLflow"
	appIcon={BarChart3}
	appIconLabel="MLflow"
	defaultEmbedBase={DEFAULT_MLFLOW_EMBED_BASE}
	embedBase={data.embedBase}
	path={data.path}
	externalHref={data.externalHref}
	externalLabel="Open in MLflow"
	nativeChromeLabel="Show native MLflow chrome"
	reloadLabel="Reload MLflow"
	{navItems}
	{pathLabel}
	{unifiedCss}
/>
