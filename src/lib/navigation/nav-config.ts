/**
 * Single source of truth for sidebar navigation.
 *
 * Phase 1 parity: this file reproduces the nav items hardcoded in
 * sidebar.svelte as of the IA-consolidation cutover. Later phases rewrite
 * the groups + items per `plans/review-our-workflow-builder-sveltekit-abundant-gem.md`
 * (3-group IA with Admin strip). Keeping the refactor non-breaking here means
 * future phases just edit this file rather than touching the component.
 *
 * Active-state matching uses route-id regex (not pathname prefix) so deep
 * routes like `/workspaces/foo/sessions/abc` still highlight `Sessions`.
 */

import {
	GitBranch,
	Bot,
	Activity,
	MessageSquare,
	Server,
	Container,
	Network,
	Layers,
	Library as LibraryIcon,
	KeyRound,
	Plug,
	MessagesSquare,
	BarChart3,
	DollarSign,
	FileText,
	Shield,
	Users,
	Key,
	Gauge,
	Wrench,
	Cpu,
	Settings as SettingsIcon,
	FlaskConical,
	Trophy,
} from "@lucide/svelte";

// Lucide icons ship as component constructors — `typeof <Icon>` is the
// constructor type (matches the original sidebar's `typeof GitBranch` pattern).
type LucideIcon = typeof GitBranch;

export type NavContext = {
	/** Active workspace slug — always resolved upstream. */
	slug: string;
	/** Platform role. Admin-only items are filtered by visibility. */
	platformRole: "ADMIN" | "MEMBER";
};

export type NavVisibility = {
	adminOnly?: boolean;
	/** Items rendered only when a workspace slug is available. */
	workspaceScoped?: boolean;
};

export type NavItem = {
	/** Stable id for analytics + active-state memoization. */
	id: string;
	label: string;
	icon: LucideIcon;
	/** Build href from context so workspace-scoped items pick up the active slug. */
	href: (ctx: NavContext) => string;
	/**
	 * Regex matched against `page.url.pathname` to decide active state.
	 * Pathname (not route id) because route groups would require extra plumbing
	 * and the URL is already the source of truth the user sees.
	 */
	match: RegExp;
	badge?: "new" | "beta";
	visibility?: NavVisibility;
};

export type NavGroup = {
	id:
		| "build"
		| "managed-agents"
		| "optimize"
		| "analytics"
		| "operate"
		| "manage"
		| "admin";
	label: string;
	icon: LucideIcon;
	badge?: string;
	defaultOpen?: boolean;
	visibility?: NavVisibility;
	items: NavItem[];
};

