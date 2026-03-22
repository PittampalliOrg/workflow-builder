import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	output: "standalone",
	outputFileTracingExcludes: {
		"/*": [
			".build-trigger/**/*",
			".cursor/**/*",
			".devspace/**/*",
			".github/**/*",
			"docs/**/*",
			"e2e/**/*",
			"tests/**/*",
			"workspace-runs/**/*",
			"services/**/*",
			"Dockerfile",
			"Dockerfile.devspace",
			"LICENSE",
			"biome.jsonc",
			"components.json",
			"config_types.rs",
			"devspace.yaml",
			"drizzle.config.ts",
			"example-workflow.json",
			"function-templates/**/*",
			"knip.json",
			"plan.rs",
			"playwright.config.ts",
			"pnpm-lock.yaml",
			"pnpm-workspace.yaml",
			"proposed_plan_parser.rs",
			"vercel-template.json",
			"vitest.config.ts",
			"**/*.md",
			"**/*.png",
			"**/*.txt",
			"**/*.zip",
			"tsconfig.tsbuildinfo",
		],
	},
	allowedDevOrigins: [
		"ai-chatbot-ryzen.tail286401.ts.net",
		"workflow-builder-ryzen.tail286401.ts.net",
		"localhost",
		"127.0.0.1",
	],
	serverExternalPackages: [
		"@mcp-ui/server",
		"@modelcontextprotocol/sdk",
		"@modelcontextprotocol/ext-apps",
		"@opentelemetry/api",
		"@opentelemetry/auto-instrumentations-node",
		"@opentelemetry/exporter-metrics-otlp-http",
		"@opentelemetry/exporter-trace-otlp-http",
		"@opentelemetry/resources",
		"@opentelemetry/sdk-metrics",
		"@opentelemetry/sdk-node",
		"@opentelemetry/semantic-conventions",
	],
	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "avatars.githubusercontent.com",
			},
			{
				protocol: "https",
				hostname: "lh3.googleusercontent.com",
			},
		],
	},
};

export default nextConfig;
