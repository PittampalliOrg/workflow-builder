/**
 * Kubernetes Agent Sandbox
 *
 * Implements Mastra's WorkspaceSandbox interface using kubernetes-sigs/agent-sandbox.
 * Creates a SandboxClaim CR, waits for the pod to be provisioned (from the warm pool),
 * and routes commands via HTTP to the sandbox pod's /execute endpoint (port 8888).
 *
 * Implements the sandbox pattern in TypeScript for Mastra agent execution.
 *
 * Prerequisites:
 * - agent-sandbox controller + CRDs deployed in cluster
 * - SandboxTemplate "dapr-agent" (or custom) in agent-sandbox namespace
 * - ServiceAccount for mastra-agent-tanstack bound to sandbox-claim-creator ClusterRole
 */

import { MastraSandbox } from "@mastra/core/workspace";
import type {
	MastraSandboxOptions,
	CommandResult,
	ExecuteCommandOptions,
	SandboxInfo,
} from "@mastra/core/workspace";
import type { ProviderStatus } from "@mastra/core/workspace";
import { request as httpsRequest } from "node:https";
import { readFileSync, existsSync } from "node:fs";

// ── K8s In-Cluster Auth ───────────────────────────────────────

const K8S_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const K8S_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

const K8S_HOST =
	process.env.KUBERNETES_SERVICE_HOST || "kubernetes.default.svc";
const K8S_PORT = process.env.KUBERNETES_SERVICE_PORT || "443";

// CRD API paths
const CLAIM_API_GROUP = "extensions.agents.x-k8s.io";
const CLAIM_API_VERSION = "v1alpha1";
const CLAIM_PLURAL = "sandboxclaims";

// ── K8s API Helpers ───────────────────────────────────────────

function readK8sToken(): string {
	return readFileSync(K8S_TOKEN_PATH, "utf-8").trim();
}

function readK8sCa(): Buffer | undefined {
	if (existsSync(K8S_CA_PATH)) {
		return readFileSync(K8S_CA_PATH);
	}
	return undefined;
}

/** Low-level K8s API request using node:https. */
function k8sRequest(method: string, path: string, body?: object): Promise<any> {
	return new Promise((resolve, reject) => {
		const token = readK8sToken();
		const ca = readK8sCa();

		const req = httpsRequest(
			{
				hostname: K8S_HOST,
				port: parseInt(K8S_PORT, 10),
				path,
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				ca,
				// In some clusters the API server cert may not match hostname
				rejectUnauthorized: ca !== undefined,
			},
			(res) => {
				let data = "";
				res.on("data", (chunk: string) => (data += chunk));
				res.on("end", () => {
					try {
						const parsed = JSON.parse(data);
						if (res.statusCode && res.statusCode >= 400) {
							reject(
								new Error(
									`K8s API ${method} ${path} returned ${res.statusCode}: ${parsed.message || data}`,
								),
							);
						} else {
							resolve(parsed);
						}
					} catch {
						reject(
							new Error(
								`K8s API ${method} ${path} returned ${res.statusCode}: ${data}`,
							),
						);
					}
				});
			},
		);

		req.on("error", reject);
		if (body) req.write(JSON.stringify(body));
		req.end();
	});
}

// ── K8s Sandbox Options ───────────────────────────────────────

export interface K8sSandboxOptions extends MastraSandboxOptions {
	/** SandboxTemplate name (default: SANDBOX_TEMPLATE env or "dapr-agent") */
	templateName?: string;
	/** K8s namespace for sandbox pods (default: SANDBOX_NAMESPACE env or "agent-sandbox") */
	namespace?: string;
	/** Working directory inside the sandbox pod (default: SANDBOX_WORKSPACE_DIR env or "/app") */
	workingDirectory?: string;
	/** Default command timeout in ms (default: SANDBOX_TIMEOUT_MS env or 30000) */
	timeout?: number;
	/** Max time to wait for sandbox pod to be ready in ms (default: 60000) */
	provisionTimeout?: number;
}

// ── K8sSandbox Class ──────────────────────────────────────────

export class K8sSandbox extends MastraSandbox {
	readonly id: string;
	readonly name = "K8sSandbox";
	readonly provider = "kubernetes";
	status: ProviderStatus = "pending";

	private readonly templateName: string;
	private readonly sandboxNamespace: string;
	private readonly _workingDirectory: string;
	private readonly _timeout: number;
	private readonly _provisionTimeout: number;

	private claimName: string | null = null;
	private sandboxPodName: string | null = null;
	private podIp: string | null = null;
	private readonly _createdAt = new Date();

	get workingDirectory(): string {
		return this._workingDirectory;
	}

	/** Get the sandbox pod's cluster IP (null if not yet provisioned). */
	getSandboxPodIp(): string | null {
		return this.podIp;
	}

