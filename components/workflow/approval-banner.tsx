"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { Check, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import {
	approvalEventNameAtom,
	approvalExecutionIdAtom,
	approvalRespondedAtom,
	currentRunningNodeIdAtom,
	daprPhaseAtom,
} from "@/lib/workflow-store";

type PlanArtifactPreview = {
	id: string;
	goal: string;
	status: string;
	planMarkdown: string | null;
	nodeId: string;
	metadata?: {
		planWarnings?: string[];
		promptProfile?: string;
	} | null;
};

export function ApprovalBanner() {
	const daprPhase = useAtomValue(daprPhaseAtom);
	const approvalEventName = useAtomValue(approvalEventNameAtom);
	const approvalExecutionId = useAtomValue(approvalExecutionIdAtom);
	const currentRunningNodeId = useAtomValue(currentRunningNodeIdAtom);
	const setDaprPhase = useSetAtom(daprPhaseAtom);
	const setApprovalEventName = useSetAtom(approvalEventNameAtom);
	const setApprovalExecutionId = useSetAtom(approvalExecutionIdAtom);
	const setApprovalResponded = useSetAtom(approvalRespondedAtom);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [planArtifact, setPlanArtifact] = useState<PlanArtifactPreview | null>(
		null,
	);
	const [planLoading, setPlanLoading] = useState(false);
	const isDurablePlanApproval = approvalEventName?.startsWith(
		"durable_plan_approval_",
	);

	useEffect(() => {
		if (
			daprPhase !== "awaiting_approval" ||
			!approvalExecutionId ||
			!approvalEventName ||
			!isDurablePlanApproval
		) {
			setPlanArtifact(null);
			setPlanLoading(false);
			return;
		}

		const controller = new AbortController();
		const search = new URLSearchParams();
		if (currentRunningNodeId) {
			search.set("nodeId", currentRunningNodeId);
		}
		const suffix = search.toString();
		setPlanLoading(true);

		void fetch(
			`/api/workflows/executions/${approvalExecutionId}/plan-artifact${suffix ? `?${suffix}` : ""}`,
			{
				signal: controller.signal,
			},
		)
			.then(async (response) => {
				if (!response.ok) {
					return null;
				}
				const payload = (await response.json()) as {
					success?: boolean;
					artifact?: PlanArtifactPreview;
				};
				return payload.artifact ?? null;
			})
			.then((artifact) => {
				setPlanArtifact(artifact);
			})
			.catch(() => {
				setPlanArtifact(null);
			})
			.finally(() => {
				setPlanLoading(false);
			});

		return () => {
			controller.abort();
		};
	}, [
		approvalEventName,
		approvalExecutionId,
		currentRunningNodeId,
		daprPhase,
		isDurablePlanApproval,
	]);

	if (
		daprPhase !== "awaiting_approval" ||
		!approvalEventName ||
		!approvalExecutionId
	) {
		return null;
	}

	const handleAction = async (approved: boolean) => {
		setIsSubmitting(true);
		try {
			await api.dapr.raiseEvent(approvalExecutionId, approvalEventName, {
				approved,
				reason: approved ? "Approved" : "Rejected",
			});
			toast.success(approved ? "Workflow approved" : "Workflow rejected");
			// Mark as responded so polling doesn't re-show
			setApprovalResponded(true);
			// Clear approval UI
			setDaprPhase(null);
			setApprovalEventName(null);
			setApprovalExecutionId(null);
		} catch (error) {
			console.error("Failed to submit approval:", error);
			toast.error("Failed to submit approval");
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<div className="pointer-events-auto absolute top-14 right-0 left-0 z-10 flex justify-center px-4">
			<div className="flex max-h-[60vh] w-full max-w-3xl flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 shadow-lg backdrop-blur-sm">
				<div className="flex items-center gap-3">
					<ShieldCheck
						className="size-5 shrink-0 text-amber-400"
						strokeWidth={1.5}
					/>
					<div className="flex flex-col">
						<span className="text-sm font-medium text-foreground">
							Approval Required
						</span>
						<span className="text-xs text-muted-foreground">
							{isDurablePlanApproval
								? "Plan mode generated a read-only plan. Approve to execute."
								: "Workflow is waiting for your decision."}
						</span>
					</div>
				</div>
				{isDurablePlanApproval && (
					<div className="max-h-64 overflow-auto rounded-md border border-amber-500/20 bg-background/70 p-3">
						{Array.isArray(planArtifact?.metadata?.planWarnings) &&
							planArtifact.metadata.planWarnings.length > 0 && (
								<div className="mb-2 rounded border border-amber-400/40 bg-amber-400/10 p-2 text-amber-200 text-xs">
									{planArtifact.metadata.planWarnings.join(" ")}
								</div>
							)}
						{planLoading ? (
							<p className="text-xs text-muted-foreground">
								Loading plan preview...
							</p>
						) : planArtifact?.planMarkdown ? (
							<pre className="whitespace-pre-wrap break-words font-mono text-xs">
								{planArtifact.planMarkdown}
							</pre>
						) : (
							<p className="text-xs text-muted-foreground">
								Plan preview unavailable.
							</p>
						)}
					</div>
				)}
				<div className="flex gap-2">
					<button
						className="flex items-center gap-1 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
						disabled={isSubmitting}
						onClick={() => handleAction(false)}
						type="button"
					>
						<X className="size-3" />
						Reject
					</button>
					<button
						className="flex items-center gap-1 rounded-md border border-green-500/50 bg-green-500/10 px-3 py-1.5 text-xs font-medium text-green-400 transition-colors hover:bg-green-500/20 disabled:opacity-50"
						disabled={isSubmitting}
						onClick={() => handleAction(true)}
						type="button"
					>
						<Check className="size-3" />
						Approve
					</button>
				</div>
			</div>
		</div>
	);
}
