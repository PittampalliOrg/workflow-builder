#!/usr/bin/env tsx

console.error(
	[
		"[sync-pieces] retired: piece_metadata is now generated inside the piece-mcp-server image.",
		"Use:",
		"  cd services/piece-mcp-server",
		"  DATABASE_URL=postgres://... pnpm sync:metadata",
		"",
		"GitOps runs the same command from the pinned PIECE_MCP_IMAGE before activepieces-mcps reconciles KServices.",
	].join("\n"),
);
process.exit(2);
