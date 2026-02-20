"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { ChatInput } from "@/components/mcp-chat/chat-input";
import { X, Server, Wrench, Check, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
	SlashCommandScope,
	AutocompleteItem,
} from "@/lib/mcp-chat/slash-command-types";
import { BUILTIN_TOOLS } from "@/lib/mcp-chat/slash-command-types";

export type SlashEnabledServer = {
	id: string;
	name: string;
	toolCount: number;
	tools: { name: string; description?: string }[];
};

type SlashCommandInputProps = {
	value: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
	isDisabled?: boolean;
	placeholder?: string;
	scopes: SlashCommandScope[];
	onAddScope: (scope: SlashCommandScope) => void;
	onRemoveScope: (id: string) => void;
	enabledServers: SlashEnabledServer[];
};

/** Group items by server, producing { serverName, serverItem, tools }[] */
type ServerGroup = {
	serverName: string;
	serverItem: AutocompleteItem & { type: "server" };
	tools: (AutocompleteItem & { type: "tool" })[];
};

function buildGroupedItems(
	enabledServers: SlashEnabledServer[],
): ServerGroup[] {
	const groups: ServerGroup[] = [];

	for (const server of enabledServers) {
		groups.push({
			serverName: server.name,
			serverItem: {
				type: "server",
				serverName: server.name,
				toolCount: server.toolCount,
			},
			tools: server.tools.map((t) => ({
				type: "tool" as const,
				serverName: server.name,
				toolName: t.name,
				description: t.description,
			})),
		});
	}

	// Built-in tools
	groups.push({
		serverName: "Built-in",
		serverItem: {
			type: "server",
			serverName: "Built-in",
			toolCount: BUILTIN_TOOLS.length,
		},
		tools: BUILTIN_TOOLS.map((t) => ({
			type: "tool" as const,
			serverName: "Built-in",
			toolName: t.name,
			description: t.description,
		})),
	});

	return groups;
}

function filterGroups(
	groups: ServerGroup[],
	query: string,
): { groups: ServerGroup[]; flatItems: AutocompleteItem[] } {
	const parts = query.split("/").filter(Boolean);
	const serverFilter = parts[0]?.toLowerCase() ?? "";
	const toolFilter = parts[1]?.toLowerCase() ?? "";

	const filtered: ServerGroup[] = [];
	const flat: AutocompleteItem[] = [];

	for (const group of groups) {
		const serverMatch = group.serverName
			.toLowerCase()
			.includes(serverFilter);

		const matchedTools = group.tools.filter((t) => {
			if (toolFilter) {
				return (
					serverMatch &&
					t.toolName.toLowerCase().includes(toolFilter)
				);
			}
			return (
				serverMatch ||
				t.toolName.toLowerCase().includes(serverFilter)
			);
		});

		if (serverMatch || matchedTools.length > 0) {
			const g = {
				serverName: group.serverName,
				serverItem: group.serverItem,
				tools: serverMatch && !toolFilter ? group.tools : matchedTools,
			};
			filtered.push(g);
			flat.push(g.serverItem);
			flat.push(...g.tools);
		}
	}

	return { groups: filtered, flatItems: flat };
}

function itemToScope(item: AutocompleteItem): SlashCommandScope {
	if (item.type === "server") {
		return {
			id: `server:${item.serverName}`,
			type: "server",
			serverName: item.serverName,
			label: item.serverName,
		};
	}
	return {
		id: `tool:${item.serverName}/${item.toolName}`,
		type: "tool",
		serverName: item.serverName,
		toolName: item.toolName,
		label: `${item.serverName} / ${item.toolName}`,
	};
}

function isScopeActive(
	item: AutocompleteItem,
	scopes: SlashCommandScope[],
): boolean {
	if (item.type === "server") {
		return scopes.some(
			(s) => s.type === "server" && s.serverName === item.serverName,
		);
	}
	return scopes.some(
		(s) =>
			(s.type === "tool" &&
				s.serverName === item.serverName &&
				s.toolName === item.toolName) ||
			(s.type === "server" && s.serverName === item.serverName),
	);
}

