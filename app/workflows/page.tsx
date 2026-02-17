"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/lib/api-client";
import {
	getNavigableWorkflows,
	LAST_SELECTED_WORKFLOW_ID_KEY,
	pickWorkflowRedirectId,
} from "@/lib/workflow-navigation";

export default function WorkflowsPage() {
	const router = useRouter();

	useEffect(() => {
		const redirectToWorkflow = async () => {
			try {
				const workflows = await api.workflow.getAll();
				const navigableWorkflows = getNavigableWorkflows(workflows);
				const lastSelectedWorkflowId = window.localStorage.getItem(
					LAST_SELECTED_WORKFLOW_ID_KEY,
				);
				const workflowId = pickWorkflowRedirectId(
					navigableWorkflows,
					lastSelectedWorkflowId,
				);

				if (workflowId) {
					router.replace(`/workflows/${workflowId}`);
					return;
				}

				// No workflows, redirect to homepage
				router.replace("/");
			} catch (error) {
				console.error("Failed to load workflows:", error);
				router.replace("/");
			}
		};

		redirectToWorkflow();
	}, [router]);

	return null;
}
