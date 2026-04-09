export type SandboxType = 'openshell' | 'k8s-crd';
export type SandboxPhase = 'PROVISIONING' | 'READY' | 'ERROR' | 'DELETING' | 'UNKNOWN';

export interface Sandbox {
	name: string;
	type: SandboxType;
	phase: SandboxPhase;
	image?: string;
	provider?: string;
	createdAt?: string;
	conditions?: Array<{ type: string; status: string; message?: string }>;
}

export interface SandboxLogEntry {
	level: string;
	source: string;
	message: string;
	timestamp: string;
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
