export const SANDBOX_POLICY_MODES = [
	'shared-runtime',
	'per-run',
	'per-node',
	'provided'
] as const;

export type SandboxPolicyMode = (typeof SANDBOX_POLICY_MODES)[number];

export interface SandboxPolicy {
	mode: SandboxPolicyMode;
	template: string;
	keepAfterRun: boolean;
	ttlSeconds?: number;
	workspaceRef?: string;
}

export const WORKFLOW_BUILDER_SANDBOX_POLICY_KEY = 'x-workflow-builder';
export const MANAGED_WORKSPACE_MARKER = 'workflow-builder:sandbox-policy';
export const DEFAULT_SANDBOX_TEMPLATE = 'dapr-agent';
export const DEFAULT_SANDBOX_TTL_SECONDS = 7200;
export const DEFAULT_WORKSPACE_ROOT = '/sandbox';
export const DEFAULT_WORKSPACE_COMMAND_TIMEOUT_MS = 900000;
export const DEFAULT_WORKSPACE_TIMEOUT_MS = 1200000;
export const DEFAULT_WORKSPACE_TOOLS = [
	'execute_command',
	'read_file',
	'write_file',
	'edit_file',
	'list_files',
	'mkdir',
	'file_stat'
];

export const DEFAULT_NEW_AGENT_SANDBOX_POLICY: SandboxPolicy = {
	mode: 'per-run',
	template: DEFAULT_SANDBOX_TEMPLATE,
	keepAfterRun: false,
	ttlSeconds: DEFAULT_SANDBOX_TTL_SECONDS
};

export const LEGACY_SHARED_SANDBOX_POLICY: SandboxPolicy = {
	mode: 'shared-runtime',
	template: DEFAULT_SANDBOX_TEMPLATE,
	keepAfterRun: false,
	ttlSeconds: DEFAULT_SANDBOX_TTL_SECONDS
};

type Spec = Record<string, unknown>;
type TaskDef = Record<string, unknown>;
type DoEntry = Record<string, TaskDef>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
		if (['false', '0', 'no', 'off'].includes(normalized)) return false;
	}
	return fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return fallback;
}

function normalizeMode(value: unknown, fallback: SandboxPolicyMode): SandboxPolicyMode {
	return typeof value === 'string' &&
		(SANDBOX_POLICY_MODES as readonly string[]).includes(value)
		? (value as SandboxPolicyMode)
		: fallback;
}

export function normalizeSandboxPolicy(
	value: unknown,
	fallback: SandboxPolicy = LEGACY_SHARED_SANDBOX_POLICY
): SandboxPolicy {
	const record = isRecord(value) ? value : {};
	const mode = normalizeMode(record.mode, fallback.mode);
	const keepAfterRun = booleanValue(record.keepAfterRun, fallback.keepAfterRun);
	const policy: SandboxPolicy = {
		mode,
		template: stringValue(record.template) ?? fallback.template ?? DEFAULT_SANDBOX_TEMPLATE,
		keepAfterRun,
		ttlSeconds: keepAfterRun
			? positiveInteger(record.ttlSeconds, fallback.ttlSeconds ?? DEFAULT_SANDBOX_TTL_SECONDS)
			: positiveInteger(record.ttlSeconds, fallback.ttlSeconds ?? DEFAULT_SANDBOX_TTL_SECONDS)
	};
	const workspaceRef = stringValue(record.workspaceRef);
	if (workspaceRef) policy.workspaceRef = workspaceRef;
	return policy;
}

export function hasExplicitSandboxPolicy(value: unknown): boolean {
	return isRecord(value) && typeof value.mode === 'string';
}

export function getDocumentSandboxPolicy(spec: Spec): SandboxPolicy | undefined {
	const doc = isRecord(spec.document) ? spec.document : {};
	const extension = isRecord(doc[WORKFLOW_BUILDER_SANDBOX_POLICY_KEY])
		? doc[WORKFLOW_BUILDER_SANDBOX_POLICY_KEY]
		: {};
	if (!isRecord(extension.sandboxPolicy)) return undefined;
	return normalizeSandboxPolicy(extension.sandboxPolicy, DEFAULT_NEW_AGENT_SANDBOX_POLICY);
}

