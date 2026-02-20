/**
 * Kubernetes Agent Sandbox
 *
 * Standalone implementation (no @mastra/core dependency) using kubernetes-sigs/agent-sandbox.
 * Creates a SandboxClaim CR, waits for the pod to be provisioned (from the warm pool),
 * and routes commands via HTTP to the sandbox pod's /execute endpoint (port 8888).
 *
 * Prerequisites:
 * - agent-sandbox controller + CRDs deployed in cluster
 * - SandboxTemplate "dapr-agent" (or custom) in agent-sandbox namespace
 * - ServiceAccount bound to sandbox-claim-creator ClusterRole
 */

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

// ── Types ─────────────────────────────────────────────────────

export interface CommandResult {
	command: string;
	args?: string[];
	stdout: string;
	stderr: string;
	exitCode: number;
	success: boolean;
	executionTimeMs: number;
	timedOut?: boolean;
}

export interface K8sSandboxOptions {
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
	/** Lifecycle callbacks */
	onStart?: () => Promise<void>;
	onStop?: () => Promise<void>;
	onDestroy?: () => Promise<void>;
}

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

function shellEscape(input: string): string {
	return `'${input.replace(/'/g, "'\"'\"'")}'`;
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

// ── K8sSandbox Class ──────────────────────────────────────────

export class K8sSandbox {
	readonly id: string;
	readonly name = "K8sSandbox";

	private readonly templateName: string;
	private readonly sandboxNamespace: string;
	private readonly _workingDirectory: string;
	private readonly _timeout: number;
	private readonly _provisionTimeout: number;
	private readonly _onStart?: () => Promise<void>;
	private readonly _onStop?: () => Promise<void>;
	private readonly _onDestroy?: () => Promise<void>;

	private claimName: string | null = null;
	private sandboxName: string | null = null;
	private podName: string | null = null;
	private podIp: string | null = null;
	private loggedImageWarning = false;
	private _destroying = false;

	get workingDirectory(): string {
		return this._workingDirectory;
	}

	/** Get the sandbox pod's cluster IP (null if not yet provisioned). */
	getSandboxPodIp(): string | null {
		return this.podIp;
	}

	/** Structured sandbox metadata for workflow outputs and diagnostics. */
	getDebugInfo(): Record<string, unknown> {
		return {
			id: this.id,
			backend: "k8s",
			templateName: this.templateName,
			namespace: this.sandboxNamespace,
			workingDirectory: this._workingDirectory,
			timeoutMs: this._timeout,
			provisionTimeoutMs: this._provisionTimeout,
			claimName: this.claimName,
			sandboxName: this.sandboxName,
			podName: this.podName,
			podIp: this.podIp,
		};
	}

	constructor(options: K8sSandboxOptions = {}) {
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
		const configuredProvisionTimeout = parseInt(
			process.env.SANDBOX_PROVISION_TIMEOUT_MS || "180000",
			10,
		);
		this._provisionTimeout = options.provisionTimeout
			? options.provisionTimeout
			: Number.isFinite(configuredProvisionTimeout) &&
					configuredProvisionTimeout > 0
				? configuredProvisionTimeout
				: 180_000;
		this._onStart = options.onStart;
		this._onStop = options.onStop;
		this._onDestroy = options.onDestroy;
	}

	// ── Lifecycle ─────────────────────────────────────────────

	async start(): Promise<void> {
		console.log(
			`[k8s-sandbox] Creating SandboxClaim (template=${this.templateName}, namespace=${this.sandboxNamespace})`,
		);

		this.claimName = `durable-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		const claimPath = `/apis/${CLAIM_API_GROUP}/${CLAIM_API_VERSION}/namespaces/${this.sandboxNamespace}/${CLAIM_PLURAL}`;
		await k8sRequest("POST", claimPath, {
			apiVersion: `${CLAIM_API_GROUP}/${CLAIM_API_VERSION}`,
			kind: "SandboxClaim",
			metadata: {
				name: this.claimName,
				namespace: this.sandboxNamespace,
				labels: {
					"app.kubernetes.io/managed-by": "durable-agent",
					"durable-sandbox-id": this.id,
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

		const sandboxName = await this.waitForSandboxReady();
		this.sandboxName = sandboxName;
		const podEndpoint = await this.getPodEndpoint(sandboxName);
		this.podName = podEndpoint.podName;
		this.podIp = podEndpoint.podIp;

		console.log(
			`[k8s-sandbox] Sandbox ready: sandbox=${sandboxName}, pod=${this.podName}, ip=${this.podIp}`,
		);

		await this._onStart?.();
	}

	async stop(): Promise<void> {
		console.log("[k8s-sandbox] Stopping (sandbox pod remains active)");
		await this._onStop?.();
	}

	async destroy(): Promise<void> {
		if (this._destroying) return;
		this._destroying = true;

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
			this.sandboxName = null;
			this.podName = null;
			this.podIp = null;
		}

		await this._onDestroy?.();
	}

	async isReady(): Promise<boolean> {
		return this.podIp !== null;
	}

	// ── Command Execution ─────────────────────────────────────

	async executeCommand(
		command: string,
		args?: string[],
		options?: { timeout?: number; cwd?: string },
	): Promise<CommandResult> {
		if (!this.podIp) {
			throw new Error("K8s sandbox not ready — call start() first");
		}

		const fullCommand =
			args && args.length > 0
				? `${command} ${args.map((arg) => shellEscape(arg)).join(" ")}`
				: command;

		const timeout = options?.timeout ?? this._timeout;
		const cwd = options?.cwd ?? this._workingDirectory;
		const wrappedCommand = `cd ${shellEscape(cwd)} && ${fullCommand}`;

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

	private async waitForSandboxReady(): Promise<string> {
		const start = Date.now();
		const claimPath = `/apis/${CLAIM_API_GROUP}/${CLAIM_API_VERSION}/namespaces/${this.sandboxNamespace}/${CLAIM_PLURAL}/${this.claimName}`;

		while (Date.now() - start < this._provisionTimeout) {
			const claim = await k8sRequest("GET", claimPath);

			const sandboxName = claim.status?.sandbox?.Name;
			if (sandboxName) {
				return sandboxName;
			}

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

			await new Promise((r) => setTimeout(r, 1000));
		}

		throw new Error(
			`SandboxClaim "${this.claimName}" not ready after ${this._provisionTimeout}ms`,
		);
	}

	private async getPodEndpoint(
		sandboxName: string,
	): Promise<{ podName: string; podIp: string }> {
		const start = Date.now();
		while (Date.now() - start < this._provisionTimeout) {
			try {
				const sandboxPath = `/apis/agents.x-k8s.io/v1alpha1/namespaces/${this.sandboxNamespace}/sandboxes/${sandboxName}`;
				const sandboxResource = await k8sRequest("GET", sandboxPath);
				this.warnOnMutableSandboxImage(sandboxResource);

				// Strategy 1: Warm pool — pod name in annotation
				const podName =
					sandboxResource.metadata?.annotations?.["agents.x-k8s.io/pod-name"];
				if (podName) {
					const endpoint = await this.getPodEndpointByName(podName);
					if (endpoint) return endpoint;
				}

				// Strategy 2: Label selector from status
				const selector = sandboxResource.status?.selector;
				if (selector) {
					const endpoint = await this.getPodEndpointBySelector(selector);
					if (endpoint) return endpoint;
				}

				// Strategy 3: Pod named after the sandbox
				{
					const endpoint = await this.getPodEndpointByName(sandboxName);
					if (endpoint) return endpoint;
				}
			} catch {
				// Sandbox or pod may not be ready yet
			}
			await new Promise((r) => setTimeout(r, 1000));
		}

		throw new Error(
			`Could not get IP for sandbox "${sandboxName}" after ${this._provisionTimeout}ms`,
		);
	}

	private warnOnMutableSandboxImage(sandboxResource: any): void {
		if (this.loggedImageWarning) return;
		const image =
			sandboxResource?.spec?.podTemplate?.spec?.containers?.[0]?.image;
		if (!image || typeof image !== "string") return;
		const normalized = image.trim().toLowerCase();
		if (!normalized) return;
		const mutableTag = normalized.endsWith(":latest");
		const hasDigest = normalized.includes("@sha256:");
		if (!mutableTag && hasDigest) return;
		this.loggedImageWarning = true;
		console.warn(
			`[k8s-sandbox] Sandbox image is mutable (${image}). Prefer digest-pinned images for reproducible, secure runs.`,
		);
	}

	private async getPodEndpointByName(
		podName: string,
	): Promise<{ podName: string; podIp: string } | null> {
		try {
			const podPath = `/api/v1/namespaces/${this.sandboxNamespace}/pods/${podName}`;
			const pod = await k8sRequest("GET", podPath);
			const ip = pod.status?.podIP;
			if (ip && pod.status?.phase === "Running") {
				console.log(`[k8s-sandbox] Resolved pod: ${podName} → ${ip}`);
				return { podName, podIp: ip };
			}
		} catch {
			// Pod not found or not ready
		}
		return null;
	}

	private async getPodEndpointBySelector(
		selector: string,
	): Promise<{ podName: string; podIp: string } | null> {
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
					return { podName: name, podIp: ip };
				}
			}
		} catch {
			// List failed
		}
		return null;
	}
}
