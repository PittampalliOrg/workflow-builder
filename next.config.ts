import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	output: "standalone",
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
