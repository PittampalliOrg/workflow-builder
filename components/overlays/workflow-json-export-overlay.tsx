"use client";

import { Copy, Download, FileJson } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { decompileGraphToWorkflowSpec } from "@/lib/workflow-spec/decompile";
import type {
	WorkflowTableEdge,
	WorkflowTableNode,
} from "@/lib/workflow-spec/compile";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";

type WorkflowJsonExportOverlayProps = OverlayComponentProps<{
	name: string;
	description?: string;
	nodes: unknown[];
	edges: unknown[];
}>;

function downloadJson(filename: string, content: string) {
	const blob = new Blob([content], { type: "application/json;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

export function WorkflowJsonExportOverlay({
	overlayId,
	name,
	description,
	nodes,
	edges,
}: WorkflowJsonExportOverlayProps) {
	const { closeAll } = useOverlay();
	const [isCopying, setIsCopying] = useState(false);

	const json = useMemo(() => {
		const spec = decompileGraphToWorkflowSpec({
			name,
			description,
			nodes: nodes as WorkflowTableNode[],
			edges: edges as WorkflowTableEdge[],
		});
		return JSON.stringify(spec, null, 2);
	}, [name, description, nodes, edges]);

	const handleCopy = async () => {
		setIsCopying(true);
		try {
			await navigator.clipboard.writeText(json);
			toast.success("Copied workflow JSON.");
		} catch (error) {
			console.error("Copy failed:", error);
			toast.error("Failed to copy workflow JSON.");
		} finally {
			setIsCopying(false);
		}
	};

	const handleDownload = () => {
		const safe = name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
		downloadJson(`${safe || "workflow"}.json`, json);
		toast.success("Downloaded workflow JSON.");
	};

	return (
		<Overlay
			actions={[
				{ label: "Close", variant: "outline", onClick: closeAll },
				{ label: "Copy", onClick: handleCopy, loading: isCopying },
				{ label: "Download", onClick: handleDownload },
			]}
			overlayId={overlayId}
			title="Export Workflow JSON"
		>
			<div className="flex items-center gap-2 text-muted-foreground">
				<FileJson className="size-5" />
				<p className="text-sm">
					Exports the current graph as `workflow-spec/v1`.
				</p>
			</div>

			<div className="mt-4 space-y-2">
				<Textarea readOnly rows={14} value={json} />
				<div className="flex flex-wrap items-center gap-2">
					<Button onClick={handleCopy} variant="outline" disabled={isCopying}>
						<Copy className="mr-2 size-4" />
						Copy
					</Button>
					<Button onClick={handleDownload} variant="outline">
						<Download className="mr-2 size-4" />
						Download
					</Button>
				</div>
			</div>
		</Overlay>
	);
}
