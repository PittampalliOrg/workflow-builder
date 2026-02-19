"use client";

import { useAtomValue } from "jotai";
import { History, Network, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatInput } from "@/components/mcp-chat/chat-input";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api-client";
import type { WorkflowAiMentionRef } from "@/lib/ai/workflow-ai-tools";
import { usePiecesCatalog } from "@/lib/actions/pieces-store";
import { cn } from "@/lib/utils";
import type { WorkflowNode } from "@/lib/workflow-store";
import { selectedNodeAtom } from "@/lib/workflow-store";

type AiChatComposerProps = {
	workflowId: string;
	nodes: WorkflowNode[];
	isDisabled?: boolean;
	onSubmit: (payload: {
		text: string;
		mentionRefs: WorkflowAiMentionRef[];
	}) => Promise<void>;
	onClear: () => Promise<void>;
};

type MentionOption = {
	id: string;
	type: "node" | "action" | "execution";
	label: string;
	description?: string;
	ref: WorkflowAiMentionRef;
};

function getNodeLabel(node: WorkflowNode): string {
	if (node.data.label?.trim()) {
		return node.data.label;
	}
	return `${node.data.type} (${node.id.slice(0, 6)})`;
}

function findMentionQuery(
	value: string,
): { query: string; startIndex: number } | null {
	const match = value.match(/(?:^|\s)@([^\s@]*)$/);
	if (!match) {
		return null;
	}
	const query = match[1] ?? "";
	const startIndex = value.lastIndexOf(`@${query}`);
	if (startIndex < 0) {
		return null;
	}
	return { query: query.toLowerCase(), startIndex };
}

