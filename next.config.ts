import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	output: "standalone",
	allowedDevOrigins: [
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
