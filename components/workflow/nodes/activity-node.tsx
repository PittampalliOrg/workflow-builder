"use client";

import type { NodeProps } from "@xyflow/react";
import { useAtomValue } from "jotai";
import {
	Brain,
	Check,
	Container,
	Cpu,
	Database,
	GitBranch,
	ImagePlus,
	Lightbulb,
	Mail,
	MessageSquare,
	Rocket,
	Send,
	TestTube2,
	XCircle,
	Zap,
} from "lucide-react";
import { memo } from "react";
import {
	Node,
	NodeDescription,
	NodeTitle,
} from "@/components/ai-elements/node";
import { getDaprActivity } from "@/lib/dapr-activity-registry";
import { cn } from "@/lib/utils";
import {
	executionLogsAtom,
	selectedExecutionIdAtom,
	type WorkflowNodeData,
} from "@/lib/workflow-store";

/**
 * Returns the appropriate icon for an activity based on activity name,
 * icon field, or category fallback.
 */
const getActivityIcon = (
	activityName: string,
	iconName?: string,
	category?: string,
): React.ReactNode => {
	// Activity-specific icons (by name)
	const activityIcons: Record<string, React.ReactNode> = {
		clone_repository: (
			<GitBranch className="size-12 text-orange-400" strokeWidth={1.5} />
		),
		run_planning: (
			<Lightbulb className="size-12 text-yellow-400" strokeWidth={1.5} />
		),
		planning: (
			<Lightbulb className="size-12 text-yellow-400" strokeWidth={1.5} />
		),
		run_execution: (
			<Rocket className="size-12 text-green-400" strokeWidth={1.5} />
		),
		execution: <Rocket className="size-12 text-green-400" strokeWidth={1.5} />,
		testing: (
			<TestTube2 className="size-12 text-purple-400" strokeWidth={1.5} />
		),
		sandboxed_execution_and_testing: (
			<Container className="size-12 text-cyan-400" strokeWidth={1.5} />
		),
		persist_tasks: (
			<Database className="size-12 text-blue-400" strokeWidth={1.5} />
		),
		publish_event: <Send className="size-12 text-pink-400" strokeWidth={1.5} />,
		generate_text: (
			<Brain className="size-12 text-purple-400" strokeWidth={1.5} />
		),
		generate_image: (
			<ImagePlus className="size-12 text-purple-400" strokeWidth={1.5} />
		),
		send_email: <Mail className="size-12 text-green-400" strokeWidth={1.5} />,
		send_slack_message: (
			<MessageSquare className="size-12 text-green-400" strokeWidth={1.5} />
		),
		http_request: <Zap className="size-12 text-amber-400" strokeWidth={1.5} />,
	};

	// Check activity name first
	if (activityIcons[activityName]) {
		return activityIcons[activityName];
	}

	// Icon name mapping (from activity.icon field)
	const iconNameMap: Record<string, React.ReactNode> = {
		Lightbulb: (
			<Lightbulb className="size-12 text-yellow-400" strokeWidth={1.5} />
		),
		Rocket: <Rocket className="size-12 text-green-400" strokeWidth={1.5} />,
		TestTube2: (
			<TestTube2 className="size-12 text-purple-400" strokeWidth={1.5} />
		),
		GitBranch: (
			<GitBranch className="size-12 text-orange-400" strokeWidth={1.5} />
		),
		Container: (
			<Container className="size-12 text-cyan-400" strokeWidth={1.5} />
		),
		Database: <Database className="size-12 text-blue-400" strokeWidth={1.5} />,
		Send: <Send className="size-12 text-pink-400" strokeWidth={1.5} />,
		Zap: <Zap className="size-12 text-amber-400" strokeWidth={1.5} />,
		Brain: <Brain className="size-12 text-purple-400" strokeWidth={1.5} />,
		Mail: <Mail className="size-12 text-green-400" strokeWidth={1.5} />,
		MessageSquare: (
			<MessageSquare className="size-12 text-green-400" strokeWidth={1.5} />
		),
		ImagePlus: (
			<ImagePlus className="size-12 text-purple-400" strokeWidth={1.5} />
		),
	};

	// Check icon name from activity definition
	if (iconName && iconNameMap[iconName]) {
		return iconNameMap[iconName];
	}

	// Category-based fallback icons
	const categoryIcons: Record<string, React.ReactNode> = {
		Agent: <Brain className="size-12 text-yellow-400" strokeWidth={1.5} />,
		AI: <Brain className="size-12 text-purple-400" strokeWidth={1.5} />,
		State: <Database className="size-12 text-blue-400" strokeWidth={1.5} />,
		Events: <Send className="size-12 text-pink-400" strokeWidth={1.5} />,
		Notifications: (
			<Mail className="size-12 text-green-400" strokeWidth={1.5} />
		),
		Integration: <Zap className="size-12 text-amber-400" strokeWidth={1.5} />,
		Plugin: <Zap className="size-12 text-amber-400" strokeWidth={1.5} />,
	};

	if (category && categoryIcons[category]) {
		return categoryIcons[category];
	}

	// Default fallback
	return <Cpu className="size-12 text-blue-400" strokeWidth={1.5} />;
};

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

type ActivityNodeProps = NodeProps & {
	data?: WorkflowNodeData;
	id: string;
};

export const ActivityNode = memo(
	({ data, selected, id }: ActivityNodeProps) => {
		const _selectedExecutionId = useAtomValue(selectedExecutionIdAtom);
		const _executionLogs = useAtomValue(executionLogsAtom);

		if (!data) {
			return null;
		}

		const activityName = (data.config?.activityName as string) || "";
		const activity = activityName ? getDaprActivity(activityName) : undefined;
		const displayTitle = data.label || activity?.label || "Activity";
		const displayDescription =
			data.description || activity?.category || "Dapr Activity";
		const status = data.status;

		// Show timeout if configured
		const timeout = (data.config?.timeout as number) || activity?.timeout;

		return (
			<Node
				className={cn(
					"relative flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
					selected && "border-primary",
				)}
				data-testid={`activity-node-${id}`}
				handles={{ target: true, source: true }}
				runnable
				selected={selected}
				status={status}
			>
				<StatusBadge status={status} />

				<div className="flex flex-col items-center justify-center gap-3 p-6">
					{getActivityIcon(activityName, activity?.icon, activity?.category)}
					<div className="flex flex-col items-center gap-1 text-center">
						<NodeTitle className="text-base">{displayTitle}</NodeTitle>
						<NodeDescription className="text-xs">
							{displayDescription}
						</NodeDescription>
						{timeout && (
							<div className="rounded-full border border-muted-foreground/50 px-2 py-0.5 font-medium text-[10px] text-muted-foreground">
								{timeout}s timeout
							</div>
						)}
					</div>
				</div>
			</Node>
		);
	},
);

ActivityNode.displayName = "ActivityNode";