export function AiChatComposer({
	workflowId,
	nodes,
	isDisabled,
	onSubmit,
	onClear,
}: AiChatComposerProps) {
	const { actionsById } = usePiecesCatalog();
	const selectedNodeId = useAtomValue(selectedNodeAtom);
	const [input, setInput] = useState("");
	const [selectedMentions, setSelectedMentions] = useState<
		WorkflowAiMentionRef[]
	>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [executionOptions, setExecutionOptions] = useState<MentionOption[]>([]);

	useEffect(() => {
		let cancelled = false;
		void api.workflow
			.getExecutions(workflowId)
			.then((executions) => {
				if (cancelled) {
					return;
				}
				const next = executions.slice(0, 20).map((execution) => {
					const executionId = execution.id;
					const phase = execution.phase ?? execution.status;
					const startedRaw = execution.startedAt as unknown;
					const started =
						typeof startedRaw === "string"
							? startedRaw
							: new Date(startedRaw as Date).toISOString();
					return {
						id: `execution:${executionId}`,
						type: "execution" as const,
						label: `Run ${executionId.slice(0, 8)} (${execution.status})`,
						description: `${phase} · ${started}`,
						ref: {
							id: `execution:${executionId}`,
							type: "execution" as const,
							executionId,
							label: `run-${executionId.slice(0, 8)}`,
							description: `${phase}`,
						},
					};
				});
				setExecutionOptions(next);
			})
			.catch(() => {
				if (!cancelled) {
					setExecutionOptions([]);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [workflowId]);

	const mentionQuery = useMemo(() => findMentionQuery(input), [input]);

	const nodeOptions = useMemo<MentionOption[]>(() => {
		return nodes
			.filter((node) => node.type !== "add")
			.map((node) => ({
				id: `node:${node.id}`,
				type: "node" as const,
				label: getNodeLabel(node),
				description: `Existing ${node.data.type} node${
					node.id === selectedNodeId ? " (selected)" : ""
				}`,
				ref: {
					id: `node:${node.id}`,
					type: "node" as const,
					nodeId: node.id,
					label: getNodeLabel(node),
					description: node.data.type,
				},
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	}, [nodes, selectedNodeId]);

	const actionOptions = useMemo<MentionOption[]>(() => {
		const options = Array.from(actionsById.values())
			.map((action) => ({
				id: `action:${action.id}`,
				type: "action" as const,
				label: action.label,
				description: `${action.integration} · ${action.id}`,
				ref: {
					id: `action:${action.id}`,
					type: "action" as const,
					actionType: action.id,
					label: action.label,
					description: action.integration,
				},
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
		return options.slice(0, 300);
	}, [actionsById]);

	const allOptions = useMemo(() => {
		const taken = new Set(selectedMentions.map((mention) => mention.id));
		return [...nodeOptions, ...actionOptions, ...executionOptions].filter(
			(option) => !taken.has(option.ref.id),
		);
	}, [actionOptions, executionOptions, nodeOptions, selectedMentions]);

	const filteredOptions = useMemo(() => {
		if (!mentionQuery) {
			return [];
		}
		const query = mentionQuery.query;
		if (!query) {
			return allOptions.slice(0, 24);
		}
		return allOptions
			.filter((option) => {
				const haystack =
					`${option.label} ${option.description || ""} ${option.type}`.toLowerCase();
				return haystack.includes(query);
			})
			.slice(0, 24);
	}, [allOptions, mentionQuery]);

	useEffect(() => {
		setSelectedIndex(0);
	}, [mentionQuery?.query]);

	const addMention = useCallback(
		(option: MentionOption) => {
			setSelectedMentions((prev) => {
				if (prev.some((mention) => mention.id === option.ref.id)) {
					return prev;
				}
				return [...prev, option.ref];
			});

			if (mentionQuery) {
				const next = input.slice(0, mentionQuery.startIndex).trimEnd();
				setInput(next.length > 0 ? `${next} ` : "");
			}
		},
		[input, mentionQuery],
	);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (!mentionQuery || filteredOptions.length === 0) {
				return;
			}

			if (event.key === "ArrowDown") {
				event.preventDefault();
				setSelectedIndex((index) =>
					index < filteredOptions.length - 1 ? index + 1 : 0,
				);
				return;
			}

			if (event.key === "ArrowUp") {
				event.preventDefault();
				setSelectedIndex((index) =>
					index > 0 ? index - 1 : filteredOptions.length - 1,
				);
				return;
			}

			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				const option = filteredOptions[selectedIndex];
				if (option) {
					addMention(option);
				}
				return;
			}

			if (event.key === "Escape") {
				event.preventDefault();
				if (mentionQuery) {
					setInput((prev) => prev.slice(0, mentionQuery.startIndex).trimEnd());
				}
			}
		},
		[addMention, filteredOptions, mentionQuery, selectedIndex],
	);

	const submit = useCallback(async () => {
		if (isDisabled) {
			return;
		}

		const trimmed = input.trim();
		if (trimmed === "/clear") {
			await onClear();
			setInput("");
			setSelectedMentions([]);
			return;
		}

		if (!trimmed && selectedMentions.length === 0) {
			return;
		}

		const text =
			trimmed ||
			`Use referenced context: ${selectedMentions.map((mention) => `@${mention.label}`).join(", ")}`;
		await onSubmit({ text, mentionRefs: selectedMentions });
		setInput("");
		setSelectedMentions([]);
	}, [input, isDisabled, onClear, onSubmit, selectedMentions]);

	const chips =
		selectedMentions.length > 0 ? (
			<div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
				{selectedMentions.map((mention) => (
					<Badge
						key={mention.id}
						variant="secondary"
						className="gap-1 pl-2 pr-1 text-xs"
					>
						{mention.type === "node" ? (
							<Network className="h-3 w-3" />
						) : mention.type === "action" ? (
							<Wrench className="h-3 w-3" />
						) : (
							<History className="h-3 w-3" />
						)}
						{mention.label}
						<button
							type="button"
							onClick={() => {
								setSelectedMentions((prev) =>
									prev.filter((item) => item.id !== mention.id),
								);
							}}
							className="ml-0.5 rounded-sm p-0.5 hover:bg-muted-foreground/20"
						>
							<X className="h-3 w-3" />
						</button>
					</Badge>
				))}
			</div>
		) : null;

	const isMentionMenuOpen = mentionQuery !== null && filteredOptions.length > 0;

	return (
		<div className="relative w-full">
			{isMentionMenuOpen && (
				<div className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-64 overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg">
					{filteredOptions.map((option, index) => (
						<button
							type="button"
							key={option.id}
							onClick={() => addMention(option)}
							onMouseEnter={() => setSelectedIndex(index)}
							className={cn(
								"flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm",
								index === selectedIndex
									? "bg-accent text-accent-foreground"
									: "hover:bg-muted",
							)}
						>
							{option.type === "node" ? (
								<Network className="h-4 w-4 shrink-0 text-muted-foreground" />
							) : option.type === "action" ? (
								<Wrench className="h-4 w-4 shrink-0 text-muted-foreground" />
							) : (
								<History className="h-4 w-4 shrink-0 text-muted-foreground" />
							)}
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium">{option.label}</div>
								{option.description && (
									<div className="truncate text-xs text-muted-foreground">
										{option.description}
									</div>
								)}
							</div>
						</button>
					))}
				</div>
			)}

			<ChatInput
				value={input}
				onChange={setInput}
				onSubmit={() => {
					void submit();
				}}
				isDisabled={isDisabled}
				placeholder="Describe updates, use @ for context, or /clear"
				onKeyDown={handleKeyDown}
				prefix={chips}
				canSubmitEmpty={selectedMentions.length > 0}
			/>
		</div>
	);
}
