/**
 * Upsert the browser-use Browserstation smoke workflow from its spec-first JSON file.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/upsert-browser-use-agent-browserstation-smoke-workflow.mjs
 */

import path from "node:path";
import { spawn } from "node:child_process";

const WORKFLOW_JSON_PATH = path.resolve(
	process.cwd(),
	"services/browser-use-agent/browser-use-agent-browserstation-smoke.workflow.json",
);

const child = spawn(
	process.execPath,
	["scripts/upsert-workflow-json.mjs", WORKFLOW_JSON_PATH, ...process.argv.slice(2)],
	{
		stdio: "inherit",
		env: process.env,
	},
);

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exitCode = code ?? 1;
});
