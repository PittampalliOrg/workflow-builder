export type PreviewDeploymentDescriptor = Readonly<{
  name: string;
  profile: string;
  platformRevision: string | null;
  sourceRevision: string | null;
  origin: string | null;
}>;

export type PreviewDeploymentScope =
  | Readonly<{ kind: "control-plane" }>
  | Readonly<{
      kind: "preview";
      preview: PreviewDeploymentDescriptor;
    }>;

/** Application policy boundary for control-plane versus candidate deployments. */
export interface PreviewDeploymentScopePort {
  current(): PreviewDeploymentScope;
  isControlPlane(): boolean;
  allowsPreviewName(name: string): boolean;
}
