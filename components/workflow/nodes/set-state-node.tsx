"use client";

import {
	Node,
	NodeDescription,
	NodeTitle,
} from "@/components/ai-elements/node";
import { cn } from "@/lib/utils";
import type { WorkflowNodeData } from "@/lib/workflow-store";
import type { NodeProps } from "@xyflow/react";
import { Database } from "lucide-react";
import { memo } from "react";

type SetStateNodeProps = NodeProps & {
	data?: WorkflowNodeData;
	id: string;
};

function readSetStateKeys(
	config: Record<string, unknown> | undefined,
): string[] {
	if (!config) {
		return [];
	}

	const keys = new Set<string>();
	if (Array.isArray(config.entries)) {
		for (const entry of config.entries) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				continue;
			}
			const rawKey = (entry as Record<string, unknown>).key;
			const key =
				typeof rawKey === "string"
					? rawKey.trim()
					: String(rawKey ?? "").trim();
			if (key) {
				keys.add(key);
			}
		}
	}

	const legacyKey =
		typeof config.key === "string"
			? config.key.trim()
			: String(config.key ?? "").trim();
	if (legacyKey) {
		keys.add(legacyKey);
	}

	return Array.from(keys);
}

export const SetStateNode = memo(
	({ data, selected, id }: SetStateNodeProps) => {
		if (!data) {
			return null;
		}

		const keys = readSetStateKeys(data.config);
		const description =
			keys.length === 0
				? "Set workflow variables"
				: keys.length === 1
					? `Set state.${keys[0]}`
					: `Set ${keys.length} state values`;

		return (
			<Node
				className={cn(
					"relative flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
					selected && "border-primary",
				)}
				data-testid={`set-state-node-${id}`}
				handles={{ target: true, source: true }}
				runnable
				selected={selected}
				status={data.status}
			>
				<div className="flex flex-col items-center justify-center gap-3 p-6">
					<Database
						className="size-12 text-muted-foreground"
						strokeWidth={1.5}
					/>
					<div className="flex flex-col items-center gap-1 text-center">
						<NodeTitle className="text-base">
							{data.label || "Set State"}
						</NodeTitle>
						<NodeDescription className="text-xs">{description}</NodeDescription>
					</div>
				</div>
			</Node>
		);
	},
);

SetStateNode.displayName = "SetStateNode";
