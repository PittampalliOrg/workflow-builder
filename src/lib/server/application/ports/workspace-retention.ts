import type { WorkspaceRetentionIdentity } from "$lib/server/lifecycle/resolvers";

export type { WorkspaceRetentionIdentity } from "$lib/server/lifecycle/resolvers";

export type ArmWorkspaceRetentionInput = {
  identity: WorkspaceRetentionIdentity;
  terminalAt: Date;
};

export type WorkspaceRetentionAcknowledgement = {
  terminalAt: string | null;
  resultCount: number;
};

/** Provider boundary for arming a retained workspace's first terminal TTL. */
export interface WorkspaceRetentionPort {
  armTerminalRetention(
    input: ArmWorkspaceRetentionInput,
  ): Promise<WorkspaceRetentionAcknowledgement>;
}
