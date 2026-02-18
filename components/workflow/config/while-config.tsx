"use client";

import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { Label } from "@/components/ui/label";
import { CodeEditor } from "@/components/ui/code-editor";
import { nodesAtom } from "@/lib/workflow-store";
import {
	setupCelLanguage,
	type CelEditorContext,
	type MonacoLike,
} from "@/lib/monaco-cel-language";

type WhileConfigProps = {
	nodeId: string;
	config: Record<string, unknown>;
	onUpdateConfig: (key: string, value: string) => void;
	disabled: boolean;
};

export function WhileConfig({
	nodeId,
	config,
	onUpdateConfig,
	disabled,
}: WhileConfigProps) {
	const nodes = useAtomValue(nodesAtom);

	const { loopBodyLabel, stateKeys, celContext, contextVersion } =
		useMemo(() => {
			const extractSetStateKeys = (
				nodeConfig: Record<string, unknown> | undefined,
			): string[] => {
				if (!nodeConfig) {
					return [];
				}

				const keys = new Set<string>();

				if (Array.isArray(nodeConfig.entries)) {
					for (const entry of nodeConfig.entries) {
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
					typeof nodeConfig.key === "string"
						? nodeConfig.key.trim()
						: String(nodeConfig.key ?? "").trim();
				if (legacyKey) {
					keys.add(legacyKey);
				}

				return Array.from(keys);
			};

			const loopBodyNode = nodes.find(
				(node) => node.parentId === nodeId && node.type !== "add",
			);
			const loopBodyLabel = String(
				loopBodyNode?.data?.label || loopBodyNode?.id || "Not detected",
			);

			const stateKeys = Array.from(
				new Set(
					nodes
						.filter((node) => node.type === "set-state")
						.flatMap((node) =>
							extractSetStateKeys(node.data?.config as Record<string, unknown>),
						)
						.filter(Boolean),
				),
			);

			const celContext: CelEditorContext = {
				memberFields: {
					state: stateKeys,
					workflow: ["id", "name", "input", "input_as_text"],
					input: [
						"success",
						"data",
						"error",
						"text",
						"toolCalls",
						"fileChanges",
						"daprInstanceId",
					],
					last: [
						"success",
						"data",
						"error",
						"text",
						"toolCalls",
						"fileChanges",
						"daprInstanceId",
					],
				},
			};

			return {
				loopBodyLabel,
				stateKeys,
				celContext,
				contextVersion: `${nodeId}:${loopBodyNode?.id || "none"}:${stateKeys.join("|")}`,
			};
		}, [nodes, nodeId]);

	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label className="ml-1" htmlFor="while-expression">
					CEL Expression
				</Label>
				<div className="overflow-hidden rounded-md border">
					<CodeEditor
						key={contextVersion}
						defaultLanguage="cel"
						height="160px"
						onChange={(value) => onUpdateConfig("expression", value ?? "")}
						onMount={(editor, monaco) => {
							const modelUri = editor.getModel()?.uri?.toString();
							setupCelLanguage(monaco as unknown as MonacoLike, {
								modelUri,
								context: celContext,
							});
						}}
						options={{
							minimap: { enabled: false },
							lineNumbers: "off",
							scrollBeyondLastLine: false,
							fontSize: 12,
							wordWrap: "on",
							readOnly: disabled,
							automaticLayout: true,
							padding: { top: 10, bottom: 10 },
						}}
						value={String(config.expression || "")}
					/>
				</div>
				<div className="space-y-1 rounded-md border border-dashed bg-muted/30 p-2 text-xs">
					<p className="text-muted-foreground">
						Loop body node: <code>{loopBodyLabel}</code>
					</p>
					<p className="text-muted-foreground">
						Detected state keys:{" "}
						{stateKeys.length > 0 ? (
							<span>
								{stateKeys.map((key) => (
									<code key={key}>{`${key} `}</code>
								))}
							</span>
						) : (
							<span>none yet</span>
						)}
					</p>
				</div>
				<p className="text-muted-foreground text-xs">
					Loop continues while this expression is true. Available symbols:{" "}
					<code>input</code>, <code>state</code>, <code>workflow</code>,{" "}
					<code>iteration</code>, <code>last</code>.
				</p>
				<p className="text-muted-foreground text-xs">
					<code>iteration</code> is the current loop pass count (starts at{" "}
					<code>1</code> on the first check).
				</p>
				<p className="text-muted-foreground text-xs">
					Examples: <code>iteration &lt; 10</code>,{" "}
					<code>state.counter &lt; 5</code>, <code>input.success == true</code>,{" "}
					<code>last == null ? false : last.data.ready == true</code>.
				</p>
			</div>
		</div>
	);
}
