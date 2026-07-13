import type { VclusterPreviewRecord } from "$lib/types/dev-previews";
import type { TupleBoundVclusterPreviewRuntimeSnapshot } from "./dev-previews";
import type { PreviewControlIdentity } from "./preview-control";

/**
 * Driving contract for the physical preview-observation broker. A preview may
 * observe only the immutable generation represented by its tuple capability.
 */
export interface PreviewEnvironmentObservationBrokerPort {
  inspect(identity: PreviewControlIdentity): Promise<VclusterPreviewRecord>;
  observeRuntime(
    identity: PreviewControlIdentity,
  ): Promise<TupleBoundVclusterPreviewRuntimeSnapshot>;
}
