"use client";

import { Copy, Download, FileJson } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { normalizeWorkflowToSwCutover } from "@/lib/serverless-workflow/cutover";
import type {
	WorkflowEdge,
	WorkflowNode,
} from "@/lib/serverless-workflow/graph-types";
import { serializeWorkflowDefinition } from "@/lib/serverless-workflow/sdk";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";

type WorkflowJsonExportOverlayProps = OverlayComponentProps<{
	name: string;
	description?: string;
	nodes: unknown[];
	edges: unknown[];
}>;

function downloadDefinition(
	filename: string,
	content: string,
	format: "yaml" | "json",
) {
	const blob = new Blob([content], {
		type:
			format === "yaml"
				? "application/yaml;charset=utf-8"
				: "application/json;charset=utf-8",
	});
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
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
	const [format, setFormat] = useState<"yaml" | "json">("yaml");

	const definition = useMemo(() => {
		const safeName =
			name
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "") || "workflow";
		const normalized = normalizeWorkflowToSwCutover({
			name,
			description,
			nodes: nodes as unknown as import("@/lib/workflow-store").WorkflowNode[],
			edges: edges as unknown as import("@/lib/workflow-store").WorkflowEdge[],
			spec: {
				document: {
					dsl: "1.0.0",
					namespace: "dapr-swe",
					name: safeName,
					version: "0.0.1",
					title: name,
					...(description ? { summary: description } : {}),
				},
				do: [],
			},
			specVersion: null,
		});
		return serializeWorkflowDefinition(normalized.spec, format);
	}, [description, edges, format, name, nodes]);

	const handleCopy = async () => {
		setIsCopying(true);
		try {
			await navigator.clipboard.writeText(definition);
			toast.success(`Copied SW workflow ${format.toUpperCase()}.`);
		} catch (error) {
			console.error("Copy failed:", error);
			toast.error(`Failed to copy SW workflow ${format.toUpperCase()}.`);
		} finally {
			setIsCopying(false);
		}
	};

	const handleDownload = () => {
		const safeName =
			name
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "") || "workflow";
		downloadDefinition(
			`${safeName}.${format === "yaml" ? "yaml" : "json"}`,
			definition,
			format,
		);
		toast.success(`Downloaded SW workflow ${format.toUpperCase()}.`);
	};

	return (
		<Overlay
			actions={[
				{ label: "Close", variant: "outline", onClick: closeAll },
				{ label: "Copy", onClick: handleCopy, loading: isCopying },
				{ label: "Download", onClick: handleDownload },
			]}
			overlayId={overlayId}
			title="Export SW Definition"
		>
			<div className="flex items-center gap-2 text-muted-foreground">
				<FileJson className="size-5" />
				<p className="text-sm">
					Exports the current graph as a{" "}
					<code className="font-mono">CNCF Serverless Workflow 1.0</code> JSON
					or YAML document.
				</p>
			</div>

			<div className="mt-4 space-y-2">
				<div className="flex gap-2">
					<Button
						onClick={() => setFormat("yaml")}
						variant={format === "yaml" ? "default" : "outline"}
					>
						YAML
					</Button>
					<Button
						onClick={() => setFormat("json")}
						variant={format === "json" ? "default" : "outline"}
					>
						JSON
					</Button>
				</div>
				<Textarea readOnly rows={14} value={definition} />
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
