/**
 * Centralized Sandbox Configuration
 *
 * Factory that creates the appropriate sandbox based on SANDBOX_BACKEND:
 * - "k8s": K8sSandbox — routes commands to an isolated Agent Sandbox pod
 *   (kubernetes-sigs/agent-sandbox). Requires in-cluster ServiceAccount
 *   with sandbox-claim-creator RBAC.
 * - "local": LocalSandbox with bwrap auto-detection, env allowlist, and
 *   lifecycle hooks. Falls back to isolation='none' if bwrap unavailable.
 *
 * Both agent.ts and tool-executor.ts use the shared instance exported here.
 */

import { LocalSandbox, LocalFilesystem } from "@mastra/core/workspace";
import type {
	WorkspaceSandbox,
	WorkspaceFilesystem,
	CommandResult,
} from "@mastra/core/workspace";
import { K8sSandbox } from "./k8s-sandbox";
import { K8sRemoteFilesystem } from "./k8s-remote-filesystem";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

export const WORKSPACE_PATH = resolve(
	process.env.AGENT_WORKSPACE_PATH || "./workspace",
);

const SANDBOX_BACKEND = process.env.SANDBOX_BACKEND || detectBackend();

/** Auto-detect: use K8s if running in-cluster, local otherwise. */
function detectBackend(): "k8s" | "local" {
	if (existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token")) {
		console.log("[sandbox] Detected in-cluster environment, using k8s backend");
		return "k8s";
	}
	console.log("[sandbox] No K8s service account found, using local backend");
	return "local";
}

// ── Environment Allowlist (for local sandbox) ─────────────────
const ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"NODE_ENV",
	"LANG",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
];

function buildAllowedEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ENV_ALLOWLIST) {
		if (process.env[key]) {
			env[key] = process.env[key];
		}
	}
	return env;
}

// ── Local Sandbox Factory ─────────────────────────────────────

function createLocalSandbox(): LocalSandbox {
	// Auto-detect isolation backend (bwrap on Linux, seatbelt on macOS)
	const override = process.env.SANDBOX_ISOLATION;
	let isolation: "none" | "bwrap" | "seatbelt";

	if (override === "none" || override === "bwrap" || override === "seatbelt") {
		console.log(
			`[sandbox] Local isolation forced via SANDBOX_ISOLATION=${override}`,
		);
		isolation = override;
	} else {
		const detection = LocalSandbox.detectIsolation();
		if (detection.available) {
			console.log(
				`[sandbox] Auto-detected ${detection.backend} isolation: ${detection.message}`,
			);
			isolation = detection.backend;
		} else {
			console.warn(
				`[sandbox] ${detection.message}. Falling back to isolation='none'`,
			);
			isolation = "none";
		}
	}

	const allowNetwork = process.env.SANDBOX_ALLOW_NETWORK === "true";
	const timeout = parseInt(process.env.SANDBOX_TIMEOUT_MS || "30000", 10);

	return new LocalSandbox({
		workingDirectory: WORKSPACE_PATH,
		isolation,
		timeout,
		env: buildAllowedEnv(),
		nativeSandbox: {
			allowNetwork,
			allowSystemBinaries: true,
			readOnlyPaths: ["/usr/local/lib/node_modules"],
			readWritePaths: ["/tmp"],
		},
		onStart: async () => {
			console.log(
				`[sandbox] LocalSandbox started (isolation=${isolation}, network=${allowNetwork}, timeout=${timeout}ms)`,
			);
		},
		onStop: async () => {
			console.log("[sandbox] LocalSandbox stopped");
		},
		onDestroy: async () => {
			console.log("[sandbox] LocalSandbox destroyed");
		},
	});
}

// ── K8s Sandbox Factory ───────────────────────────────────────

function createK8sSandbox(): K8sSandbox {
	const timeout = parseInt(process.env.SANDBOX_TIMEOUT_MS || "30000", 10);

	return new K8sSandbox({
		timeout,
		onStart: async () => {
			console.log("[sandbox] K8sSandbox started");
		},
		onStop: async () => {
			console.log("[sandbox] K8sSandbox stopped");
		},
		onDestroy: async () => {
			console.log("[sandbox] K8sSandbox destroyed");
		},
	});
}

// ── Export Shared Instances ───────────────────────────────────

export const sandbox: WorkspaceSandbox =
	SANDBOX_BACKEND === "k8s" ? createK8sSandbox() : createLocalSandbox();

export const filesystem: WorkspaceFilesystem =
	SANDBOX_BACKEND === "k8s"
		? new K8sRemoteFilesystem({
				sandbox: sandbox as K8sSandbox,
				basePath: "/app",
			})
		: new LocalFilesystem({ basePath: WORKSPACE_PATH });

console.log(`[sandbox] Backend: ${SANDBOX_BACKEND}`);

// ── Helper for tool-executor ──────────────────────────────────

/**
 * Execute a shell command string through the sandbox.
 * For LocalSandbox: wraps as `sh -c "command"`.
 * For K8sSandbox: routes to the sandbox pod's /execute endpoint.
 */
export async function executeCommandViaSandbox(
	command: string,
	opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const timeout =
		opts?.timeout ?? parseInt(process.env.SANDBOX_TIMEOUT_MS || "30000", 10);

	const result: CommandResult = await sandbox.executeCommand!(
		"sh",
		["-c", command],
		{ timeout },
	);
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
	};
}
