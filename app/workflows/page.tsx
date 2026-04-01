"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { SUPPORTED_WORKFLOW_ID } from "@/lib/serverless-workflow/cutover";

export default function WorkflowsPage() {
	const router = useRouter();

	useEffect(() => {
		router.replace(`/workflows/${SUPPORTED_WORKFLOW_ID}`);
	}, [router]);

	return null;
}