/** Prefix match helper: true when pathname equals `href` or starts with `href/`. */
function prefix(href: string): RegExp {
	// Escape regex-special chars; we treat the href as a literal prefix.
	const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped}(/|$)`);
}

/**
 * Phase 1 nav — intentionally identical to the pre-refactor sidebar.
 * Phases 2–5 rewrite this file (not the component) to land the target IA.
 */
export const NAV_GROUPS: NavGroup[] = [
	{
		id: "build",
		label: "Build",
		icon: Wrench,
		defaultOpen: true,
		items: [
			{
				id: "workbench",
				label: "Workbench",
				icon: MessageSquare,
				href: () => "/workbench",
				match: prefix("/workbench"),
			},
			{
				id: "workflows",
				label: "Workflows",
				icon: GitBranch,
				href: ({ slug }) => `/workspaces/${slug}/workflows`,
				match: /^\/workspaces\/[^/]+\/workflows(\/|$)/,
				visibility: { workspaceScoped: true },
			},
			{
				id: "library",
				label: "Library",
				icon: LibraryIcon,
				href: ({ slug }) => `/workspaces/${slug}/library`,
				// Match the hub page OR any of its sub-surfaces (skills/files/
				// batches/code-functions) so nav highlights consistently across
				// the consolidated set.
				match:
					/^\/(workspaces\/[^/]+\/(library|skills|files|batches)|code-functions)(\/|$)/,
				visibility: { workspaceScoped: true },
			},
			{
				id: "prompts",
				label: "Prompts",
				icon: FileText,
				href: ({ slug }) => `/workspaces/${slug}/prompts`,
				match: /^\/workspaces\/[^/]+\/prompts(\/|$)/,
				visibility: { workspaceScoped: true },
			},
		],
	},
	{
		id: "managed-agents",
		label: "Managed Agents",
		icon: Bot,
		badge: "New",
		defaultOpen: true,
		items: [
			{
				id: "agents",
				label: "Agents",
				icon: Bot,
				href: ({ slug }) => `/workspaces/${slug}/agents`,
				match: /^\/workspaces\/[^/]+\/agents(\/|$)/,
				visibility: { workspaceScoped: true },
			},
			{
				id: "runs",
				label: "Runs",
				icon: Activity,
				href: ({ slug }) => `/workspaces/${slug}/runs`,
				match: /^\/workspaces\/[^/]+\/runs(\/|$)/,
				visibility: { workspaceScoped: true },
			},
			{
				id: "sessions",
				label: "Sessions",
				icon: MessagesSquare,
				href: ({ slug }) => `/workspaces/${slug}/sessions`,
				match: /^\/workspaces\/[^/]+\/sessions(\/|$)/,
				visibility: { workspaceScoped: true },
			},
			{
				id: "environments",
				label: "Environments",
				icon: Layers,
				href: ({ slug }) => `/workspaces/${slug}/environments`,
				match: /^\/workspaces\/[^/]+\/environments(\/|$)/,
				visibility: { workspaceScoped: true },
			},
			{
				id: "credentials",
				label: "Credentials",
				icon: KeyRound,
				href: ({ slug }) => `/workspaces/${slug}/credentials`,
				match: /^\/workspaces\/[^/]+\/credentials(\/|$)/,
				visibility: { workspaceScoped: true },
			},
			{
				id: "connections",
				label: "Integrations",
				icon: Plug,
				href: ({ slug }) => `/workspaces/${slug}/connections`,
				match: /^\/workspaces\/[^/]+\/connections(\/|$)/,
				visibility: { workspaceScoped: true },
			},
		],
	},
	{
		id: "optimize",
		label: "Optimize",
		icon: FlaskConical,
		defaultOpen: true,
		items: [
			{
				id: "evaluations",
				label: "Evaluations",
				icon: FlaskConical,
				href: ({ slug }) => `/workspaces/${slug}/evaluations`,
				match: /^\/workspaces\/[^/]+\/evaluations(\/|$)/,
				visibility: { workspaceScoped: true },
			},
			{
				id: "benchmarks",
				label: "Benchmarks",
				icon: Trophy,
				href: ({ slug }) => `/workspaces/${slug}/benchmarks`,
				match: /^\/workspaces\/[^/]+\/benchmarks(\/|$)/,
				visibility: { workspaceScoped: true },
			},
		],
	},
	{
		id: "analytics",
		label: "Analytics",
		icon: BarChart3,
		items: [
			{
				id: "usage",
				label: "Usage",
				icon: BarChart3,
				href: ({ slug }) => `/workspaces/${slug}/usage`,
				match: /^\/workspaces\/[^/]+\/usage(\/|$)/,
				visibility: { workspaceScoped: true },
			},
			{
				id: "cost",
				label: "Cost",
				icon: DollarSign,
				href: ({ slug }) => `/workspaces/${slug}/cost`,
				match: /^\/workspaces\/[^/]+\/cost(\/|$)/,
				visibility: { workspaceScoped: true },
			},
			{
				id: "logs",
				label: "Logs",
				icon: FileText,
				href: ({ slug }) => `/workspaces/${slug}/logs`,
				match: /^\/workspaces\/[^/]+\/logs(\/|$)/,
				visibility: { workspaceScoped: true },
			},
		],
	},
	{
		id: "operate",
		label: "Operate",
		icon: Activity,
		items: [
			{
				id: "capacity",
				label: "Capacity",
				icon: Gauge,
				href: ({ slug }) => `/workspaces/${slug}/capacity`,
				match: /^\/workspaces\/[^/]+\/capacity(\/|$)/,
				visibility: { workspaceScoped: true },
			},
			{
				id: "service-graph",
				label: "Service graph",
				icon: Network,
				href: ({ slug }) => `/workspaces/${slug}/service-graph`,
				match: /^\/workspaces\/[^/]+\/service-graph(\/|$)/,
				badge: "new",
				visibility: { workspaceScoped: true },
			},
			{
				id: "kubernetes",
				label: "Kubernetes",
				icon: Server,
				href: ({ slug }) => `/workspaces/${slug}/kubernetes`,
				match: /^\/workspaces\/[^/]+\/kubernetes(\/|$)/,
				visibility: { workspaceScoped: true, adminOnly: true },
			},
			{
				id: "mlflow",
				label: "MLflow",
				icon: BarChart3,
				href: ({ slug }) => `/workspaces/${slug}/mlflow`,
				match: /^\/workspaces\/[^/]+\/mlflow(\/|$)/,
				visibility: { workspaceScoped: true, adminOnly: true },
			},
			{
				id: "argocd",
				label: "Argo CD",
				icon: GitBranch,
				href: ({ slug }) => `/workspaces/${slug}/argocd`,
				match: /^\/workspaces\/[^/]+\/argocd(\/|$)/,
				visibility: { workspaceScoped: true, adminOnly: true },
			},
			{
				id: "sandboxes",
				label: "Sandboxes",
				icon: Container,
				href: () => "/sandboxes",
				match: prefix("/sandboxes"),
			},
		],
	},
	// Admin strip — only rendered when platformRole === 'ADMIN'. The route-level
	// 403 in (admin)/+layout.server.ts is the actual gate; this just prevents
	// the group from visually competing with product nouns for MEMBER users.
	{
		id: "admin",
		label: "Admin",
		icon: Shield,
		visibility: { adminOnly: true },
		items: [
			{
				id: "admin-metrics",
				label: "Metrics",
				icon: Gauge,
				href: () => "/admin/metrics",
				match: prefix("/admin/metrics"),
			},
			{
				id: "admin-runtimes",
				label: "Agent runtimes",
				icon: Cpu,
				href: () => "/admin/runtimes",
				match: prefix("/admin/runtimes"),
			},
			{
				id: "admin-instances",
				label: "Workflow instances",
				icon: Activity,
				href: () => "/admin/instances",
				match: prefix("/admin/instances"),
			},
			{
				id: "admin-deployments",
				label: "Deployments",
				icon: Container,
				href: () => "/admin/deployments",
				match: prefix("/admin/deployments"),
			},
			{
				id: "admin-gitops",
				label: "GitOps details",
				icon: GitBranch,
				href: () => "/admin/gitops",
				match: /^\/admin\/gitops\/?$/,
			},
			{
				id: "admin-gitops-system",
				label: "GitOps pipeline",
				icon: GitBranch,
				href: () => "/admin/gitops/system",
				match: prefix("/admin/gitops/system"),
			},
			{
				id: "admin-dapr",
				label: "Dapr system",
				icon: Network,
				href: () => "/admin/dapr",
				match: prefix("/admin/dapr"),
			},
			{
				id: "admin-activities",
				label: "Activities",
				icon: Server,
				href: () => "/admin/activities",
				match: prefix("/admin/activities"),
			},
		],
	},
	{
		id: "manage",
		label: "Manage",
		icon: SettingsIcon,
		items: [
			{
				id: "api-keys",
				label: "API keys",
				icon: Key,
				href: ({ slug }) => `/workspaces/${slug}/settings/keys`,
				match: /^\/workspaces\/[^/]+\/settings\/keys(\/|$)/,
				visibility: { workspaceScoped: true },
			},
			{
				id: "limits",
				label: "Limits",
				icon: Gauge,
				href: ({ slug }) => `/workspaces/${slug}/settings/limits`,
				match: /^\/workspaces\/[^/]+\/settings\/limits(\/|$)/,
				visibility: { workspaceScoped: true },
			},
			{
				id: "platform-settings",
				label: "Platform settings",
				icon: SettingsIcon,
				href: () => "/settings",
				match: /^\/settings\/?$/,
			},
			{
				id: "members",
				label: "Members",
				icon: Users,
				href: () => "/settings/members",
				match: prefix("/settings/members"),
			},
			{
				id: "security",
				label: "Security & compliance",
				icon: Shield,
				href: () => "/settings/security",
				match: prefix("/settings/security"),
			},
		],
	},
];

/** Filter groups + items against the runtime context (workspace + role). */
export function resolveNav(ctx: NavContext): NavGroup[] {
	return NAV_GROUPS.map((group) => {
		if (!visibilityAllows(group.visibility, ctx)) return null;
		const items = group.items.filter((item) =>
			visibilityAllows(item.visibility, ctx)
		);
		if (items.length === 0) return null;
		return { ...group, items };
	}).filter((g): g is NavGroup => g !== null);
}

function visibilityAllows(
	visibility: NavVisibility | undefined,
	ctx: NavContext
): boolean {
	if (!visibility) return true;
	if (visibility.adminOnly && ctx.platformRole !== "ADMIN") return false;
	// Workspace-scoped items always render at Phase 1 (the component falls
	// back to DEFAULT_WORKSPACE_SLUG when no slug is active). Later phases
	// may hide them outright when no workspace is selected.
	return true;
}
