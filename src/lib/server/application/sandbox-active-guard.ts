export type SandboxActiveGuard = {
	active: boolean;
	scope: { projectId: string | null; userId: string } | null;
};

export interface SandboxActiveSessionGuardPort {
	activeSessionForSandboxName(name: string): Promise<SandboxActiveGuard>;
}

export class ApplicationSandboxActiveGuardService {
	constructor(private readonly guard: SandboxActiveSessionGuardPort) {}

	activeSessionForSandboxName(name: string) {
		return this.guard.activeSessionForSandboxName(name);
	}
}
