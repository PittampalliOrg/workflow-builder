import type { SandboxTemplate, SandboxWarmPool } from "$lib/server/kube/client";
import {
	browserAgentSandboxTemplateName,
	browserAgentSandboxWarmPoolName,
} from "$lib/server/kube/client";
import { AGENT_MODEL_OPTIONS } from "$lib/agents/model-options";

/**
 * Build the upstream `agents.x-k8s.io` Sandbox primitives that back
 * browser/Playwright agents. Pod shape: an OpenShell mTLS gateway init
 * container, a dapr-agent-py main container with the standard env, and
 * (when Playwright MCP is in use) chromium + playwright-mcp sidecars
 * wired CDP-on-localhost:9222 → MCP-on-localhost:3100. The existing
 * `openshell-sandbox-dapr-webhook` matches the
 * `agents.x-k8s.io/role=agent-runtime` label and injects daprd, so no
 * Dapr config is set here directly.
 *
 * The BFF's Service helper (`upsertAgentRuntimeService`) emits a per-slug
 * ClusterIP Service whose selector matches the labels we stamp on the pod
 * template here (`agents.x-k8s.io/role: agent-runtime` +
 * `agents.x-k8s.io/slug: <slug>`).
 */

const DEFAULT_LLM_COMPONENT = "llm-anthropic-opus";

const DEFAULT_BROWSER_USE_IMAGE =
	"gitea-ryzen.tail286401.ts.net/giteaadmin/browser-use-agent-sandbox:latest";
const DEFAULT_AGENT_IMAGE =
	"gitea-ryzen.tail286401.ts.net/giteaadmin/dapr-agent-py-sandbox:latest";

const DEFAULT_CHROME_IMAGE = "ghcr.io/pittampalliorg/chrome-sandbox:latest";
const DEFAULT_PW_MCP_IMAGE =
	"ghcr.io/pittampalliorg/playwright-mcp-gateway:latest";

const DEFAULT_PULL_SECRETS = [
	"workflow-builder-pull-credentials",
	"workflow-builder-ghcr-pull-credentials",
	"ghcr-pull-credentials",
];

const DEFAULT_SERVICE_ACCOUNT = "agent-runtime";
const DEFAULT_OPENSHELL_GATEWAY_NAME = "ryzen-internal";

const OPENSHELL_SEED_SCRIPT = `set -eu
CONFIG_ROOT="\${XDG_CONFIG_HOME}/openshell"
GATEWAY_DIR="\${CONFIG_ROOT}/gateways/\${OPENSHELL_GATEWAY_NAME}"
MTLS_DIR="\${GATEWAY_DIR}/mtls"
install -d -m 700 "\${MTLS_DIR}"
cat >"\${GATEWAY_DIR}/metadata.json" <<EOF
{
  "name": "\${OPENSHELL_GATEWAY_NAME}",
  "gateway_endpoint": "\${OPENSHELL_GATEWAY_URL}",
  "is_remote": false,
  "gateway_port": \${OPENSHELL_GATEWAY_PORT},
  "auth_mode": "mtls"
}
EOF
printf '%s\\n' "\${OPENSHELL_GATEWAY_NAME}" > "\${CONFIG_ROOT}/active_gateway"
cp /etc/openshell-tls/client/tls.crt "\${MTLS_DIR}/tls.crt"
cp /etc/openshell-tls/client/tls.key "\${MTLS_DIR}/tls.key"
if [ -f /etc/openshell-tls/client/ca.crt ]; then
  cp /etc/openshell-tls/client/ca.crt "\${MTLS_DIR}/ca.crt"
else
  cp /etc/openshell-tls/client-ca/tls.crt "\${MTLS_DIR}/ca.crt"
fi
chmod 644 "\${MTLS_DIR}/ca.crt" "\${MTLS_DIR}/tls.crt"
chmod 600 "\${MTLS_DIR}/tls.key"
`;

function resolveLlmComponent(modelSpec: string | null | undefined): string {
	if (!modelSpec) return DEFAULT_LLM_COMPONENT;
	const trimmed = modelSpec.trim();
	if (!trimmed) return DEFAULT_LLM_COMPONENT;
	const match = AGENT_MODEL_OPTIONS.find((o) => o.value === trimmed);
	return match?.component ?? DEFAULT_LLM_COMPONENT;
}

