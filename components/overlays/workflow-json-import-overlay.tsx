"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { AlertTriangle, FileJson, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";
import {
	currentWorkflowIdAtom,
	currentWorkflowNameAtom,
	edgesAtom,
	hasUnsavedChangesAtom,
	nodesAtom,
} from "@/lib/workflow-store";
import { usePiecesCatalog } from "@/lib/actions/pieces-store";
import { buildCatalogFromIntegrations } from "@/lib/workflow-spec/catalog";
import { compileWorkflowSpecToGraph } from "@/lib/workflow-spec/compile";
import { lintWorkflowSpec } from "@/lib/workflow-spec/lint";
import { WorkflowSpecSchema } from "@/lib/workflow-spec/types";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";

type WorkflowJsonImportOverlayProps = OverlayComponentProps<{
	mode: "create" | "replace";
}>;

function formatIssues(issues: {
	errors: { message: string }[];
	warnings: { message: string }[];
}) {
	return {
		errorCount: issues.errors.length,
		warningCount: issues.warnings.length,
	};
}

export function WorkflowJsonImportOverlay({
	overlayId,
	mode,
}: WorkflowJsonImportOverlayProps) {
	const { closeAll } = useOverlay();
	const { data: session } = useSession();
	const { pieces, loaded } = usePiecesCatalog();
	const setNodes = useSetAtom(nodesAtom);
	const setEdges = useSetAtom(edgesAtom);
	const setHasUnsavedChanges = useSetAtom(hasUnsavedChangesAtom);
	const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
	const currentWorkflowName = useAtomValue(currentWorkflowNameAtom);

	const [raw, setRaw] = useState("");
	const [isApplying, setIsApplying] = useState(false);
	const [lastIssues, setLastIssues] = useState<{
		errors: Array<{ message: string; path: string; code: string }>;
		warnings: Array<{ message: string; path: string; code: string }>;
	} | null>(null);

	const catalog = useMemo(
		() => (loaded ? buildCatalogFromIntegrations(pieces) : undefined),
		[loaded, pieces],
	);

	const validate = () => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			setLastIssues({
				errors: [
					{
						code: "INVALID_JSON",
						path: "/",
						message:
							error instanceof Error ? error.message : "Invalid JSON input",
					},
				],
				warnings: [],
			});
			return { ok: false as const };
		}

		const linted = lintWorkflowSpec(parsed, { catalog });
		setLastIssues({
			errors: linted.result.errors,
			warnings: linted.result.warnings,
		});

		return { ok: linted.result.errors.length === 0, spec: linted.spec };
	};

	const handleApply = async () => {
		const res = validate();
		if (!res.ok || !res.spec) {
			toast.error("Workflow JSON has errors. Fix them before importing.");
			return;
		}

		setIsApplying(true);
		try {
			// Ensure it matches schema defaults before compiling.
			const spec = WorkflowSpecSchema.parse(res.spec);
			const { nodes, edges } = compileWorkflowSpecToGraph(spec);

			if (mode === "create") {
				if (!session?.user) {
					toast.error("Please sign in to import workflows");
					return;
				}

				const created = await api.workflow.createFromSpec({
					name: spec.name,
					description: spec.description,
					spec,
				});

				closeAll();
				window.location.href = `/workflows/${created.workflow.id}`;
				return;
			}

			if (!currentWorkflowId) {
				toast.error("No workflow selected.");
				return;
			}

			// Replace current graph + persist immediately.
			setNodes(nodes as any);
			setEdges(edges as any);
			setHasUnsavedChanges(true);

			await api.workflow.update(currentWorkflowId, {
				nodes: nodes as any,
				edges: edges as any,
				name: currentWorkflowName || spec.name,
			});

			setHasUnsavedChanges(false);
			closeAll();
			toast.success("Imported workflow JSON.");
		} catch (error) {
			console.error("Import failed:", error);
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to import workflow JSON",
			);
		} finally {
			setIsApplying(false);
		}
	};

	const issueCounts = lastIssues
		? formatIssues({
				errors: lastIssues.errors.map((e) => ({ message: e.message })),
				warnings: lastIssues.warnings.map((w) => ({ message: w.message })),
			})
		: null;

	return (
		<Overlay
			actions={[
				{ label: "Cancel", variant: "outline", onClick: closeAll },
				{
					label: isApplying
						? "Importing..."
						: mode === "create"
							? "Create Workflow"
							: "Replace Workflow",
					onClick: handleApply,
					loading: isApplying,
				},
			]}
			overlayId={overlayId}
			title={
				mode === "create"
					? "Import Workflow JSON"
					: "Replace With Workflow JSON"
			}
		>
			<div className="flex items-center gap-2 text-muted-foreground">
				<FileJson className="size-5" />
				<p className="text-sm">
					Paste a <code className="font-mono">workflow-spec/v1</code> JSON
					object. Templates must use{" "}
					<code className="font-mono">{"{{@nodeId:Label.field}}"}</code>.
				</p>
			</div>

			<div className="mt-4 space-y-2">
				<Textarea
					placeholder='{"apiVersion":"workflow-spec/v1", ...}'
					rows={12}
					value={raw}
					onChange={(e) => setRaw(e.target.value)}
				/>

				<div className="flex flex-wrap items-center gap-2">
					<Button
						onClick={() => validate()}
						variant="outline"
						disabled={!raw.trim()}
					>
						<Upload className="mr-2 size-4" />
						Validate
					</Button>
					{issueCounts && (
						<p className="text-muted-foreground text-sm">
							{issueCounts.errorCount} errors, {issueCounts.warningCount}{" "}
							warnings
						</p>
					)}
					{!loaded && (
						<p className="text-muted-foreground text-sm">
							Loading action catalog (validation will be partial until
							loaded)...
						</p>
					)}
				</div>
			</div>

			{lastIssues &&
				(lastIssues.errors.length > 0 || lastIssues.warnings.length > 0) && (
					<div className="mt-4 space-y-3">
						{lastIssues.errors.length > 0 && (
							<div className="space-y-1">
								<h4 className="flex items-center gap-2 font-medium text-sm">
									<AlertTriangle className="size-4 text-red-500" />
									Errors
								</h4>
								<div className="space-y-1">
									{lastIssues.errors.slice(0, 12).map((e) => (
										<p
											className="text-sm"
											key={`${e.code}:${e.path}:${e.message}`}
										>
											<span className="font-mono text-muted-foreground">
												{e.path}
											</span>{" "}
											{e.message}
										</p>
									))}
								</div>
							</div>
						)}
						{lastIssues.warnings.length > 0 && (
							<div className="space-y-1">
								<h4 className="flex items-center gap-2 font-medium text-sm">
									<AlertTriangle className="size-4 text-orange-500" />
									Warnings
								</h4>
								<div className="space-y-1">
									{lastIssues.warnings.slice(0, 12).map((w) => (
										<p
											className="text-sm"
											key={`${w.code}:${w.path}:${w.message}`}
										>
											<span className="font-mono text-muted-foreground">
												{w.path}
											</span>{" "}
											{w.message}
										</p>
									))}
								</div>
							</div>
						)}
					</div>
				)}
		</Overlay>
	);
}
