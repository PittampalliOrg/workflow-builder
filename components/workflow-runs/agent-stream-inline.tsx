"use client";

import { useAgentStream } from "@/hooks/use-agent-stream";
import { SandboxOutput } from "@/components/workflow-runs/sandbox-output";

export function AgentStreamInline({
	executionId,
	isActive,
}: {
	executionId: string;
	isActive: boolean;
}) {
	const agentStream = useAgentStream({ executionId, enabled: isActive });

	if (
		!agentStream.isConnected &&
		agentStream.sandboxOutputs.length === 0 &&
		!agentStream.activeSandboxCommand
	) {
		return null;
	}

	return (
		<div className="px-4 pb-3">
			<SandboxOutput
				outputs={agentStream.sandboxOutputs}
				activeSandboxLines={agentStream.activeSandboxLines}
				activeSandboxCommand={agentStream.activeSandboxCommand}
			/>
		</div>
	);
}