export type BuildBrowserSandboxTemplateInput = {
	agentSlug: string;
	appId: string;
	runtimeClass: string;
	runtimeIsolation: "shared" | "dedicated";
	namespace: string;
	imageTag?: string | null;
	modelSpec?: string | null;
	mcpServers?: unknown[];
	useBrowserSidecar: boolean;
	imagePullSecrets?: string[];
	serviceAccountName?: string;
	openshellGatewayName?: string;
};

export function buildBrowserSandboxTemplate(
	input: BuildBrowserSandboxTemplateInput,
): SandboxTemplate {
	const image =
		input.imageTag?.trim() ||
		(input.useBrowserSidecar ? DEFAULT_BROWSER_USE_IMAGE : DEFAULT_AGENT_IMAGE);
	const llmComponent = resolveLlmComponent(input.modelSpec);
	const isBrowserUseImage = image.includes("browser-use-agent");

	// browser-use runtime pods OOMKill on 1Gi; mirror the controller's
	// generous-memory default so the new pods don't regress.
	const resources = isBrowserUseImage
		? {
				requests: { memory: "128Mi", cpu: "75m" },
				limits: { memory: "2Gi", cpu: "1000m" },
			}
		: {
				requests: { memory: "512Mi", cpu: "250m" },
				limits: { memory: "2Gi", cpu: "1500m" },
			};

	const pullSecrets = (input.imagePullSecrets ?? DEFAULT_PULL_SECRETS).map(
		(name) => ({ name }),
	);
	const serviceAccountName =
		input.serviceAccountName ?? DEFAULT_SERVICE_ACCOUNT;
	const gatewayName =
		input.openshellGatewayName ?? DEFAULT_OPENSHELL_GATEWAY_NAME;

	const podLabels: Record<string, string> = {
		// `app` matches the Service selector on the legacy Deployment-managed
		// path. We keep emitting it so an in-flight migration with both old
		// and new resources running side-by-side resolves Service endpoints
		// uniformly.
		app: browserAgentSandboxTemplateName(input.agentSlug),
		"agents.x-k8s.io/role": "agent-runtime",
		"agents.x-k8s.io/slug": input.agentSlug,
		"agents.x-k8s.io/app-id": input.appId,
		"agents.x-k8s.io/runtime-class": input.runtimeClass,
		"agents.x-k8s.io/runtime-isolation": input.runtimeIsolation,
	};

	const podAnnotations: Record<string, string> = {
		// daprd injection is performed by the openshell-sandbox-dapr-webhook
		// based on the role label; we still stamp dapr.io/* annotations so
		// the webhook resolves to the correct app-id without scanning the CR.
		"dapr.io/enabled": "true",
		"dapr.io/app-id": input.appId,
		"dapr.io/app-port": "8002",
		"dapr.io/app-protocol": "http",
		"dapr.io/config": "workflow-builder-agent-runtime",
		"dapr.io/enable-workflow": "true",
		"dapr.io/enable-native-sidecar": "true",
		"dapr.io/placement-host-address":
			"dapr-placement-server.dapr-system.svc.cluster.local:50005",
		"dapr.io/max-body-size": "16Mi",
		"dapr.io/graceful-shutdown-seconds": "60",
		"dapr.io/sidecar-readiness-probe-delay-seconds": "0",
		"dapr.io/sidecar-readiness-probe-period-seconds": "1",
		"dapr.io/sidecar-readiness-probe-timeout-seconds": "1",
		"agents.x-k8s.io/app-id": input.appId,
		"agents.x-k8s.io/effective-llm-component": llmComponent,
	};

	const bootstrapMcpJson = JSON.stringify(input.mcpServers ?? []);

	const seedInitContainer: Record<string, unknown> = {
		name: "seed-openshell-config",
		image,
		imagePullPolicy: "IfNotPresent",
		command: ["sh", "-c"],
		args: [OPENSHELL_SEED_SCRIPT],
		env: [
			{ name: "XDG_CONFIG_HOME", value: "/root/.config" },
			{
				name: "OPENSHELL_GATEWAY_URL",
				value: "https://openshell.openshell.svc.cluster.local:8080",
			},
			{ name: "OPENSHELL_GATEWAY_NAME", value: gatewayName },
			{ name: "OPENSHELL_GATEWAY_PORT", value: "8080" },
		],
		volumeMounts: [
			{ name: "openshell-config", mountPath: "/root/.config" },
			{
				name: "openshell-client-tls",
				mountPath: "/etc/openshell-tls/client",
				readOnly: true,
			},
			{
				name: "openshell-client-ca",
				mountPath: "/etc/openshell-tls/client-ca",
				readOnly: true,
			},
		],
	};

	const daprAgentEnv: Record<string, unknown>[] = [
		{ name: "AGENT_SERVICE_NAME", value: input.appId },
		// browser-use spans go to a dedicated OTEL service so Phoenix can
		// slice spans by runtime-class; non-browser pods inherit
		// OTEL_SERVICE_NAME from the dapr-agent-py-config ConfigMap.
		...(isBrowserUseImage
			? [{ name: "OTEL_SERVICE_NAME", value: "browser-use-agent" }]
			: []),
		{ name: "XDG_CONFIG_HOME", value: "/root/.config" },
		{ name: "DAPR_LLM_COMPONENT_DEFAULT", value: llmComponent },
		{ name: "DAPR_AGENT_PY_HOOKS_ENABLED", value: "true" },
		{ name: "DAPR_AGENT_PY_PLUGINS_ENABLED", value: "true" },
		{
			name: "DAPR_AGENT_PY_PLUGIN_PATHS",
			value: "/etc/dapr-agent-py/plugins",
		},
		{
			name: "DAPR_AGENT_PY_BOOTSTRAP_MCP_SERVERS_JSON",
			value: bootstrapMcpJson,
		},
		{ name: "AGENT_CALL_AGENT_NATIVE", value: "1" },
		{ name: "AGENT_SLUG", value: input.agentSlug },
		{
			name: "WORKFLOW_BUILDER_URL",
			value: "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
		},
	];

	const daprAgentContainer: Record<string, unknown> = {
		name: "dapr-agent-py",
		image,
		imagePullPolicy: "Always",
		ports: [{ name: "http", containerPort: 8002 }],
		env: daprAgentEnv,
		envFrom: [
			{ configMapRef: { name: "dapr-agent-py-config", optional: true } },
			{ secretRef: { name: "dapr-agent-py-secrets", optional: true } },
			{ secretRef: { name: "workflow-checkpoint-gitea", optional: true } },
		],
		volumeMounts: [{ name: "openshell-config", mountPath: "/root/.config" }],
		resources,
		startupProbe: {
			httpGet: { path: "/healthz", port: 8002 },
			initialDelaySeconds: 5,
			periodSeconds: 5,
			failureThreshold: 30,
		},
		livenessProbe: {
			httpGet: { path: "/healthz", port: 8002 },
			periodSeconds: 30,
			timeoutSeconds: 5,
			failureThreshold: 6,
		},
		readinessProbe: {
			httpGet: { path: "/readyz", port: 8002 },
			periodSeconds: 5,
			timeoutSeconds: 3,
			failureThreshold: 6,
		},
	};

	const browserContainers: Record<string, unknown>[] = [];
	const browserVolumes: Record<string, unknown>[] = [];
	if (input.useBrowserSidecar) {
		browserContainers.push(
			{
				name: "chromium",
				image: DEFAULT_CHROME_IMAGE,
				imagePullPolicy: "Always",
				env: [{ name: "CHROME_CDP_HOST_REWRITE", value: "false" }],
				resources: {
					requests: { memory: "64Mi", cpu: "50m" },
					limits: { memory: "2Gi", cpu: "2000m" },
				},
				volumeMounts: [{ name: "dshm", mountPath: "/dev/shm" }],
			},
			{
				name: "playwright-mcp",
				image: DEFAULT_PW_MCP_IMAGE,
				imagePullPolicy: "Always",
				args: [
					"--port",
					"3100",
					"--host",
					"0.0.0.0",
					"--allowed-hosts",
					"*",
					"--output-dir",
					"/tmp/playwright-mcp-output",
					"--cdp-endpoint",
					"http://localhost:9222",
				],
				ports: [{ name: "mcp", containerPort: 3100 }],
				resources: {
					requests: { memory: "32Mi", cpu: "10m" },
					limits: { memory: "512Mi", cpu: "500m" },
				},
				readinessProbe: {
					tcpSocket: { port: 3100 },
					initialDelaySeconds: 3,
					periodSeconds: 5,
				},
			},
		);
		browserVolumes.push({
			name: "dshm",
			emptyDir: { medium: "Memory", sizeLimit: "1Gi" },
		});
	}

	const podSpec: Record<string, unknown> = {
		serviceAccountName,
		terminationGracePeriodSeconds: 60,
		// daprd's secretstores.kubernetes initializer uses
		// rest.InClusterConfig() (probes the projected SA token at
		// /var/run/secrets/kubernetes.io/serviceaccount/token). The upstream
		// agent-sandbox controller defaults pods to
		// `automountServiceAccountToken: false` for sandbox hardening; that
		// breaks daprd init because it falls back to ~/.kube/config which
		// doesn't exist. Explicitly opt back in — the daprd sidecar lives in
		// the same pod and *needs* API access to load Components like
		// kubernetes-secrets. Arc-1's per-session Sandbox path
		// (sandbox-execution-api) already works because it leaves this field
		// unset and inherits the K8s default `true`; the SandboxWarmPool /
		// SandboxTemplate path explicitly stamps false from the controller,
		// so we have to override.
		automountServiceAccountToken: true,
		imagePullSecrets: pullSecrets,
		topologySpreadConstraints: [
			{
				maxSkew: 1,
				topologyKey: "kubernetes.io/hostname",
				whenUnsatisfiable: "ScheduleAnyway",
				labelSelector: {
					matchLabels: { "agents.x-k8s.io/role": "agent-runtime" },
				},
			},
		],
		initContainers: [seedInitContainer],
		containers: [daprAgentContainer, ...browserContainers],
		volumes: [
			{ name: "openshell-config", emptyDir: {} },
			{
				name: "openshell-client-tls",
				secret: { defaultMode: 256, secretName: "openshell-client-tls" },
			},
			{
				name: "openshell-client-ca",
				secret: {
					defaultMode: 292,
					secretName: "openshell-server-client-ca",
				},
			},
			...browserVolumes,
		],
	};

	return {
		apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
		kind: "SandboxTemplate",
		metadata: {
			name: browserAgentSandboxTemplateName(input.agentSlug),
			namespace: input.namespace,
			labels: {
				"agents.x-k8s.io/role": "agent-runtime",
				"agents.x-k8s.io/slug": input.agentSlug,
				"agents.x-k8s.io/runtime-class": input.runtimeClass,
				"agents.x-k8s.io/runtime-isolation": input.runtimeIsolation,
			},
		},
		spec: {
			// `Unmanaged` lets the existing NetworkPolicies/firewall rules
			// (defined in stacks/openshell) govern egress from these pods.
			// The upstream `Managed` mode auto-creates one NetworkPolicy per
			// claimed Sandbox which we don't need.
			networkPolicyManagement: "Unmanaged",
			podTemplate: {
				metadata: {
					labels: podLabels,
					annotations: podAnnotations,
				},
				spec: podSpec,
			},
		},
	};
}

export function buildBrowserSandboxWarmPool(input: {
	agentSlug: string;
	namespace: string;
	replicas?: number;
}): SandboxWarmPool {
	const name = browserAgentSandboxWarmPoolName(input.agentSlug);
	const templateName = browserAgentSandboxTemplateName(input.agentSlug);
	return {
		apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
		kind: "SandboxWarmPool",
		metadata: {
			name,
			namespace: input.namespace,
			labels: {
				"agents.x-k8s.io/role": "agent-runtime",
				"agents.x-k8s.io/slug": input.agentSlug,
			},
		},
		spec: {
			// Default scale-to-zero. Wake-on-demand patches replicas=1 via
			// `wakeSandboxWarmPool`; the idle reaper resets to 0 after the
			// configured idle TTL elapses with no recent session activity.
			replicas: input.replicas ?? 0,
			sandboxTemplateRef: { name: templateName },
		},
	};
}
