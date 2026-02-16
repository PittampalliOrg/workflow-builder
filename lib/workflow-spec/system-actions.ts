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
	];
}
