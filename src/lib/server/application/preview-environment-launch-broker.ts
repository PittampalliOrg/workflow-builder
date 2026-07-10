import type {
  PreviewControlAdminAuthorizationPort,
  PreviewEnvironmentUserLaunchInput,
  PreviewEnvironmentUserLaunchPort,
} from "$lib/server/application/ports";

export class PreviewEnvironmentLaunchAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewEnvironmentLaunchAuthorizationError";
  }
}

/** Physical broker guard in front of revision resolution and capability minting. */
export class ApplicationPreviewEnvironmentLaunchBrokerService implements PreviewEnvironmentUserLaunchPort {
  constructor(
    private readonly deps: Readonly<{
      admins: PreviewControlAdminAuthorizationPort;
      environments: PreviewEnvironmentUserLaunchPort;
    }>,
  ) {}

  previewNativeServices(): readonly string[] {
    return this.deps.environments.previewNativeServices();
  }

  async launchForUser(input: PreviewEnvironmentUserLaunchInput) {
    if (!(await this.deps.admins.isPlatformAdmin(input.userId))) {
      throw new PreviewEnvironmentLaunchAuthorizationError(
        "platform admin approval is required for preview launch",
      );
    }
    if (
      (input.profile !== undefined && input.profile !== "app-live") ||
      (input.lane !== undefined && input.lane !== "application") ||
      (input.candidatePaths?.length ?? 0) > 0 ||
      (input.allocation !== undefined && input.allocation.kind !== "cold")
    ) {
      throw new PreviewEnvironmentLaunchAuthorizationError(
        "app-live launch broker accepts only the application cold lane",
      );
    }
    return this.deps.environments.launchForUser({
      ...input,
      profile: "app-live",
      lane: "application",
      allocation: { kind: "cold" },
      candidatePaths: [],
    });
  }
}
