"use client";

import type { NodeProps } from "@xyflow/react";
import { useAtomValue, useSetAtom } from "jotai";
import { Check, Clock, ShieldCheck, X, XCircle } from "lucide-react";
import { memo, useState } from "react";
import { toast } from "sonner";
import {
	Node,
	NodeDescription,
	NodeTitle,
} from "@/components/ai-elements/node";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
	approvalEventNameAtom,
	approvalExecutionIdAtom,
	approvalRespondedAtom,
	daprPhaseAtom,
	type WorkflowNodeData,
} from "@/lib/workflow-store";

const StatusBadge = ({
	status,
}: {
	status?: "idle" | "running" | "success" | "error";
}) => {
	if (!status || status === "idle" || status === "running") {
		return null;
	}

	return (
		<div
			className={cn(
				"absolute top-2 right-2 rounded-full p-1",
				status === "success" && "bg-green-500/50",
				status === "error" && "bg-red-500/50",
			)}
		>
			{status === "success" && (
				<Check className="size-3.5 text-white" strokeWidth={2.5} />
			)}
			{status === "error" && (
				<XCircle className="size-3.5 text-white" strokeWidth={2.5} />
			)}
		</div>
	);
};

type ApprovalGateNodeProps = NodeProps & {
	data?: WorkflowNodeData;
	id: string;
};

export const ApprovalGateNode = memo(
	({ data, selected, id }: ApprovalGateNodeProps) => {
		const daprPhase = useAtomValue(daprPhaseAtom);
		const approvalEventName = useAtomValue(approvalEventNameAtom);
		const approvalExecutionId = useAtomValue(approvalExecutionIdAtom);
		const setDaprPhase = useSetAtom(daprPhaseAtom);
		const setApprovalEventName = useSetAtom(approvalEventNameAtom);
		const setApprovalExecutionId = useSetAtom(approvalExecutionIdAtom);
		const setApprovalResponded = useSetAtom(approvalRespondedAtom);
		const [isApproving, setIsApproving] = useState(false);

		if (!data) {
			return null;
		}

		const eventName = (data.config?.eventName as string) || "approval_event";
		const timeoutMinutes = (data.config?.timeoutMinutes as number) || 5;
		const displayTitle = data.label || "Approval Gate";
		const displayDescription = data.description || `Wait for ${eventName}`;
		const status = data.status;

		const isWaitingForApproval = daprPhase === "awaiting_approval";

		const handleApprove = async (approved: boolean) => {
			if (!approvalExecutionId || !approvalEventName) return;
			setIsApproving(true);
			try {
				await api.dapr.raiseEvent(approvalExecutionId, approvalEventName, {
					approved,
					reason: approved ? "Approved" : "Rejected",
				});
				toast.success(approved ? "Approved" : "Rejected");
				// Mark as responded so polling doesn't re-show, then clear approval UI
				setApprovalResponded(true);
				setDaprPhase(null);
				setApprovalEventName(null);
				setApprovalExecutionId(null);
			} catch (error) {
				console.error("Failed to submit approval:", error);
				toast.error("Failed to submit approval");
			} finally {
				setIsApproving(false);
			}
		};

		return (
			<Node
				className={cn(
					"relative flex w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
					isWaitingForApproval ? "h-56" : "h-48",
					selected && "border-primary",
					isWaitingForApproval && "border-amber-400",
				)}
				data-testid={`approval-gate-node-${id}`}
				handles={{ target: true, source: true }}
				status={isWaitingForApproval ? "running" : status}
			>
				<StatusBadge status={status} />

				<div className="flex flex-col items-center justify-center gap-3 p-6">
					<ShieldCheck
						className={cn(
							"strokeWidth-[1.5] size-12",
							isWaitingForApproval ? "text-amber-400" : "text-amber-300",
						)}
						strokeWidth={1.5}
					/>
					<div className="flex flex-col items-center gap-1 text-center">
						<NodeTitle className="text-base">{displayTitle}</NodeTitle>
						<NodeDescription className="text-xs">
							{displayDescription}
						</NodeDescription>
						<div className="flex items-center gap-1 rounded-full border border-muted-foreground/50 px-2 py-0.5 font-medium text-[10px] text-muted-foreground">
							<Clock className="size-3" />
							{timeoutMinutes}m timeout
						</div>
					</div>

					{/* Approve / Reject buttons */}
					{isWaitingForApproval && approvalEventName && (
						<div className="flex gap-2">
							<button
								className="flex items-center gap-1 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
								disabled={isApproving}
								onClick={(e) => {
									e.stopPropagation();
									handleApprove(false);
								}}
								type="button"
							>
								<X className="size-3" />
								Reject
							</button>
							<button
								className="flex items-center gap-1 rounded-md border border-green-500/50 bg-green-500/10 px-3 py-1 text-xs font-medium text-green-400 transition-colors hover:bg-green-500/20 disabled:opacity-50"
								disabled={isApproving}
								onClick={(e) => {
									e.stopPropagation();
									handleApprove(true);
								}}
								type="button"
							>
								<Check className="size-3" />
								Approve
							</button>
						</div>
					)}
				</div>
			</Node>
		);
	},
);

ApprovalGateNode.displayName = "ApprovalGateNode";
