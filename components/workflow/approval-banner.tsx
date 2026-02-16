"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { Check, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import {
	approvalEventNameAtom,
	approvalExecutionIdAtom,
	approvalRespondedAtom,
	daprPhaseAtom,
} from "@/lib/workflow-store";

export function ApprovalBanner() {
	const daprPhase = useAtomValue(daprPhaseAtom);
	const approvalEventName = useAtomValue(approvalEventNameAtom);
	const approvalExecutionId = useAtomValue(approvalExecutionIdAtom);
	const setDaprPhase = useSetAtom(daprPhaseAtom);
	const setApprovalEventName = useSetAtom(approvalEventNameAtom);
	const setApprovalExecutionId = useSetAtom(approvalExecutionIdAtom);
	const setApprovalResponded = useSetAtom(approvalRespondedAtom);
	const [isSubmitting, setIsSubmitting] = useState(false);

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
			<div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 shadow-lg backdrop-blur-sm">
				<ShieldCheck
					className="size-5 shrink-0 text-amber-400"
					strokeWidth={1.5}
				/>
				<div className="flex flex-col">
					<span className="text-sm font-medium text-foreground">
						Approval Required
					</span>
					<span className="text-xs text-muted-foreground">
						Workflow is waiting for your decision
					</span>
				</div>
				<div className="ml-2 flex gap-2">
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
