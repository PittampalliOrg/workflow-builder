import type { VclusterPreviewRecord } from "$lib/types/dev-previews";
import type { TupleBoundVclusterPreviewRuntimeSnapshot } from "./dev-previews";
import type {
  AuthorizedPreviewControlSource,
  PreviewControlEnvironmentRecord,
  PreviewControlIdentity,
} from "./preview-control";

export type TupleBoundVclusterPreviewRecord = Readonly<{
  preview: VclusterPreviewRecord;
  identity: PreviewControlIdentity;
}>;

export type TupleBoundVclusterPreviewRuntimeObservation = Readonly<{
  preview: VclusterPreviewRecord;
  runtime: TupleBoundVclusterPreviewRuntimeSnapshot;
  identity: PreviewControlIdentity;
}>;

/**
 * Driven adapter contract for an atomic, tuple-fenced physical observation.
 * The adapter owns the before/after namespace identity fence; application
 * services must not reconstruct it with multiple independent reads.
 */
export interface PreviewEnvironmentObservationReaderPort {
  inspect(
    identity: PreviewControlIdentity,
  ): Promise<TupleBoundVclusterPreviewRecord>;
  observeRuntime(
    identity: PreviewControlIdentity,
  ): Promise<TupleBoundVclusterPreviewRuntimeObservation>;
}

/** Source policy over an already tuple-fenced physical record. */
export interface PreviewObservedSourceAuthorityPort {
  authorizeObservedRuntimeTuple(
    identity: PreviewControlIdentity,
    environment: PreviewControlEnvironmentRecord,
  ): Promise<AuthorizedPreviewControlSource>;
}

/**
 * Driving contract for the physical preview-observation broker. A preview may
 * observe only the immutable generation represented by its tuple capability.
 */
export interface PreviewEnvironmentObservationBrokerPort {
  inspect(identity: PreviewControlIdentity): Promise<VclusterPreviewRecord>;
  observeRuntime(
    identity: PreviewControlIdentity,
  ): Promise<TupleBoundVclusterPreviewRuntimeObservation>;
}
