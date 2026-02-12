import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	output: "standalone",
	serverExternalPackages: [
		"@mcp-ui/server",
		"@modelcontextprotocol/sdk",
		"@modelcontextprotocol/ext-apps",
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
