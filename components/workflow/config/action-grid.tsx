"use client";

import {
	Bell,
	Bot,
	Braces,
	ChevronRight,
	Clock,
	Database,
	Eye,
	EyeOff,
	GitBranch,
	Globe,
	Grid3X3,
	List,
	MoreHorizontal,
	Radio,
	Repeat,
	Search,
	Settings,
	ShieldCheck,
	Sparkles,
	StickyNote,
	Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api-client";
import { usePiecesCatalog } from "@/lib/actions/pieces-store";
import type { IntegrationDefinition } from "@/lib/actions/types";
import { useIsTouch } from "@/hooks/use-touch";
import { getAllDaprActivities } from "@/lib/dapr-activity-registry";
import { cn } from "@/lib/utils";
import type { WorkflowNodeType } from "@/lib/workflow-store";

type ActionType = {
	id: string;
	label: string;
	description: string;
	category: string;
	integration?: string;
	logoUrl?: string;
	// Dapr-specific fields
	isDaprActivity?: boolean;
	nodeType?: WorkflowNodeType;
	activityName?: string;
};

// System actions that don't have plugins
const SYSTEM_ACTIONS: ActionType[] = [
	{
		id: "system/http-request",
		label: "HTTP Request",
		description: "Make an HTTP request to any API",
		category: "System",
	},
	{
		id: "system/database-query",
		label: "Database Query",
		description: "Query your database",
		category: "System",
	},
	{
		id: "system/condition",
		label: "Condition",
		description: "Branch based on a condition",
		category: "System",
	},
	{
		id: "system/ai-text",
		label: "AI Text Generation",
		description: "Generate text using an LLM (OpenAI or Anthropic)",
		category: "System",
	},
	{
		id: "system/ai-structured",
		label: "AI Structured Output",
		description:
			"Extract structured data from text using an LLM with a JSON schema",
		category: "System",
	},
];

// Dapr control flow actions (not regular activities)
const DAPR_CONTROL_FLOW: ActionType[] = [
	{
		id: "dapr:approval-gate",
		label: "Approval Gate",
		description: "Wait for external approval with timeout",
		category: "Control Flow",
		isDaprActivity: true,
		nodeType: "approval-gate",
	},
	{
		id: "dapr:timer",
		label: "Timer",
		description: "Wait for a specified duration",
		category: "Control Flow",
		isDaprActivity: true,
		nodeType: "timer",
	},
	{
		id: "dapr:loop-until",
		label: "Loop Until",
		description: "Repeat a section until a condition is met",
		category: "Control Flow",
		isDaprActivity: true,
		nodeType: "loop-until",
	},
	{
		id: "dapr:if-else",
		label: "If / Else",
		description: "Branch based on a condition",
		category: "Control Flow",
		isDaprActivity: true,
		nodeType: "if-else",
	},
	{
		id: "dapr:set-state",
		label: "Set State",
		description: "Set a workflow-scoped variable",
		category: "State",
		isDaprActivity: true,
		nodeType: "set-state",
	},
	{
		id: "dapr:transform",
		label: "Transform",
		description: "Build structured output from a JSON template",
		category: "State",
		isDaprActivity: true,
		nodeType: "transform",
	},
	{
		id: "dapr:note",
		label: "Note",
		description: "Add a non-executing annotation",
		category: "Core",
		isDaprActivity: true,
		nodeType: "note",
	},
];

// Combine System actions with Dapr activities and ActivePieces actions
function useAllActions(apPieces: IntegrationDefinition[]): ActionType[] {
	return useMemo(() => {
		// Map Dapr activities to ActionType format
		const daprActivities = getAllDaprActivities();
		const mappedDaprActivities: ActionType[] = daprActivities.map(
			(activity) => ({
				id: `dapr:${activity.name}`,
				label: activity.label,
				description: activity.description,
				category: activity.category,
				isDaprActivity: true,
				nodeType: "activity",
				activityName: activity.name,
			}),
		);

		// Map AP pieces to ActionType format (each piece = category, each action = item)
		const mappedApActions: ActionType[] = apPieces.flatMap((piece) =>
			piece.actions.map((action) => ({
				id: `${piece.type}/${action.slug}`,
				label: action.label,
				description: action.description || "",
				category: piece.label,
				integration: piece.type,
				logoUrl: piece.logoUrl,
			})),
		);

		return [
			...SYSTEM_ACTIONS,
			...DAPR_CONTROL_FLOW,
			...mappedDaprActivities,
			...mappedApActions,
		];
	}, [apPieces]);
}

export type ActionSelection = {
	actionType: string;
	isDaprActivity?: boolean;
	nodeType?: WorkflowNodeType;
	activityName?: string;
};

type ActionGridProps = {
	onSelectAction: (selection: ActionSelection) => void;
	disabled?: boolean;
	isNewlyCreated?: boolean;
};

// Category icons for Dapr activities
const DAPR_CATEGORY_ICONS: Record<string, typeof Zap> = {
	Agent: Bot,
	State: Database,
	Events: Radio,
	"Control Flow": Clock,
	AI: Sparkles,
	Core: List,
	Notifications: Bell,
	Integration: Globe,
};

function GroupIcon({
	group,
}: {
	group: { category: string; actions: ActionType[] };
}) {
	// For plugin categories, use the integration icon from the first action
	const firstAction = group.actions[0];
	if (firstAction?.integration) {
		return (
			<IntegrationIcon
				className="size-4"
				integration={firstAction.integration}
				logoUrl={firstAction.logoUrl}
			/>
		);
	}
	// For System category
	if (group.category === "System") {
		return <Settings className="size-4" />;
	}
	// For Dapr categories
	const DaprIcon = DAPR_CATEGORY_ICONS[group.category];
	if (DaprIcon) {
		return <DaprIcon className="size-4" />;
	}
	return <Zap className="size-4" />;
}

function ActionIcon({
	action,
	className,
}: {
	action: ActionType;
	className?: string;
}) {
	if (action.integration) {
		return (
			<IntegrationIcon
				className={className}
				integration={action.integration}
				logoUrl={action.logoUrl}
			/>
		);
	}
	if (action.category === "System") {
		return <Settings className={cn(className, "text-muted-foreground")} />;
	}
	// For Dapr categories
	const DaprIcon = DAPR_CATEGORY_ICONS[action.category];
	if (DaprIcon) {
		return <DaprIcon className={cn(className, "text-muted-foreground")} />;
	}
	// Special icons for specific Dapr nodes
	if (action.nodeType === "approval-gate") {
		return <ShieldCheck className={cn(className, "text-muted-foreground")} />;
	}
	if (action.nodeType === "timer") {
		return <Clock className={cn(className, "text-muted-foreground")} />;
	}
	if (action.nodeType === "loop-until") {
		return <Repeat className={cn(className, "text-muted-foreground")} />;
	}
	if (action.nodeType === "if-else") {
		return <GitBranch className={cn(className, "text-muted-foreground")} />;
	}
	if (action.nodeType === "set-state") {
		return <Database className={cn(className, "text-muted-foreground")} />;
	}
	if (action.nodeType === "transform") {
		return <Braces className={cn(className, "text-muted-foreground")} />;
	}
	if (action.nodeType === "note") {
		return <StickyNote className={cn(className, "text-muted-foreground")} />;
	}
	return <Zap className={cn(className, "text-muted-foreground")} />;
}

// Local storage keys
const HIDDEN_GROUPS_KEY = "workflow-action-grid-hidden-groups";
const VIEW_MODE_KEY = "workflow-action-grid-view-mode";

type ViewMode = "list" | "grid";

function getInitialHiddenGroups(): Set<string> {
	if (typeof window === "undefined") {
		return new Set();
	}
	try {
		const stored = localStorage.getItem(HIDDEN_GROUPS_KEY);
		return stored ? new Set(JSON.parse(stored)) : new Set();
	} catch {
		return new Set();
	}
}

function getInitialViewMode(): ViewMode {
	if (typeof window === "undefined") {
		return "list";
	}
	try {
		const stored = localStorage.getItem(VIEW_MODE_KEY);
		return stored === "grid" ? "grid" : "list";
	} catch {
		return "list";
	}
}

export function ActionGrid({
	onSelectAction,
	disabled,
	isNewlyCreated,
}: ActionGridProps) {
	const [filter, setFilter] = useState("");
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
		new Set(),
	);
	const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(
		getInitialHiddenGroups,
	);
	const [showHidden, setShowHidden] = useState(false);
	const [viewMode, setViewMode] = useState<ViewMode>(getInitialViewMode);
	const { pieces: catalogPieces, mergePieces } = usePiecesCatalog();
	const [fallbackPieces, setFallbackPieces] = useState<IntegrationDefinition[]>(
		[],
	);
	const [searchPieces, setSearchPieces] = useState<
		IntegrationDefinition[] | null
	>(null);
	const searchRequestIdRef = useRef(0);
	const basePieces = catalogPieces.length > 0 ? catalogPieces : fallbackPieces;
	const trimmedFilter = filter.trim();
	const apPieces = trimmedFilter ? (searchPieces ?? basePieces) : basePieces;
	const actions = useAllActions(apPieces);
	const inputRef = useRef<HTMLInputElement>(null);
	const isTouch = useIsTouch();
	const triedFallbackFetchRef = useRef(false);

	// If shared catalog is empty, fall back to direct pieces endpoint once.
	useEffect(() => {
		if (catalogPieces.length > 0) {
			return;
		}
		if (triedFallbackFetchRef.current) {
			return;
		}

		triedFallbackFetchRef.current = true;

		fetch("/api/pieces/actions")
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => {
				if (Array.isArray(data?.pieces)) {
					setFallbackPieces(data.pieces as IntegrationDefinition[]);
				}
			})
			.catch(() => {
				// Keep UI usable with system/control-flow actions even if pieces fail.
			});
	}, [catalogPieces.length]);

	useEffect(() => {
		if (!trimmedFilter) {
			setSearchPieces(null);
			return;
		}

		const requestId = searchRequestIdRef.current + 1;
		searchRequestIdRef.current = requestId;

		const timeoutId = window.setTimeout(() => {
			api.piece
				.actions({
					searchQuery: trimmedFilter,
					limit: 150,
					scope: "installed",
				})
				.then((response) => {
					if (searchRequestIdRef.current !== requestId) {
						return;
					}
					const pieces = Array.isArray(response?.pieces) ? response.pieces : [];
					setSearchPieces(pieces);
					mergePieces(pieces);
				})
				.catch(() => {
					if (searchRequestIdRef.current !== requestId) {
						return;
					}
					setSearchPieces(null);
				});
		}, 180);

		return () => window.clearTimeout(timeoutId);
	}, [trimmedFilter, mergePieces]);

	const toggleViewMode = () => {
		const newMode = viewMode === "list" ? "grid" : "list";
		setViewMode(newMode);
		localStorage.setItem(VIEW_MODE_KEY, newMode);
	};

	const toggleGroup = (category: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(category)) {
				next.delete(category);
			} else {
				next.add(category);
			}
			return next;
		});
	};

	const toggleHideGroup = (category: string) => {
		setHiddenGroups((prev) => {
			const next = new Set(prev);
			if (next.has(category)) {
				next.delete(category);
			} else {
				next.add(category);
			}
			// Persist to localStorage
			localStorage.setItem(HIDDEN_GROUPS_KEY, JSON.stringify([...next]));
			return next;
		});
	};

	useEffect(() => {
		// Only focus after touch detection is complete (isTouch !== undefined)
		// and only on non-touch devices to avoid opening the keyboard
		if (isNewlyCreated && isTouch === false && inputRef.current) {
			inputRef.current.focus();
		}
	}, [isNewlyCreated, isTouch]);

	const filteredActions = actions.filter((action) => {
		const searchTerm = filter.toLowerCase();
		return (
			action.label.toLowerCase().includes(searchTerm) ||
			action.description.toLowerCase().includes(searchTerm) ||
			action.category.toLowerCase().includes(searchTerm)
		);
	});

	// Group actions by category
	const groupedActions = useMemo(() => {
		const groups: Record<string, ActionType[]> = {};

		for (const action of filteredActions) {
			const category = action.category;
			if (!groups[category]) {
				groups[category] = [];
			}
			groups[category].push(action);
		}

		// Sort categories: System first, then alphabetically
		const sortedCategories = Object.keys(groups).sort((a, b) => {
			if (a === "System") {
				return -1;
			}
			if (b === "System") {
				return 1;
			}
			return a.localeCompare(b);
		});

		return sortedCategories.map((category) => ({
			category,
			actions: groups[category],
		}));
	}, [filteredActions]);

	// Filter groups based on hidden state
	const visibleGroups = useMemo(() => {
		if (showHidden) {
			return groupedActions;
		}
		return groupedActions.filter((g) => !hiddenGroups.has(g.category));
	}, [groupedActions, hiddenGroups, showHidden]);

	// If all groups are hidden, automatically reveal hidden groups to prevent
	// the panel from appearing empty when actions are loaded.
	useEffect(() => {
		if (showHidden) {
			return;
		}
		if (groupedActions.length === 0) {
			return;
		}
		if (visibleGroups.length === 0 && hiddenGroups.size > 0) {
			setShowHidden(true);
		}
	}, [
		showHidden,
		groupedActions.length,
		visibleGroups.length,
		hiddenGroups.size,
	]);

	const hiddenCount = hiddenGroups.size;

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex shrink-0 gap-2">
				<div className="relative flex-1">
					<Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						className="pl-9"
						data-testid="action-search-input"
						disabled={disabled}
						id="action-filter"
						onChange={(e) => setFilter(e.target.value)}
						placeholder="Search actions..."
						ref={inputRef}
						value={filter}
					/>
				</div>
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								className="shrink-0"
								onClick={toggleViewMode}
								size="icon"
								variant="ghost"
							>
								{viewMode === "list" ? (
									<Grid3X3 className="size-4" />
								) : (
									<List className="size-4" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{viewMode === "list" ? "Grid view" : "List view"}
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
				{hiddenCount > 0 && (
					<TooltipProvider>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									className={cn("shrink-0", showHidden && "bg-muted")}
									onClick={() => setShowHidden(!showHidden)}
									size="icon"
									variant="ghost"
								>
									{showHidden ? (
										<Eye className="size-4" />
									) : (
										<EyeOff className="size-4" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{showHidden
									? "Hide hidden groups"
									: `Show ${hiddenCount} hidden group${hiddenCount > 1 ? "s" : ""}`}
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				)}
			</div>

			<div
				className="min-h-0 flex-1 overflow-y-auto pb-4"
				data-testid="action-grid"
			>
				{filteredActions.length === 0 && (
					<p className="py-4 text-center text-muted-foreground text-sm">
						No actions found
					</p>
				)}
				{filteredActions.length > 0 && visibleGroups.length === 0 && (
					<p className="py-4 text-center text-muted-foreground text-sm">
						All groups are hidden
					</p>
				)}

				{/* Grid View */}
				{viewMode === "grid" && visibleGroups.length > 0 && (
					<div
						className="grid gap-2 p-1"
						style={{
							gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
						}}
					>
						{filteredActions
							.filter(
								(action) => showHidden || !hiddenGroups.has(action.category),
							)
							.map((action) => (
								<button
									className={cn(
										"flex aspect-square flex-col items-center justify-center gap-1.5 rounded-lg border border-transparent p-2 text-center transition-colors hover:border-border hover:bg-muted",
										disabled && "pointer-events-none opacity-50",
									)}
									data-testid={`action-option-${action.id.toLowerCase().replace(/\s+/g, "-")}`}
									disabled={disabled}
									key={action.id}
									onClick={() =>
										onSelectAction({
											actionType: action.id,
											isDaprActivity: action.isDaprActivity,
											nodeType: action.nodeType,
											activityName: action.activityName,
										})
									}
									type="button"
								>
									<ActionIcon action={action} className="size-6" />
									<span className="line-clamp-2 font-medium text-xs leading-tight">
										{action.label}
									</span>
								</button>
							))}
					</div>
				)}

				{/* List View */}
				{viewMode === "list" &&
					visibleGroups.length > 0 &&
					visibleGroups.map((group, groupIndex) => {
						const isCollapsed = collapsedGroups.has(group.category);
						const isHidden = hiddenGroups.has(group.category);
						return (
							<div key={group.category}>
								{groupIndex > 0 && <div className="my-2 h-px bg-border" />}
								<div
									className={cn(
										"sticky top-0 z-10 mb-1 flex items-center gap-2 bg-background px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wider",
										isHidden && "opacity-50",
									)}
								>
									<button
										className="flex flex-1 items-center gap-2 text-left hover:text-foreground"
										onClick={() => toggleGroup(group.category)}
										type="button"
									>
										<ChevronRight
											className={cn(
												"size-3.5 transition-transform",
												!isCollapsed && "rotate-90",
											)}
										/>
										<GroupIcon group={group} />
										{group.category}
									</button>
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<button
												className="rounded p-0.5 hover:bg-muted hover:text-foreground"
												type="button"
											>
												<MoreHorizontal className="size-4" />
											</button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem
												onClick={() => toggleHideGroup(group.category)}
											>
												{isHidden ? (
													<>
														<Eye className="mr-2 size-4" />
														Show group
													</>
												) : (
													<>
														<EyeOff className="mr-2 size-4" />
														Hide group
													</>
												)}
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
								{!isCollapsed &&
									group.actions.map((action) => (
										<button
											className={cn(
												"flex w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
												disabled && "pointer-events-none opacity-50",
											)}
											data-testid={`action-option-${action.id.toLowerCase().replace(/\s+/g, "-")}`}
											disabled={disabled}
											key={action.id}
											onClick={() =>
												onSelectAction({
													actionType: action.id,
													isDaprActivity: action.isDaprActivity,
													nodeType: action.nodeType,
													activityName: action.activityName,
												})
											}
											type="button"
										>
											<span className="min-w-0 flex-1 truncate">
												<span className="font-medium">{action.label}</span>
												{action.description && (
													<span className="text-muted-foreground text-xs">
														{" "}
														- {action.description}
													</span>
												)}
											</span>
										</button>
									))}
							</div>
						);
					})}
			</div>
		</div>
	);
}
