import type { ToolCall } from "./tool.js";

export type LoopToolChoice =
	| "auto"
	| "none"
	| "required"
	| {
			type: "tool";
			toolName: string;
	  };

export type LoopStopCondition =
	| {
			type: "stepCountIs";
			maxSteps: number;
	  }
	| {
			type: "hasToolCall";
			toolName: string;
	  }
	| {
			type: "toolCallNeedsApproval";
			toolNames?: string[];
	  }
	| {
			type: "toolWithoutExecute";
	  }
	| {
			type: "assistantTextIncludes";
			text: string;
			caseSensitive?: boolean;
	  }
	| {
			type: "assistantTextMatchesRegex";
			pattern: string;
			flags?: string;
	  }
	| {
			type: "totalUsageAtLeast";
			inputTokens?: number;
			outputTokens?: number;
			totalTokens?: number;
	  }
	| {
			type: "costEstimateExceeds";
			usd: number;
			inputPer1kUsd?: number;
			outputPer1kUsd?: number;
	  }
	| {
			type: "celExpression";
			expression: string;
	  };

export interface LoopPrepareStepRule {
	fromStep?: number;
	toStep?: number;
	when?: string;
	model?: string;
	activeTools?: string[];
	toolChoice?: LoopToolChoice;
	trimMessagesTo?: number;
	truncateToolResultChars?: number;
	appendInstructions?: string;
}

export interface LoopPrepareStepPolicy {
	model?: string;
	activeTools?: string[];
	toolChoice?: LoopToolChoice;
	trimMessagesTo?: number;
	truncateToolResultChars?: number;
	appendInstructions?: string;
	rules?: LoopPrepareStepRule[];
}

export interface LoopDoneToolConfig {
	enabled?: boolean;
	name?: string;
	description?: string;
	inputSchema?: unknown;
	responseField?: string;
}

export interface LoopPolicy {
	stopWhen?: LoopStopCondition | LoopStopCondition[];
	prepareStep?: LoopPrepareStepPolicy;
	approvalRequiredTools?: string[];
	defaultToolChoice?: LoopToolChoice;
	defaultActiveTools?: string[];
	doneTool?: LoopDoneToolConfig;
}

export interface LoopUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

export interface LoopStepRecord {
	stepNumber: number;
	assistantText: string | null;
	toolCalls: ToolCall[];
	usage?: LoopUsage;
}

export interface LoopDeclarationOnlyTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
	approvalRequired?: boolean;
}

export interface LoopPreparedStep {
	modelSpec?: string;
	activeTools?: string[];
	toolChoice?: LoopToolChoice;
	trimMessagesTo?: number;
	truncateToolResultChars?: number;
	appendInstructions?: string;
	declarationOnlyTools?: LoopDeclarationOnlyTool[];
}
