import type { ActionDefinition } from "@/lib/actions/types";

export function getSystemWorkflowSpecActions(): ActionDefinition[] {
	return [
		{
			id: "system/http-request",
			integration: "system",
			slug: "http-request",
			label: "HTTP Request",
			description: "Make an HTTP request to any API endpoint",
			category: "System",
			configFields: [
				{
					key: "httpMethod",
					label: "HTTP Method",
					type: "select",
					defaultValue: "POST",
					options: [
						{ label: "GET", value: "GET" },
						{ label: "POST", value: "POST" },
						{ label: "PUT", value: "PUT" },
						{ label: "PATCH", value: "PATCH" },
						{ label: "DELETE", value: "DELETE" },
					],
				},
				{
					key: "endpoint",
					label: "URL",
					type: "template-input",
					required: true,
					placeholder: "https://api.example.com/resource",
					example: "https://api.example.com/resource",
				},
				{
					key: "httpHeaders",
					label: "Headers (JSON)",
					type: "template-textarea",
					placeholder: '{"Authorization":"Bearer ..."}',
					defaultValue: "{}",
					example: "{}",
					rows: 4,
				},
				{
					key: "httpBody",
					label: "Body (JSON)",
					type: "template-textarea",
					placeholder: '{"key":"value"}',
					defaultValue: "{}",
					example: "{}",
					rows: 6,
				},
			],
			outputFields: [
				{ field: "status", description: "HTTP status code" },
				{ field: "data", description: "Response body (text or JSON)" },
				{ field: "headers", description: "Response headers" },
			],
		},
		{
			id: "system/database-query",
			integration: "system",
			slug: "database-query",
			label: "Database Query",
			description: "Execute a SQL query using DATABASE_URL credentials",
			category: "System",
			configFields: [
				{
					key: "dbQuery",
					label: "SQL Query",
					type: "template-textarea",
					required: true,
					placeholder: "SELECT * FROM table",
					example: "SELECT 1",
					rows: 6,
				},
				{
					key: "dbSchema",
					label: "Schema (optional)",
					type: "schema-builder",
					defaultValue: "[]",
					example: "[]",
				},
			],
			outputFields: [
				{ field: "rows", description: "Query result rows" },
				{ field: "count", description: "Number of rows" },
			],
		},
		{
			id: "system/condition",
			integration: "system",
			slug: "condition",
			label: "Condition",
			description: "Evaluate a JavaScript expression and branch",
			category: "System",
			configFields: [
				{
					key: "condition",
					label: "Condition Expression",
					type: "template-input",
					required: true,
					placeholder: "status === 200",
					example: "true",
				},
			],
			outputFields: [
				{ field: "result", description: "Boolean result" },
				{ field: "branch", description: "Branch name: true or false" },
			],
		},
		{
			id: "system/ai-text",
			integration: "system",
			slug: "ai-text",
			label: "AI Text Generation",
			description:
				"Generate text using an LLM (OpenAI or Anthropic) with a prompt",
			category: "System",
			configFields: [
				{
					key: "provider",
					label: "Provider",
					type: "select",
					defaultValue: "openai",
					options: [
						{ label: "OpenAI", value: "openai" },
						{ label: "Anthropic", value: "anthropic" },
					],
				},
				{
					key: "model",
					label: "Model",
					type: "model-selector",
					required: true,
					defaultValue: "gpt-4o",
					example: "gpt-4o",
				},
				{
					key: "systemPrompt",
					label: "System Prompt",
					type: "template-textarea",
					placeholder: "You are a helpful assistant...",
					rows: 3,
				},
				{
					key: "prompt",
					label: "Prompt",
					type: "template-textarea",
					required: true,
					placeholder: "Analyze the following data...",
					rows: 6,
				},
				{
					label: "Advanced",
					type: "group",
					defaultExpanded: false,
					fields: [
						{
							key: "temperature",
							label: "Temperature",
							type: "number",
							defaultValue: "0.7",
							min: 0,
							placeholder: "0.7",
						},
						{
							key: "maxTokens",
							label: "Max Tokens",
							type: "number",
							placeholder: "4096",
						},
					],
				},
			],
			outputFields: [
				{ field: "text", description: "Generated text response" },
				{
					field: "usage.promptTokens",
					description: "Number of prompt tokens used",
				},
				{
					field: "usage.completionTokens",
					description: "Number of completion tokens used",
				},
			],
		},
		{
			id: "system/ai-structured",
			integration: "system",
			slug: "ai-structured",
			label: "AI Structured Output",
			description:
				"Extract structured data from text using an LLM with a JSON schema",
			category: "System",
			configFields: [
				{
					key: "provider",
					label: "Provider",
					type: "select",
					defaultValue: "openai",
					options: [
						{ label: "OpenAI", value: "openai" },
						{ label: "Anthropic", value: "anthropic" },
					],
				},
				{
					key: "model",
					label: "Model",
					type: "model-selector",
					required: true,
					defaultValue: "gpt-4o",
					example: "gpt-4o",
				},
				{
					key: "systemPrompt",
					label: "System Prompt",
					type: "template-textarea",
					placeholder: "You are a data extraction assistant...",
					rows: 3,
				},
				{
					key: "prompt",
					label: "Prompt",
					type: "template-textarea",
					required: true,
					placeholder: "Extract the following fields from this text...",
					rows: 6,
				},
				{
					key: "schema",
					label: "Output Schema",
					type: "schema-builder",
					required: true,
				},
				{
					label: "Advanced",
					type: "group",
					defaultExpanded: false,
					fields: [
						{
							key: "schemaName",
							label: "Schema Name",
							type: "text",
							placeholder: "extraction_result",
						},
						{
							key: "temperature",
							label: "Temperature",
							type: "number",
							defaultValue: "0.7",
							min: 0,
							placeholder: "0.7",
						},
						{
							key: "maxTokens",
							label: "Max Tokens",
							type: "number",
							placeholder: "4096",
						},
					],
				},
			],
			outputFields: [
				{
					field: "object",
					description: "Extracted structured data matching the schema",
				},
				{
					field: "usage.promptTokens",
					description: "Number of prompt tokens used",
				},
				{
					field: "usage.completionTokens",
					description: "Number of completion tokens used",
				},
			],
		},
	];
}
