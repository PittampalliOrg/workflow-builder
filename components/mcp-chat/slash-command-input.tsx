"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { ChatInput } from "@/components/mcp-chat/chat-input";
import { X, Server, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { McpServerState } from "@/lib/mcp-chat/mcp-servers-store";
import type {
	SlashCommandScope,
	AutocompleteItem,
} from "@/lib/mcp-chat/slash-command-types";
import { BUILTIN_TOOLS } from "@/lib/mcp-chat/slash-command-types";

type SlashCommandInputProps = {
	value: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
	isDisabled?: boolean;
	placeholder?: string;
	scopes: SlashCommandScope[];
	onAddScope: (scope: SlashCommandScope) => void;
	onRemoveScope: (id: string) => void;
	enabledServers: McpServerState[];
};

function buildAutocompleteItems(
	enabledServers: McpServerState[],
): AutocompleteItem[] {
	const items: AutocompleteItem[] = [];

	// External MCP servers
	for (const server of enabledServers) {
		items.push({
			type: "server",
			serverName: server.name,
			toolCount: server.toolCount,
		});
		for (const t of server.tools) {
			items.push({
				type: "tool",
				serverName: server.name,
				toolName: t.name,
				description: t.description,
			});
		}
	}

	// Built-in tools
	items.push({
		type: "server",
		serverName: "Built-in",
		toolCount: BUILTIN_TOOLS.length,
	});
	for (const t of BUILTIN_TOOLS) {
		items.push({
			type: "tool",
			serverName: "Built-in",
			toolName: t.name,
			description: t.description,
		});
	}

	return items;
}

function filterItems(
	items: AutocompleteItem[],
	query: string,
): AutocompleteItem[] {
	if (!query) return items;

	const parts = query.split("/").filter(Boolean);
	const serverFilter = parts[0]?.toLowerCase() ?? "";
	const toolFilter = parts[1]?.toLowerCase() ?? "";

	return items.filter((item) => {
		const serverMatch = item.serverName
			.toLowerCase()
			.includes(serverFilter);
		if (item.type === "server") {
			return serverMatch;
		}
		// tool item
		if (toolFilter) {
			return (
				serverMatch &&
				item.toolName.toLowerCase().includes(toolFilter)
			);
		}
		return (
			serverMatch ||
			item.toolName.toLowerCase().includes(serverFilter)
		);
	});
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

	const allItems = useMemo(
		() => buildAutocompleteItems(enabledServers),
		[enabledServers],
	);

	const isSlashQuery = value.startsWith("/");
	const slashQuery = isSlashQuery ? value.slice(1) : "";

	const filteredItems = useMemo(
		() => (isSlashQuery ? filterItems(allItems, slashQuery) : []),
		[allItems, slashQuery, isSlashQuery],
	);

	// Open when typing `/`, close otherwise
	useEffect(() => {
		if (isSlashQuery && filteredItems.length > 0) {
			setIsOpen(true);
			setSelectedIndex(0);
		} else {
			setIsOpen(false);
		}
	}, [isSlashQuery, filteredItems.length]);

	// Scroll selected item into view
	useEffect(() => {
		if (isOpen && itemRefs.current[selectedIndex]) {
			itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
		}
	}, [selectedIndex, isOpen]);

	const selectItem = useCallback(
		(item: AutocompleteItem) => {
			const scope = itemToScope(item);
			onAddScope(scope);
			onChange("");
			setIsOpen(false);
		},
		[onAddScope, onChange],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (!isOpen) return;

			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) =>
					i < filteredItems.length - 1 ? i + 1 : 0,
				);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) =>
					i > 0 ? i - 1 : filteredItems.length - 1,
				);
			} else if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				if (filteredItems[selectedIndex]) {
					selectItem(filteredItems[selectedIndex]);
				}
			} else if (e.key === "Escape") {
				e.preventDefault();
				setIsOpen(false);
				onChange("");
			}
		},
		[isOpen, filteredItems, selectedIndex, selectItem, onChange],
	);

	const badgeBar =
		scopes.length > 0 ? (
			<div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
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

	return (
		<div className="relative">
			{/* Autocomplete popup */}
			{isOpen && (
				<div
					ref={popupRef}
					className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-64 overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg"
				>
					{filteredItems.map((item, idx) => (
						<div
							key={
								item.type === "server"
									? `s:${item.serverName}`
									: `t:${item.serverName}/${item.toolName}`
							}
							ref={(el) => {
								itemRefs.current[idx] = el;
							}}
							className={cn(
								"flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm",
								idx === selectedIndex
									? "bg-accent text-accent-foreground"
									: "hover:bg-muted",
							)}
							onClick={() => selectItem(item)}
							onMouseEnter={() => setSelectedIndex(idx)}
						>
							{item.type === "server" ? (
								<>
									<Server className="h-4 w-4 shrink-0 text-muted-foreground" />
									<span className="font-medium">
										{item.serverName}
									</span>
									<span className="ml-auto text-xs text-muted-foreground">
										{item.toolCount} tools
									</span>
								</>
							) : (
								<>
									<Wrench className="h-4 w-4 shrink-0 text-muted-foreground" />
									<span className="text-muted-foreground">
										{item.serverName} /
									</span>
									<span>{item.toolName}</span>
									{item.description && (
										<span className="ml-auto truncate text-xs text-muted-foreground">
											{item.description}
										</span>
									)}
								</>
							)}
						</div>
					))}
					{filteredItems.length === 0 && (
						<div className="px-3 py-2 text-sm text-muted-foreground">
							No matching servers or tools
						</div>
					)}
				</div>
			)}

			<ChatInput
				value={value}
				onChange={onChange}
				onSubmit={onSubmit}
				isDisabled={isDisabled}
				placeholder={placeholder}
				onKeyDown={handleKeyDown}
				prefix={badgeBar}
			/>
		</div>
	);
}