export function SlashCommandInput({
	value,
	onChange,
	onSubmit,
	isDisabled,
	placeholder,
	scopes,
	onAddScope,
	onRemoveScope,
	enabledServers,
}: SlashCommandInputProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const popupRef = useRef<HTMLDivElement>(null);
	const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

	const allGroups = useMemo(
		() => buildGroupedItems(enabledServers),
		[enabledServers],
	);

	const isSlashQuery = value.startsWith("/");
	const slashQuery = isSlashQuery ? value.slice(1) : "";

	const { groups: filteredGroups, flatItems } = useMemo(
		() =>
			isSlashQuery
				? filterGroups(allGroups, slashQuery)
				: { groups: [], flatItems: [] },
		[allGroups, slashQuery, isSlashQuery],
	);

	useEffect(() => {
		if (isSlashQuery && flatItems.length > 0) {
			setIsOpen(true);
			setSelectedIndex(0);
		} else {
			setIsOpen(false);
		}
	}, [isSlashQuery, flatItems.length]);

	useEffect(() => {
		if (isOpen && itemRefs.current[selectedIndex]) {
			itemRefs.current[selectedIndex]?.scrollIntoView({
				block: "nearest",
			});
		}
	}, [selectedIndex, isOpen]);

	const selectItem = useCallback(
		(item: AutocompleteItem) => {
			const scopeId =
				item.type === "server"
					? `server:${item.serverName}`
					: `tool:${item.serverName}/${item.toolName}`;
			const alreadyActive = scopes.some((s) => s.id === scopeId);
			if (alreadyActive) {
				onRemoveScope(scopeId);
			} else {
				onAddScope(itemToScope(item));
			}
			onChange("");
			setIsOpen(false);
		},
		[onAddScope, onRemoveScope, onChange, scopes],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (!isOpen) return;

			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) =>
					i < flatItems.length - 1 ? i + 1 : 0,
				);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) =>
					i > 0 ? i - 1 : flatItems.length - 1,
				);
			} else if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				if (flatItems[selectedIndex]) {
					selectItem(flatItems[selectedIndex]);
				}
			} else if (e.key === "Escape") {
				e.preventDefault();
				setIsOpen(false);
				onChange("");
			}
		},
		[isOpen, flatItems, selectedIndex, selectItem, onChange],
	);

	// Badge bar for active scopes
	const badgeBar =
		scopes.length > 0 ? (
			<div className="flex flex-wrap gap-1.5 border-b border-border/40 px-1 pb-1.5">
				{scopes.map((scope) => (
					<Badge
						key={scope.id}
						variant="secondary"
						className="gap-1 pl-2 pr-1 text-xs"
					>
						{scope.type === "server" ? (
							<Server className="h-3 w-3" />
						) : (
							<Wrench className="h-3 w-3" />
						)}
						{scope.label}
						<button
							type="button"
							onClick={() => onRemoveScope(scope.id)}
							className="ml-0.5 rounded-sm p-0.5 hover:bg-muted-foreground/20"
						>
							<X className="h-3 w-3" />
						</button>
					</Badge>
				))}
			</div>
		) : null;

	// Quick-scope strip (shows available servers as clickable chips above input)
	const totalTools = enabledServers.reduce(
		(sum, s) => sum + s.toolCount,
		0,
	);
	const quickScopeStrip =
		enabledServers.length > 0 && scopes.length === 0 ? (
			<div className="flex items-center gap-1.5 px-1 pb-1">
				<Zap className="h-3 w-3 text-muted-foreground/60 shrink-0" />
				<div className="flex flex-wrap items-center gap-1">
					{enabledServers.map((server) => (
						<button
							key={server.id}
							type="button"
							onClick={() =>
								onAddScope({
									id: `server:${server.name}`,
									type: "server",
									serverName: server.name,
									label: server.name,
								})
							}
							className="flex items-center gap-1 rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground hover:border-border transition-colors"
						>
							<span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
							{server.name}
							<span className="text-muted-foreground/60">
								{server.toolCount}
							</span>
						</button>
					))}
				</div>
				<span className="text-[10px] text-muted-foreground/40 shrink-0 ml-auto">
					{totalTools} tools
				</span>
			</div>
		) : null;

	// Build flat index for selected-index tracking
	let flatIdx = 0;

	return (
		<div className="relative">
			{/* Grouped autocomplete popup */}
			{isOpen && (
				<div
					ref={popupRef}
					className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-72 overflow-y-auto rounded-xl border bg-popover shadow-lg"
				>
					<div className="sticky top-0 z-10 flex items-center justify-between border-b bg-popover/95 px-3 py-1.5 text-[10px] text-muted-foreground backdrop-blur-sm">
						<span>
							{flatItems.length} result
							{flatItems.length !== 1 ? "s" : ""}
						</span>
						<span>
							<kbd className="rounded border border-border/40 px-1 font-mono">
								↑↓
							</kbd>{" "}
							navigate{" "}
							<kbd className="ml-1 rounded border border-border/40 px-1 font-mono">
								Enter
							</kbd>{" "}
							toggle
						</span>
					</div>

					<div className="p-1">
						{filteredGroups.map((group) => {
							const serverIdx = flatIdx;
							flatIdx++;
							const serverActive = isScopeActive(
								group.serverItem,
								scopes,
							);

							return (
								<div key={group.serverName}>
									{/* Server header row */}
									<div
										ref={(el) => {
											itemRefs.current[serverIdx] = el;
										}}
										className={cn(
											"flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm",
											serverIdx === selectedIndex
												? "bg-accent text-accent-foreground"
												: "hover:bg-muted",
										)}
										onClick={() =>
											selectItem(group.serverItem)
										}
										onMouseEnter={() =>
											setSelectedIndex(serverIdx)
										}
									>
										<Server className="h-4 w-4 shrink-0 text-muted-foreground" />
										<span className="font-medium">
											{group.serverName}
										</span>
										<span className="text-xs text-muted-foreground">
											{group.serverItem.toolCount} tools
										</span>
										{serverActive && (
											<Check className="ml-auto h-3.5 w-3.5 text-emerald-500" />
										)}
									</div>

									{/* Tools under this server */}
									{group.tools.map((tool) => {
										const toolIdx = flatIdx;
										flatIdx++;
										const toolActive = isScopeActive(
											tool,
											scopes,
										);

										return (
											<div
												key={`${tool.serverName}/${tool.toolName}`}
												ref={(el) => {
													itemRefs.current[
														toolIdx
													] = el;
												}}
												className={cn(
													"flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-sm ml-3",
													toolIdx === selectedIndex
														? "bg-accent text-accent-foreground"
														: "hover:bg-muted",
												)}
												onClick={() =>
													selectItem(tool)
												}
												onMouseEnter={() =>
													setSelectedIndex(toolIdx)
												}
											>
												<Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
												<span className="font-mono text-xs">
													{tool.toolName}
												</span>
												{tool.description && (
													<span className="truncate text-xs text-muted-foreground ml-1">
														{tool.description}
													</span>
												)}
												{toolActive && (
													<Check className="ml-auto h-3 w-3 shrink-0 text-emerald-500" />
												)}
											</div>
										);
									})}

									{/* Separator between server groups */}
									<div className="mx-3 my-1 border-t border-border/30 last:hidden" />
								</div>
							);
						})}
						{flatItems.length === 0 && (
							<div className="px-3 py-2 text-sm text-muted-foreground">
								No matching servers or tools
							</div>
						)}
					</div>
				</div>
			)}

			<ChatInput
				value={value}
				onChange={onChange}
				onSubmit={onSubmit}
				isDisabled={isDisabled}
				placeholder={placeholder}
				onKeyDown={handleKeyDown}
				prefix={
					<>
						{badgeBar}
						{quickScopeStrip}
					</>
				}
				canSubmitEmpty={scopes.length > 0}
			/>
		</div>
	);
}
