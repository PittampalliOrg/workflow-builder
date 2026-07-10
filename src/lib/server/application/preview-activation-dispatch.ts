import type {
  PreviewAcceptanceChangedServiceCatalogPort,
  PreviewActivationBrokerPort,
  PreviewActivationDispatchPort,
  PreviewActivationDispatchRequest,
  PreviewActivationDispatchResult,
} from "$lib/server/application/ports";

const FULL_SHA = /^[0-9a-f]{40}$/;

type PreviewActivationDispatchDeps = Readonly<{
  broker: PreviewActivationBrokerPort;
  catalog: PreviewAcceptanceChangedServiceCatalogPort;
  sourceRepository: string;
}>;

/** Derives all non-PR activation authority before crossing the broker port. */
export class ApplicationPreviewActivationDispatchService implements PreviewActivationDispatchPort {
  constructor(private readonly deps: PreviewActivationDispatchDeps) {}

  async dispatch(
    input: PreviewActivationDispatchRequest,
  ): Promise<PreviewActivationDispatchResult> {
    const pullRequest = input.pullRequest;
    if (
      pullRequest.repository !== this.deps.sourceRepository ||
      !Number.isSafeInteger(pullRequest.number) ||
      pullRequest.number < 1 ||
      !FULL_SHA.test(pullRequest.baseSha) ||
      !FULL_SHA.test(pullRequest.headSha) ||
      pullRequest.baseSha === pullRequest.headSha
    ) {
      throw new Error("activation dispatch pull request tuple is invalid");
    }
    return await this.deps.broker.dispatch({
      requestId: `webhook:${pullRequest.number}:${pullRequest.headSha}`,
      catalogDigest: this.deps.catalog.currentDigest(),
      pullRequest,
    });
  }
}