	constructor(options: K8sSandboxOptions = {}) {
		super({ name: "K8sSandbox", ...options });
		this.id = `k8s-sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.templateName =
			options.templateName || process.env.SANDBOX_TEMPLATE || "dapr-agent";
		this.sandboxNamespace =
			options.namespace || process.env.SANDBOX_NAMESPACE || "agent-sandbox";
		this._workingDirectory =
			options.workingDirectory || process.env.SANDBOX_WORKSPACE_DIR || "/app";
		this._timeout = options.timeout
			? options.timeout
			: parseInt(process.env.SANDBOX_TIMEOUT_MS || "30000", 10);
		this._provisionTimeout = options.provisionTimeout || 60_000;
	}

	// ── Lifecycle ─────────────────────────────────────────────

	async start(): Promise<void> {
		console.log(
			`[k8s-sandbox] Creating SandboxClaim (template=${this.templateName}, namespace=${this.sandboxNamespace})`,
		);

		// Generate a unique claim name
		this.claimName = `mastra-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		// Create SandboxClaim CR
		const claimPath = `/apis/${CLAIM_API_GROUP}/${CLAIM_API_VERSION}/namespaces/${this.sandboxNamespace}/${CLAIM_PLURAL}`;
		await k8sRequest("POST", claimPath, {
			apiVersion: `${CLAIM_API_GROUP}/${CLAIM_API_VERSION}`,
			kind: "SandboxClaim",
			metadata: {
				name: this.claimName,
				namespace: this.sandboxNamespace,
				labels: {
					"app.kubernetes.io/managed-by": "mastra-agent-tanstack",
					"mastra-sandbox-id": this.id,
				},
			},
			spec: {
				sandboxTemplateRef: {
					name: this.templateName,
				},
			},
		});

		console.log(
			`[k8s-sandbox] SandboxClaim "${this.claimName}" created, waiting for pod...`,
		);

		// Poll until sandbox pod is ready
		const sandboxName = await this.waitForSandboxReady();
		this.sandboxPodName = sandboxName;

		// Get pod IP
		this.podIp = await this.getPodIp(sandboxName);

		console.log(
			`[k8s-sandbox] Sandbox ready: pod=${sandboxName}, ip=${this.podIp}`,
		);
	}

	async stop(): Promise<void> {
		console.log("[k8s-sandbox] Stopping (sandbox pod remains active)");
		// Stop doesn't destroy — just marks as stopped.
		// The sandbox pod stays alive for potential restart.
	}

	async destroy(): Promise<void> {
		if (this.claimName) {
			console.log(`[k8s-sandbox] Deleting SandboxClaim "${this.claimName}"`);
			try {
				const claimPath = `/apis/${CLAIM_API_GROUP}/${CLAIM_API_VERSION}/namespaces/${this.sandboxNamespace}/${CLAIM_PLURAL}/${this.claimName}`;
				await k8sRequest("DELETE", claimPath);
				console.log(`[k8s-sandbox] SandboxClaim "${this.claimName}" deleted`);
			} catch (err) {
				console.warn(`[k8s-sandbox] Failed to delete SandboxClaim: ${err}`);
			}
			this.claimName = null;
			this.sandboxPodName = null;
			this.podIp = null;
		}
	}

	async isReady(): Promise<boolean> {
		return this.podIp !== null;
	}

	async getInfo(): Promise<SandboxInfo> {
		return {
			id: this.id,
			name: this.name,
			provider: this.provider,
			status: this.status,
			createdAt: this._createdAt,
			metadata: {
				templateName: this.templateName,
				namespace: this.sandboxNamespace,
				claimName: this.claimName,
				podName: this.sandboxPodName,
				podIp: this.podIp,
			},
		};
	}

	getInstructions(): string {
		return (
			"Commands execute in an isolated Kubernetes Agent Sandbox pod. " +
			`The working directory is ${this._workingDirectory}. ` +
			"File operations and commands share the same sandbox filesystem."
		);
	}

	// ── Command Execution ─────────────────────────────────────

	async executeCommand(
		command: string,
		args?: string[],
		options?: ExecuteCommandOptions,
	): Promise<CommandResult> {
		if (!this.podIp) {
			throw new Error("K8s sandbox not ready — call start() first");
		}

		// Build the full command string
		let fullCommand: string;
		if (args && args.length > 0) {
			// command + args (e.g., "sh" + ["-c", "echo hello"])
			const escaped = args.map((a) =>
				a.includes(" ") ? `"${a.replace(/"/g, '\\"')}"` : a,
			);
			fullCommand = `${command} ${escaped.join(" ")}`;
		} else {
			fullCommand = command;
		}

		const timeout = options?.timeout ?? this._timeout;
		const cwd = options?.cwd ?? this._workingDirectory;

		// Wrap with cd to working directory
		const wrappedCommand = `/bin/sh -c "cd ${cwd} && ${fullCommand.replace(/"/g, '\\"')}"`;

		const startTime = Date.now();

		try {
			const result = await this.callSandboxExecute(wrappedCommand, timeout);
			const executionTimeMs = Date.now() - startTime;

			return {
				command,
				args,
				stdout: result.stdout || "",
				stderr: result.stderr || "",
				exitCode: result.exit_code ?? 0,
				success: result.exit_code === 0,
				executionTimeMs,
			};
		} catch (err) {
			const executionTimeMs = Date.now() - startTime;
			const isTimeout = err instanceof Error && err.message.includes("timeout");

			return {
				command,
				args,
				stdout: "",
				stderr: err instanceof Error ? err.message : String(err),
				exitCode: isTimeout ? 124 : 1,
				success: false,
				executionTimeMs,
				timedOut: isTimeout,
			};
		}
	}

