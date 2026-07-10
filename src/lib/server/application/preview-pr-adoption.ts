import type {
  PreviewControlIdentity,
  PreviewEnvironmentProvisioner,
  PreviewEnvironmentVersionedServiceCatalogPort,
} from "$lib/server/application/ports";

type Deps = Readonly<{
  provisioner: PreviewEnvironmentProvisioner;
  catalog: PreviewEnvironmentVersionedServiceCatalogPort;
}>;

export type PreviewPrAdoptionInput = PreviewControlIdentity &
  Readonly<{
    services: readonly string[];
    origin: string;
    waitReadySeconds: number;
  }>;

/** Fixed-policy local adoption. It has no workflow persistence or caller knobs. */
export class ApplicationPreviewPrAdoptionService {
  constructor(private readonly deps: Deps) {}

  async adopt(input: PreviewPrAdoptionInput) {
    const services = this.deps.catalog.assertPreviewNativeServices(
      input.services,
    );
    if (input.catalogDigest !== this.deps.catalog.currentDigest()) {
      throw new Error("PR adoption catalog digest is not current");
    }
    const origin = new URL(input.origin);
    if (
      origin.protocol !== "https:" ||
      !origin.hostname.startsWith(`wfb-${input.previewName}.`) ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      throw new Error("PR adoption origin does not match the preview identity");
    }
    return this.deps.provisioner.provisionMany({
      executionId: `pr-adopt-${input.environmentRequestId}`,
      services: [...services],
      executionClass: "dev-preview",
      mode: "preview-native",
      adopt: true,
      origin: input.origin,
      waitReadySeconds: input.waitReadySeconds,
    });
  }
}