export function withDocumentSandboxPolicy(spec: Spec, policy: SandboxPolicy): Spec {
	const doc = isRecord(spec.document) ? spec.document : {};
	const extension = isRecord(doc[WORKFLOW_BUILDER_SANDBOX_POLICY_KEY])
		? doc[WORKFLOW_BUILDER_SANDBOX_POLICY_KEY]
		: {};
	return {
		...spec,
		document: {
			...doc,
			[WORKFLOW_BUILDER_SANDBOX_POLICY_KEY]: {
				...extension,
				sandboxPolicy: normalizeSandboxPolicy(policy, DEFAULT_NEW_AGENT_SANDBOX_POLICY)
			}
		}
	};
}

function getDoArray(spec: Spec): DoEntry[] {
	return Array.isArray(spec.do) ? (spec.do as DoEntry[]) : [];
}

function taskName(entry: DoEntry): string {
	return Object.keys(entry)[0] ?? '';
}

function isManagedWorkspaceProfile(entry: DoEntry): boolean {
	const name = taskName(entry);
	const task = name ? entry[name] : null;
	if (!isRecord(task) || task.call !== 'workspace/profile') return false;
	const withBlock = isRecord(task.with) ? task.with : {};
	return withBlock.managedBy === MANAGED_WORKSPACE_MARKER;
}

function isDurableRun(task: unknown): task is TaskDef {
	return isRecord(task) && task.call === 'durable/run';
}

function sanitizeTaskName(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9_-]/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 64) || 'task'
	);
}

function uniqueTaskName(base: string, existing: Set<string>): string {
	const sanitized = sanitizeTaskName(base).replace(/-/g, '_');
	if (!existing.has(sanitized)) {
		existing.add(sanitized);
		return sanitized;
	}
	let index = 2;
	while (existing.has(`${sanitized}_${index}`)) index += 1;
	const next = `${sanitized}_${index}`;
	existing.add(next);
	return next;
}

function documentName(spec: Spec): string {
	const doc = isRecord(spec.document) ? spec.document : {};
	return stringValue(doc.name) ?? stringValue(doc.title) ?? 'workflow';
}

function workspaceProfileTask(name: string, policy: SandboxPolicy): TaskDef {
	const withBlock: Record<string, unknown> = {
		name,
		rootPath: DEFAULT_WORKSPACE_ROOT,
		enabledTools: DEFAULT_WORKSPACE_TOOLS,
		timeoutMs: DEFAULT_WORKSPACE_TIMEOUT_MS,
		commandTimeoutMs: DEFAULT_WORKSPACE_COMMAND_TIMEOUT_MS,
		sandboxTemplate: policy.template || DEFAULT_SANDBOX_TEMPLATE,
		keepAfterRun: policy.keepAfterRun,
		managedBy: MANAGED_WORKSPACE_MARKER,
		sandboxPolicy: policy
	};
	if (policy.keepAfterRun && policy.ttlSeconds) {
		withBlock.ttlSeconds = policy.ttlSeconds;
	}
	return {
		call: 'workspace/profile',
		with: withBlock
	};
}

function perNodeWorkspaceProfileTask(name: string, policy: SandboxPolicy): TaskDef {
	const task = workspaceProfileTask(name, policy);
	const withBlock = isRecord(task.with) ? task.with : {};
	return {
		...task,
		with: {
			...withBlock,
			reuseExecutionWorkspace: false
		}
	};
}

