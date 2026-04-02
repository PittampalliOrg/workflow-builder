"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { AlertTriangle, FileJson, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { api } from "@/lib/api-client";
import {
	currentWorkflowIdAtom,
	currentWorkflowNameAtom,
	edgesAtom,
	hasUnsavedChangesAtom,
	nodesAtom,
} from "@/lib/workflow-store";
import { normalizeWorkflowToSwCutover } from "@/lib/serverless-workflow/cutover";
import { decompileWorkflowToGraph } from "@/lib/serverless-workflow/decompile";
import { parseWorkflowDefinition } from "@/lib/serverless-workflow/sdk";
import type { Workflow } from "@/lib/serverless-workflow/types";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";

type WorkflowJsonImportOverlayProps = OverlayComponentProps<{
	mode: "create" | "replace";
}>;

type OverlayIssue = {
	code: string;
	message: string;
	path: string;
};

function formatIssues(issues: {
	errors: OverlayIssue[];
	warnings: OverlayIssue[];
}) {
	return {
		errorCount: issues.errors.length,
		warningCount: issues.warnings.length,
	};
}

function detectDefinitionLanguage(raw: string): "yaml" | "json" {
	return raw.trim().startsWith("{") ? "json" : "yaml";
}

function validateSwWorkflow(
	raw: string,
):
	| { ok: true; spec: Workflow }
	| { ok: false; errors: OverlayIssue[]; warnings: OverlayIssue[] } {
	try {
		const parsed = parseWorkflowDefinition(raw);
		const normalized = normalizeWorkflowToSwCutover({
			name: parsed.document.title || parsed.document.name,
			description: parsed.document.summary,
			nodes: [],
			edges: [],
			spec: parsed as unknown,
			specVersion: null,
		});
		return { ok: true, spec: normalized.spec as Workflow };
	} catch (error) {
		return {
			ok: false,
			errors: [
				{
					code: "INVALID_SW_WORKFLOW",
					path: "/",
					message:
						error instanceof Error
							? error.message
							: "Invalid Serverless Workflow input",
				},
			],
			warnings: [],
		};
	}
}

export function WorkflowJsonImportOverlay({
	overlayId,
	mode,
}: WorkflowJsonImportOverlayProps) {
	const { closeAll } = useOverlay();
	const setNodes = useSetAtom(nodesAtom);
	const setEdges = useSetAtom(edgesAtom);
	const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
	const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
	const currentWorkflowName = useAtomValue(currentWorkflowNameAtom);

	const [raw, setRaw] = useState("");
	const [isApplying, setIsApplying] = useState(false);
	const [lastIssues, setLastIssues] = useState<{
		errors: OverlayIssue[];
		warnings: OverlayIssue[];
	} | null>(null);

	const validate = () => {
		const result = validateSwWorkflow(raw);
		if (result.ok) {
			setLastIssues({ errors: [], warnings: [] });
			return result;
		}
		setLastIssues({
			errors: result.errors,
			warnings: result.warnings,
		});
		return result;
	};

	const handleApply = async () => {
		if (mode === "create") {
			toast.error(
				"Creating new workflows is disabled after the SW 1.0 cutover.",
			);
			return;
		}

		const result = validate();
		if (!result.ok) {
			toast.error("SW definition has errors. Fix them before importing.");
			return;
		}

		if (!currentWorkflowId) {
			toast.error("No workflow selected.");
			return;
		}

		setIsApplying(true);
		try {
			const graph = decompileWorkflowToGraph(result.spec as never);

			setNodes(graph.nodes as never);
			setEdges(graph.edges as never);
			setHasUnsavedChanges(true);

			await api.workflow.update(currentWorkflowId, {
				nodes: graph.nodes as never,
				edges: graph.edges as never,
				name:
					currentWorkflowName ||
					result.spec.document.title ||
					result.spec.document.name,
				description: result.spec.document.summary,
				spec: result.spec,
			});

			setHasUnsavedChanges(false);
			closeAll();
			toast.success("Imported SW workflow definition.");
		} catch (error) {
			console.error("Import failed:", error);
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to import SW workflow definition",
			);
		} finally {
			setIsApplying(false);
		}
	};

	const issueCounts = lastIssues ? formatIssues(lastIssues) : null;

	return (
		<Overlay
			actions={[
				{ label: "Cancel", variant: "outline", onClick: closeAll },
				{
					label: isApplying ? "Importing..." : "Replace Workflow",
					onClick: handleApply,
					loading: isApplying,
				},
			]}
			overlayId={overlayId}
			title="Replace With SW Definition"
		>
			<div className="flex items-center gap-2 text-muted-foreground">
				<FileJson className="size-5" />
				<p className="text-sm">
					Paste a CNCF Serverless Workflow 1.0 YAML or JSON document.
				</p>
			</div>

			<div className="mt-4 space-y-2">
				<div className="overflow-hidden rounded-lg border">
					<CodeEditor
						height="360px"
						language={detectDefinitionLanguage(raw)}
						onChange={(value) => setRaw(value ?? "")}
						options={{
							fontSize: 13,
							lineNumbers: "on",
							minimap: { enabled: false },
							scrollBeyondLastLine: false,
							wordWrap: "on",
						}}
						value={raw}
					/>
				</div>
				<p className="text-muted-foreground text-xs">
					Paste a valid Serverless Workflow definition in YAML or JSON. The
					editor highlights the detected format automatically.
				</p>

				<div className="flex flex-wrap items-center gap-2">
					<Button
						onClick={() => validate()}
						variant="outline"
						disabled={!raw.trim()}
					>
						<Upload className="mr-2 size-4" />
						Validate
					</Button>
					{issueCounts ? (
						<p className="text-muted-foreground text-sm">
							{issueCounts.errorCount} errors, {issueCounts.warningCount}{" "}
							warnings
						</p>
					) : null}
				</div>
			</div>

			{lastIssues &&
			(lastIssues.errors.length > 0 || lastIssues.warnings.length > 0) ? (
				<div className="mt-4 space-y-3">
					{lastIssues.errors.length > 0 ? (
						<div className="space-y-1">
							<h4 className="flex items-center gap-2 font-medium text-sm">
								<AlertTriangle className="size-4 text-red-500" />
								Errors
							</h4>
							<div className="space-y-1">
								{lastIssues.errors.slice(0, 12).map((issue) => (
									<p
										className="text-sm"
										key={`${issue.code}:${issue.path}:${issue.message}`}
									>
										<span className="font-mono text-muted-foreground">
											{issue.path}
										</span>{" "}
										{issue.message}
									</p>
								))}
							</div>
						</div>
					) : null}
					{lastIssues.warnings.length > 0 ? (
						<div className="space-y-1">
							<h4 className="flex items-center gap-2 font-medium text-sm">
								<AlertTriangle className="size-4 text-orange-500" />
								Warnings
							</h4>
							<div className="space-y-1">
								{lastIssues.warnings.slice(0, 12).map((issue) => (
									<p
										className="text-sm"
										key={`${issue.code}:${issue.path}:${issue.message}`}
									>
										<span className="font-mono text-muted-foreground">
											{issue.path}
										</span>{" "}
										{issue.message}
									</p>
								))}
							</div>
						</div>
					) : null}
				</div>
			) : null}
		</Overlay>
	);
}
