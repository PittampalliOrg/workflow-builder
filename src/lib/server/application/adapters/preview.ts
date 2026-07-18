import type {
  DevPreviewInfo,
  DevPreviewSourceFreezeResult,
  DevPreviewSourcesFreezeOutcome,
  DevPreviewsResult,
  FreezeDevPreviewSourcesParams,
  ProvisionDevPreviewParams,
  ProvisionDevPreviewsParams,
  PreviewDevSyncCredentialBrokerPort,
  PreviewDatabaseProvisioner,
  PreviewEnvironmentProvisioner,
  ReleaseDevPreviewSandboxesParams,
  ReleaseDevPreviewSandboxesResult,
  ReplaceDevPreviewImagesParams,
  ReplaceDevPreviewImagesResult,
  RetainedFreezeDevPreviewSourcesParams,
  TeardownDevPreviewParams,
  TeardownDevPreviewResult,
} from "$lib/server/application/ports";
import { HttpPreviewDevSyncCredentialBrokerAdapter } from "$lib/server/application/adapters/preview-dev-sync-credentials";
import {
  provisionDevPreview,
  provisionDevPreviews,
  freezeDevPreviewSources,
  freezeDevPreviewSourcesForTeardown,
  releaseDevPreviewSandboxes,
  replaceDevPreviewImages,
  type DevPreviewPersistence,
  teardownDevPreview,
} from "$lib/server/workflows/dev-preview";

export class SandboxExecutionPreviewEnvironmentProvisioner implements PreviewEnvironmentProvisioner {
  constructor(
    private readonly persistence?: () => DevPreviewPersistence,
    private readonly previewDatabases?: PreviewDatabaseProvisioner,
    private readonly credentialBroker: PreviewDevSyncCredentialBrokerPort = new HttpPreviewDevSyncCredentialBrokerAdapter(),
  ) {}

  provision(input: ProvisionDevPreviewParams): Promise<DevPreviewInfo> {
    return provisionDevPreview(
      input,
      this.persistence?.(),
      this.previewDatabases,
      {
        broker: this.credentialBroker,
      },
    );
  }

  provisionMany(input: ProvisionDevPreviewsParams): Promise<DevPreviewsResult> {
    return provisionDevPreviews(
      input,
      this.persistence?.(),
      this.previewDatabases,
      {
        broker: this.credentialBroker,
      },
    );
  }

  replaceMany(
    input: ReplaceDevPreviewImagesParams,
  ): Promise<ReplaceDevPreviewImagesResult> {
    return replaceDevPreviewImages(
      input,
      this.persistence?.(),
      this.previewDatabases,
      {
        broker: this.credentialBroker,
      },
    );
  }

  freezeSourcesForTeardown(
    input: FreezeDevPreviewSourcesParams,
  ): Promise<DevPreviewSourceFreezeResult> {
    return freezeDevPreviewSourcesForTeardown(
      input,
      this.persistence?.(),
      { broker: this.credentialBroker },
    );
  }

  freezeSources(
    input: RetainedFreezeDevPreviewSourcesParams,
  ): Promise<DevPreviewSourcesFreezeOutcome> {
    return freezeDevPreviewSources(
      input,
      this.persistence?.(),
      { broker: this.credentialBroker },
    );
  }

  releaseSandboxes(
    input: ReleaseDevPreviewSandboxesParams,
  ): Promise<ReleaseDevPreviewSandboxesResult> {
    return releaseDevPreviewSandboxes(input, this.persistence?.());
  }

  teardown(input: TeardownDevPreviewParams): Promise<TeardownDevPreviewResult> {
    return teardownDevPreview(
      input,
      this.persistence?.(),
      this.previewDatabases,
      {
        broker: this.credentialBroker,
      },
    );
  }
}

export class KroPreviewEnvironmentProvisioner implements PreviewEnvironmentProvisioner {
  async provision(_input: ProvisionDevPreviewParams): Promise<DevPreviewInfo> {
    throw new Error(
      "PREVIEW_PROVISIONER_ADAPTER=kro is available for packaging pilots, but runtime WorkflowBuilderPreviewEnvironment instance creation is not wired in the BFF yet",
    );
  }

  async provisionMany(
    _input: ProvisionDevPreviewsParams,
  ): Promise<DevPreviewsResult> {
    throw new Error(
      "PREVIEW_PROVISIONER_ADAPTER=kro is available for packaging pilots, but runtime WorkflowBuilderPreviewEnvironment instance creation is not wired in the BFF yet",
    );
  }

  async replaceMany(
    _input: ReplaceDevPreviewImagesParams,
  ): Promise<ReplaceDevPreviewImagesResult> {
    throw new Error(
      "PREVIEW_PROVISIONER_ADAPTER=kro is available for packaging pilots, but atomic WorkflowBuilderPreviewEnvironment image replacement is not wired in the BFF yet",
    );
  }

  async freezeSourcesForTeardown(
    _input: FreezeDevPreviewSourcesParams,
  ): Promise<DevPreviewSourceFreezeResult> {
    throw new Error(
      "PREVIEW_PROVISIONER_ADAPTER=kro is available for packaging pilots, but source freeze is not wired in the BFF yet",
    );
  }

  async freezeSources(
    _input: RetainedFreezeDevPreviewSourcesParams,
  ): Promise<DevPreviewSourcesFreezeOutcome> {
    throw new Error(
      "PREVIEW_PROVISIONER_ADAPTER=kro is available for packaging pilots, but retained-source freeze is not wired in the BFF yet",
    );
  }

  async releaseSandboxes(
    _input: ReleaseDevPreviewSandboxesParams,
  ): Promise<ReleaseDevPreviewSandboxesResult> {
    throw new Error(
      "PREVIEW_PROVISIONER_ADAPTER=kro is available for packaging pilots, but retained-sandbox release is not wired in the BFF yet",
    );
  }

  async teardown(
    _input: TeardownDevPreviewParams,
  ): Promise<TeardownDevPreviewResult> {
    throw new Error(
      "PREVIEW_PROVISIONER_ADAPTER=kro is available for packaging pilots, but runtime WorkflowBuilderPreviewEnvironment teardown is not wired in the BFF yet",
    );
  }
}