	// ── Private Helpers ───────────────────────────────────────

	/**
	 * POST to the sandbox pod's /execute endpoint.
	 * The python-runtime-sandbox listens on port 8888.
	 */
	private async callSandboxExecute(
		command: string,
		timeoutMs: number,
	): Promise<{ stdout: string; stderr: string; exit_code: number }> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const res = await fetch(`http://${this.podIp}:8888/execute`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ command }),
				signal: controller.signal,
			});

			if (!res.ok) {
				const text = await res.text();
				throw new Error(`Sandbox /execute returned ${res.status}: ${text}`);
			}

			return (await res.json()) as {
				stdout: string;
				stderr: string;
				exit_code: number;
			};
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Poll SandboxClaim status until the sandbox pod name is available.
	 */
	private async waitForSandboxReady(): Promise<string> {
		const start = Date.now();
		const claimPath = `/apis/${CLAIM_API_GROUP}/${CLAIM_API_VERSION}/namespaces/${this.sandboxNamespace}/${CLAIM_PLURAL}/${this.claimName}`;

		while (Date.now() - start < this._provisionTimeout) {
			const claim = await k8sRequest("GET", claimPath);

			// Check status.sandbox.Name
			const sandboxName = claim.status?.sandbox?.Name;
			if (sandboxName) {
				return sandboxName;
			}

			// Check for error conditions
			const conditions = claim.status?.conditions || [];
			for (const cond of conditions) {
				if (
					cond.type === "Ready" &&
					cond.status === "False" &&
					cond.reason === "Failed"
				) {
					throw new Error(`SandboxClaim failed: ${cond.message}`);
				}
			}

			// Wait 1s before polling again
			await new Promise((r) => setTimeout(r, 1000));
		}

		throw new Error(
			`SandboxClaim "${this.claimName}" not ready after ${this._provisionTimeout}ms`,
		);
	}

	/**
	 * Get the cluster IP of the sandbox's pod.
	 *
	 * Tries three strategies:
	 * 1. Warm pool pods: `agents.x-k8s.io/pod-name` annotation on the Sandbox resource
	 * 2. Non-pooled pods: `status.selector` label selector to find the pod
	 * 3. Fallback: pod named after the sandbox itself
	 */
	private async getPodIp(sandboxName: string): Promise<string> {
		const start = Date.now();
		while (Date.now() - start < 60_000) {
			try {
				const sandboxPath = `/apis/agents.x-k8s.io/v1alpha1/namespaces/${this.sandboxNamespace}/sandboxes/${sandboxName}`;
				const sandboxResource = await k8sRequest("GET", sandboxPath);

				// Strategy 1: Warm pool — pod name in annotation
				const podName =
					sandboxResource.metadata?.annotations?.["agents.x-k8s.io/pod-name"];
				if (podName) {
					const ip = await this.getPodIpByName(podName);
					if (ip) return ip;
				}

				// Strategy 2: Label selector from status
				const selector = sandboxResource.status?.selector;
				if (selector) {
					const ip = await this.getPodIpBySelector(selector);
					if (ip) return ip;
				}

				// Strategy 3: Pod named after the sandbox
				{
					const ip = await this.getPodIpByName(sandboxName);
					if (ip) return ip;
				}
			} catch {
				// Sandbox or pod may not be ready yet
			}
			await new Promise((r) => setTimeout(r, 1000));
		}

		throw new Error(`Could not get IP for sandbox "${sandboxName}" after 60s`);
	}

	private async getPodIpByName(podName: string): Promise<string | null> {
		try {
			const podPath = `/api/v1/namespaces/${this.sandboxNamespace}/pods/${podName}`;
			const pod = await k8sRequest("GET", podPath);
			const ip = pod.status?.podIP;
			if (ip && pod.status?.phase === "Running") {
				console.log(`[k8s-sandbox] Resolved pod: ${podName} → ${ip}`);
				return ip;
			}
		} catch {
			// Pod not found or not ready
		}
		return null;
	}

	private async getPodIpBySelector(selector: string): Promise<string | null> {
		try {
			const listPath = `/api/v1/namespaces/${this.sandboxNamespace}/pods?labelSelector=${encodeURIComponent(selector)}`;
			const podList = await k8sRequest("GET", listPath);
			for (const pod of podList.items || []) {
				const ip = pod.status?.podIP;
				if (ip && pod.status?.phase === "Running") {
					const name = pod.metadata?.name || "unknown";
					console.log(
						`[k8s-sandbox] Resolved pod via selector: ${name} → ${ip}`,
					);
					return ip;
				}
			}
		} catch {
			// List failed
		}
		return null;
	}
}