function updateDurableTaskForPolicy(
	task: TaskDef,
	policy: SandboxPolicy,
	workspaceRef?: string
): TaskDef {
	const next = clone(task);
	const withBlock = isRecord(next.with) ? { ...next.with } : {};
	const body = isRecord(withBlock.body) ? { ...withBlock.body } : {};
	withBlock.sandboxPolicy = policy;
	body.sandboxPolicy = policy;

	if (policy.mode === 'provided') {
		const ref = policy.workspaceRef ?? stringValue(withBlock.workspaceRef) ?? stringValue(body.workspaceRef);
		if (ref) {
			withBlock.workspaceRef = ref;
			body.workspaceRef = ref;
		}
		withBlock.cleanupWorkspace = false;
		body.cleanupWorkspace = false;
	} else if (policy.mode === 'per-run' || policy.mode === 'per-node') {
		if (workspaceRef) {
			withBlock.workspaceRef = workspaceRef;
			body.workspaceRef = workspaceRef;
		}
		withBlock.cleanupWorkspace = false;
		body.cleanupWorkspace = false;
	} else {
		if (
			typeof withBlock.workspaceRef === 'string' &&
			withBlock.workspaceRef.includes('.workspaceRef')
		) {
			delete withBlock.workspaceRef;
		}
		if (typeof body.workspaceRef === 'string' && body.workspaceRef.includes('.workspaceRef')) {
			delete body.workspaceRef;
		}
		delete withBlock.cleanupWorkspace;
		delete body.cleanupWorkspace;
	}

	withBlock.body = body;
	return {
		...next,
		with: withBlock
	};
}

function policyForTask(task: TaskDef, documentPolicy: SandboxPolicy | undefined): SandboxPolicy | undefined {
	const withBlock = isRecord(task.with) ? task.with : {};
	const body = isRecord(withBlock.body) ? withBlock.body : {};
	if (hasExplicitSandboxPolicy(withBlock.sandboxPolicy)) {
		return normalizeSandboxPolicy(withBlock.sandboxPolicy, DEFAULT_NEW_AGENT_SANDBOX_POLICY);
	}
	if (hasExplicitSandboxPolicy(body.sandboxPolicy)) {
		return normalizeSandboxPolicy(body.sandboxPolicy, DEFAULT_NEW_AGENT_SANDBOX_POLICY);
	}
	return documentPolicy;
}

export function compileSandboxPolicies(spec: Spec): Spec {
	const originalDo = getDoArray(spec);
	const documentPolicy = getDocumentSandboxPolicy(spec);
	const filtered = originalDo.filter((entry) => !isManagedWorkspaceProfile(entry));
	const existingNames = new Set(filtered.map(taskName).filter(Boolean));
	const perRunPolicies = new Map<string, { name: string; policy: SandboxPolicy }>();
	const insertedPerRunWorkspaces = new Set<string>();
	const output: DoEntry[] = [];

	for (const entry of filtered) {
		const name = taskName(entry);
		const task = name ? entry[name] : null;
		if (!name || !isDurableRun(task)) {
			output.push(entry);
			continue;
		}

		const policy = policyForTask(task, documentPolicy);
		if (!policy) {
			output.push(entry);
			continue;
		}
		if (policy.mode === 'shared-runtime') {
			output.push({ [name]: updateDurableTaskForPolicy(task, policy) });
			continue;
		}

		if (policy.mode === 'provided') {
			output.push({ [name]: updateDurableTaskForPolicy(task, policy) });
			continue;
		}

		if (policy.mode === 'per-node') {
			const workspaceName = uniqueTaskName(`${name}_workspace`, existingNames);
			output.push({ [workspaceName]: perNodeWorkspaceProfileTask(workspaceName, policy) });
			output.push({
				[name]: updateDurableTaskForPolicy(task, policy, `\${ .${workspaceName}.workspaceRef }`)
			});
			continue;
		}

		const key = `${policy.template}:${policy.keepAfterRun}:${policy.ttlSeconds ?? ''}`;
		let workspace = perRunPolicies.get(key);
		if (!workspace) {
			const workspaceName = uniqueTaskName('workspace_profile', existingNames);
			workspace = { name: workspaceName, policy };
			perRunPolicies.set(key, workspace);
		}
		if (!insertedPerRunWorkspaces.has(workspace.name)) {
			output.push({ [workspace.name]: workspaceProfileTask(workspace.name, workspace.policy) });
			insertedPerRunWorkspaces.add(workspace.name);
		}
		output.push({
			[name]: updateDurableTaskForPolicy(task, policy, `\${ .${workspace.name}.workspaceRef }`)
		});
	}

	return { ...spec, do: output };
}
