export type WorkflowAiMentionRef =
	| {
			id: string;
			type: "node";
			nodeId: string;
			label: string;
			description?: string;
	  }
	| {
			id: string;
			type: "action";
			actionType: string;
			label: string;
			description?: string;
	  }
	| {
			id: string;
			type: "execution";
			executionId: string;
			label: string;
			description?: string;
	  };

export type WorkflowAiToolMessageRole = "user" | "assistant" | "system";

export type WorkflowAiToolStoredPart = Record<string, unknown>;
