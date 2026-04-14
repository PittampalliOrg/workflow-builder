export type SandboxType = 'openshell' | 'k8s-crd' | 'agent-runtime';
export type SandboxPhase = 'PROVISIONING' | 'READY' | 'ERROR' | 'DELETING' | 'UNKNOWN';

export interface Sandbox {
	name: string;
	type: SandboxType;
	phase: SandboxPhase;
	image?: string;
	provider?: string;
	createdAt?: string;
	conditions?: Array<{ type: string; status: string; message?: string }>;
	runtime?: {
		runtimeId: string;
		appId: string;
		namespace: string;
		serviceName: string;
		serviceUrl: string;
		stateStore: string;
		description: string;
		tools: string[];
		health?: Record<string, unknown> | null;
	};
}

export interface SandboxLogEntry {
	level: string;
	source: string;
	message: string;
	timestamp: string;
	eventType?: string;
	fields?: Record<string, unknown>;
}

export interface SandboxEvent {
	reason: string;
	message: string;
	source: string;
	timestamp: string;
	type?: string;
	metadata?: Record<string, unknown>;
}

export interface SandboxExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}
