export const meta = {
  name: 'argocd-promoter-upgrade-research',
  description: 'Verify compatible version sets + delivery paths for ArgoCD v3.4.3 and GitOps Promoter v0.31.1 upgrades on the hub',
  phases: [
    { title: 'Research', detail: 'parallel: promoter versions, argocd version, delivery path, live diagnosis' },
    { title: 'Verify', detail: 'adversarially confirm proposed versions/URLs resolve and are compatible' },
  ],
}

const KC = '$HOME/.kube/hub-config'
const REPO = '/home/vpittamp/repos/PittampalliOrg/stacks/main'

const PROMOTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['chartVersion', 'controllerImageTag', 'uiExtensionTag', 'crdRef', 'tarballUrl', 'checksumUrl', 'urlsResolve', 'valuesObjectCompatibility', 'crdPatchStillNeeded', 'breakingChanges', 'notes'],
  properties: {
    chartVersion: { type: 'string', description: 'latest gitops-promoter helm chart version (e.g. 0.11.1)' },
    controllerImageTag: { type: 'string', description: 'controller/manager image tag matching that chart appVersion (e.g. v0.31.1)' },
    uiExtensionTag: { type: 'string', description: 'release tag for the argocd UI extension tarball (e.g. v0.31.1)' },
    crdRef: { type: 'string', description: 'git ref to use for github.com/argoproj-labs/gitops-promoter/config/crd?ref=...' },
    tarballUrl: { type: 'string', description: 'full https URL to gitops-promoter-argocd-extension.tar.gz for the chosen tag' },
    checksumUrl: { type: 'string', description: 'full https URL to the checksums.txt for the chosen tag' },
    urlsResolve: { type: 'boolean', description: 'true only if BOTH tarballUrl and checksumUrl returned HTTP 200/302 when curled' },
    valuesObjectCompatibility: { type: 'string', description: 'For chart 0.11.1, confirm whether each of these valuesObject keys still exists/is valid: crd.enable, webhook.enable, manager.image.tag, replicaCount, controllerConfiguration.{promotionStrategy,changeTransferPolicy,pullRequest,argocdCommitStatus,timedCommitStatus}.workQueue.requeueDuration. Note any renamed/removed keys.' },
    crdPatchStillNeeded: { type: 'string', description: 'Does the changetransferpolicies status.proposed.note field still lack nullable:true at the chosen CRD ref (so the kustomize patch is still needed), or was it fixed upstream? State evidence.' },
    breakingChanges: { type: 'array', items: { type: 'string' }, description: 'notable breaking changes / migration notes from chart 0.9.2->0.11.1 and controller v0.27.1/v0.30.0 -> chosen tag' },
    notes: { type: 'string' },
  },
}

const ARGOCD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['targetAppVersion', 'argoHelmChartVersion', 'chartVersionVerified', 'currentChartVersion', 'backportIncluded', 'valuesWorkaroundAction', 'breakingChanges', 'notes'],
  properties: {
    targetAppVersion: { type: 'string', description: 'v3.4.3' },
    argoHelmChartVersion: { type: 'string', description: 'the argo-helm argo-cd chart version whose appVersion == v3.4.3' },
    chartVersionVerified: { type: 'boolean', description: 'true only if confirmed against the argo-helm index.yaml that this chart version maps to appVersion 3.4.3' },
    currentChartVersion: { type: 'string', description: 'the chart version currently pinned in 01-install-argocd.sh (expected 9.5.15)' },
    backportIncluded: { type: 'string', description: 'Does ArgoCD v3.4.3 include the backport of argo-cd #28125 referenced in deployment/config/argocd-values.yaml ~line 185-189? yes/no/unknown with evidence.' },
    valuesWorkaroundAction: { type: 'string', description: 'Based on backportIncluded: should the workaround block in argocd-values.yaml be removed, kept, or left alone? Quote the relevant values lines.' },
    breakingChanges: { type: 'array', items: { type: 'string' }, description: 'any breaking changes between argo-cd chart 9.5.15 and the target chart version' },
    notes: { type: 'string' },
  },
}

const DELIVERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['promoterAppsDeliveryPath', 'uiPatchDeliveryPath', 'crdAppDeliveryPath', 'argocdCoreDeliveryPath', 'branchesToPush', 'liveActionsRequired', 'risks', 'notes'],
  properties: {
    promoterAppsDeliveryPath: { type: 'string', description: 'How edits to packages/components/hub-management/apps/gitops-promoter.yaml reach the live hub. Is the hub app-of-apps source-hydrated through env/hub? Do child apps track main/HEAD directly?' },
    uiPatchDeliveryPath: { type: 'string', description: 'How edits to argocd-gitops-promoter-ui/Job-...patch.yaml reach live (app targetRevision HEAD). Note the patch is a Sync hook - what triggers re-run? Does argocd-server need a restart to re-pull the extension tarball?' },
    crdAppDeliveryPath: { type: 'string', description: 'gitops-promoter-crds app targetRevision is main - delivery path' },
    argocdCoreDeliveryPath: { type: 'string', description: 'ArgoCD core is bootstrap-installed via 01-install-argocd.sh helm. Editing the script does NOT auto-deploy. What manual action upgrades the live hub to v3.4.3 (helm upgrade command), and does it self-manage or recreate-only?' },
    branchesToPush: { type: 'array', items: { type: 'string' }, description: 'exact branches that must receive the commit for each change to take effect (main, env/hub, env/hub-next, etc.)' },
    liveActionsRequired: { type: 'array', items: { type: 'string' }, description: 'ordered manual live actions needed beyond git push (e.g. helm upgrade for argocd, restart argocd-server for extension re-pull, hard-refresh app)' },
    risks: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const DIAG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['appsHealthy', 'extensionInitContainerPresent', 'extensionVersionLive', 'argocdCmLinksPresent', 'controllerRestartCause', 'promotionResourcesPresent', 'rootCauseHypothesis', 'confidence', 'notes'],
  properties: {
    appsHealthy: { type: 'string', description: 'sync/health of the 4 promoter apps live' },
    extensionInitContainerPresent: { type: 'boolean' },
    extensionVersionLive: { type: 'string', description: 'extension tag currently installed on argocd-server (expect v0.27.1)' },
    argocdCmLinksPresent: { type: 'string', description: 'are resource.links and resource.customLabels for promoter actually present in live argocd-cm? quote them' },
    controllerRestartCause: { type: 'string', description: 'why has gitops-promoter-controller-manager restarted 8 times? check pod events/last-state/logs' },
    promotionResourcesPresent: { type: 'string', description: 'do PromotionStrategy/ChangeTransferPolicy/PullRequest CRs exist and what is their status? are they showing in argocd app trees?' },
    rootCauseHypothesis: { type: 'string', description: 'best verified explanation for why the user does not SEE the promoter UI' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' },
  },
}

phase('Research')

const [promoter, argocd, delivery, diag] = await parallel([
  () => agent(
    `You are researching the GitOps Promoter (github.com/argoproj-labs/gitops-promoter) upgrade. The repo at ${REPO} currently pins: helm chart 0.9.2 (repo https://argoproj-labs.github.io/gitops-promoter-helm), manager image v0.30.0, CRDs via kustomize remote 'github.com/argoproj-labs/gitops-promoter/config/crd?ref=v0.30.0' (with a patch adding nullable:true to changetransferpolicies status.proposed.note), and an ArgoCD UI extension installed from release v0.27.1 (file gitops-promoter-argocd-extension.tar.gz).

Determine the LATEST mutually-compatible version set and VERIFY it by actually fetching:
1. Latest helm chart version + its appVersion from the chart index: curl -s https://argoproj-labs.github.io/gitops-promoter-helm/index.yaml | grep -E 'version:|appVersion:' (the latest is around chart 0.11.1 / appVersion 0.31.1 — confirm).
2. The controller image tag should equal the chart appVersion (v0.31.1). Confirm the chart's default manager image tag for that chart version, and whether overriding manager.image.tag is still the right key.
3. The UI extension: curl -sI -L the tarball + checksum URLs for the chosen tag to confirm HTTP 200. URLs look like:
   https://github.com/argoproj-labs/gitops-promoter/releases/download/v0.31.1/gitops-promoter-argocd-extension.tar.gz
   https://github.com/argoproj-labs/gitops-promoter/releases/download/v0.31.1/gitops-promoter_0.31.1_checksums.txt
   Set urlsResolve true ONLY if both return 200 (follow redirects).
4. Fetch the chart 0.11.1 values.yaml (helm show values gitops-promoter --repo https://argoproj-labs.github.io/gitops-promoter-helm --version 0.11.1, or pull the chart tgz from index.yaml urls and extract values.yaml) and confirm these valuesObject keys still exist and are spelled the same: crd.enable, webhook.enable, manager.image.tag, replicaCount, controllerConfiguration.promotionStrategy.workQueue.requeueDuration (and the same workQueue.requeueDuration under changeTransferPolicy, pullRequest, argocdCommitStatus, timedCommitStatus). Report any removed/renamed keys.
5. Fetch the v0.31.1 changetransferpolicies CRD (from the config/crd?ref=v0.31.1 path on github, e.g. curl raw github content for config/crd/bases/promoter.argoproj.io_changetransferpolicies.yaml at ref v0.31.1) and check whether status.proposed.note already has nullable:true (meaning the local kustomize patch is now redundant) or still needs it.
6. Note breaking changes between chart 0.9.2->0.11.1 and controller v0.27.1/v0.30.0 -> v0.31.1 (skim release notes / CHANGELOG via the GitHub releases API: curl -s 'https://api.github.com/repos/argoproj-labs/gitops-promoter/releases?per_page=8').

Use helm and curl. If helm is unavailable, pull chart tgz URLs from index.yaml directly. Return the structured result.`,
    { label: 'promoter-versions', phase: 'Research', schema: PROMOTER_SCHEMA }
  ),

  () => agent(
    `You are researching the ArgoCD core upgrade to appVersion v3.4.3. ArgoCD on the hub is installed by ${REPO}/deployment/scripts/01-install-argocd.sh using the argo-helm 'argo-cd' chart pinned to version 9.5.15 (variable ARGOCD_CHART_VERSION). The live cluster currently runs quay.io/argoproj/argocd:v3.4.2.

Tasks:
1. Find the argo-helm 'argo-cd' chart version whose appVersion == 3.4.3. Verify against the official index: curl -s https://argoproj.github.io/argo-helm/index.yaml is large; better: curl -s 'https://api.github.com/repos/argoproj/argo-helm/releases?per_page=60' | grep argo-cd, or fetch the chart's Chart.yaml from the argo-helm repo tags. Alternatively 'helm search repo argo/argo-cd --versions' after 'helm repo add argo https://argoproj.github.io/argo-helm && helm repo update'. Confirm chart 9.5.15 maps to appVersion v3.4.2 and find the chart version that maps to appVersion v3.4.3 (likely 9.5.16 or 9.6.x). Set chartVersionVerified true only if you confirmed the mapping from an authoritative source (index.yaml / Chart.yaml).
2. Read ${REPO}/deployment/config/argocd-values.yaml around lines 180-200. There is a workaround block referencing a backport of argo-cd issue #28125 (release-3.4) that the comment says is needed until 'an argo-cd build that already contains the fix (post-v3.4.2)'. Determine whether ArgoCD v3.4.3 contains the backport of #28125 (check the argo-cd v3.4.3 release notes: curl -s 'https://api.github.com/repos/argoproj/argo-cd/releases/tags/v3.4.3' and/or the release-3.4 changelog). Quote the relevant argocd-values.yaml lines and recommend whether to remove/keep the workaround.
3. Note any breaking changes between argo-cd chart 9.5.15 and the target chart version (skim the chart release notes).

Return the structured result.`,
    { label: 'argocd-version', phase: 'Research', schema: ARGOCD_SCHEMA }
  ),

  () => agent(
    `Trace the exact GitOps delivery path for each upgrade edit in ${REPO}. This is a hub-and-spoke ArgoCD fleet where the HUB is source-hydrated: source lives under packages/overlays/hub on 'main', hydrated to env/hub-next, promoted to env/hub; the hub ArgoCD syncs from env/hub branch path hub-apps/. BUT some child Application manifests pin targetRevision: HEAD or main directly to github.com/PittampalliOrg/stacks.

Read these files and determine, for EACH, exactly which branch(es) must receive a commit and whether any live (non-git) action is required:
- packages/components/hub-management/apps/gitops-promoter.yaml (chart version + image tag live here; this Application is itself rendered by the hub app-of-apps)
- packages/components/hub-management/apps/argocd-gitops-promoter-ui.yaml (targetRevision HEAD, path .../argocd-gitops-promoter-ui)
- packages/components/hub-management/manifests/argocd-gitops-promoter-ui/Job-argocd-gitops-promoter-ui-patch.yaml (a Sync-hook Job that patches the argocd-server deployment to add the extension init container)
- packages/components/hub-management/apps/gitops-promoter-crds.yaml (targetRevision main)
- packages/components/hub-management/manifests/gitops-promoter-crds/kustomization.yaml (remote crd ref)
- deployment/scripts/01-install-argocd.sh (ArgoCD core — bootstrap helm, NOT a GitOps app)

Key questions:
a) Is the hub app-of-apps that creates these Application CRs hydrated through env/hub? Find the root hub app / appset and its targetRevision. Check packages/overlays/hub and any 'hub-apps' / app-of-apps. So does bumping the chart version in gitops-promoter.yaml require a push to main AND a promotion to env/hub, or does it track main directly?
b) For the UI patch Job (a Sync hook): after changing EXTENSION_URL to v0.31.1, what makes the hook re-run, and does argocd-server need a rollout restart to re-run the extension-installer init container and download the new tarball? (The init container only runs on pod (re)start.)
c) For ArgoCD core: editing 01-install-argocd.sh changes only future bootstraps/recreates. What is the exact 'helm upgrade' command to apply v3.4.3 to the LIVE hub now (chart repo, release name, namespace, values file)? Does the script use 'helm upgrade --install'? Quote the helm invocation lines.

Inspect the repo with grep/cat/find as needed. You can also check the live hub: kubectl --kubeconfig ${KC} get applications -n argocd, and inspect the hub root app's spec.source.targetRevision. Return the structured result.`,
    { label: 'delivery-path', phase: 'Research', schema: DELIVERY_SCHEMA }
  ),

  () => agent(
    `Diagnose why the user reports the GitOps Promoter UI is "not visible" in their ArgoCD UI, even though the apps appear configured. Use the live hub: kubectl --kubeconfig ${KC} ...

Investigate:
1. Sync/health of promoter apps: kubectl --kubeconfig ${KC} get applications -n argocd | grep -i promoter (also argocd-gitops-promoter-ui).
2. The UI extension init container on argocd-server: kubectl --kubeconfig ${KC} get deploy argocd-server -n argocd -o jsonpath of initContainers — confirm extension-gitops-promoter present and its EXTENSION_URL (expect v0.27.1).
3. Whether the extension files actually loaded: exec into a running argocd-server pod and 'ls -R /tmp/extensions/' (kubectl --kubeconfig ${KC} exec deploy/argocd-server -n argocd -c server -- ls -la /tmp/extensions/ 2>/dev/null). If empty/missing the resources subdir, the tab won't render.
4. argocd-cm live values: kubectl --kubeconfig ${KC} get cm argocd-cm -n argocd -o jsonpath='{.data.resource\\.links}' and '{.data.resource\\.customLabels}' — are the promoter PR links/customLabels actually present? Quote them.
5. The argocd-server image/version: kubectl --kubeconfig ${KC} get deploy argocd-server -n argocd -o jsonpath of container image (expect v3.4.2). The promoter UI extension v0.27.1 is old — assess whether it is known-incompatible with ArgoCD 3.4.x (the extension is a resource-tab/panel UI; a JS API mismatch would make the tab blank or absent).
6. Controller restarts: kubectl --kubeconfig ${KC} -n gitops-promoter-system describe pod (the controller-manager restarted 8 times ~96m ago) — get the last-terminated reason / recent logs (kubectl --kubeconfig ${KC} -n gitops-promoter-system logs <pod> --previous --tail=50 ; and current logs tail). Note OOM/crash/leader-election.
7. Whether PromotionStrategy / ChangeTransferPolicy / PullRequest custom resources exist and their status: kubectl --kubeconfig ${KC} get promotionstrategy,changetransferpolicy,pullrequest -A 2>/dev/null.

Form the best-supported root-cause hypothesis for why the promoter UI is not visible (most likely: the v0.27.1 extension is stale relative to controller v0.30.0 and/or incompatible with ArgoCD 3.4.x, so the resource tab doesn't render; OR the promoter resources simply aren't surfaced where the user is looking). Set confidence. Return the structured result.`,
    { label: 'live-diagnosis', phase: 'Research', schema: DIAG_SCHEMA }
  ),
])

phase('Verify')

// Adversarial verification: independently re-check the two proposed version sets actually resolve & are internally consistent.
const [promoterVerdict, argocdVerdict] = await parallel([
  () => agent(
    `Adversarially verify this proposed GitOps Promoter version set. Try to REFUTE it; default to refuted=true if anything does not check out.

Proposed:
- chart version: ${promoter?.chartVersion}
- controller image tag: ${promoter?.controllerImageTag}
- UI extension tag: ${promoter?.uiExtensionTag}
- CRD ref: ${promoter?.crdRef}
- tarball URL: ${promoter?.tarballUrl}
- checksum URL: ${promoter?.checksumUrl}

Independently run:
  curl -sI -L -o /dev/null -w '%{http_code}\\n' '${promoter?.tarballUrl}'
  curl -sI -L -o /dev/null -w '%{http_code}\\n' '${promoter?.checksumUrl}'
Both must be 200. Also confirm chart ${promoter?.chartVersion} exists in https://argoproj-labs.github.io/gitops-promoter-helm/index.yaml and that its appVersion matches the controller image tag (${promoter?.controllerImageTag}). Also sanity-check the CRD ref tag exists: curl -sI -o /dev/null -w '%{http_code}\\n' 'https://raw.githubusercontent.com/argoproj-labs/gitops-promoter/${promoter?.crdRef}/config/crd/bases/promoter.argoproj.io_changetransferpolicies.yaml' (expect 200).
Report refuted (bool) and the concrete evidence.`,
    { label: 'verify:promoter', phase: 'Verify', schema: { type: 'object', additionalProperties: false, required: ['refuted', 'evidence'], properties: { refuted: { type: 'boolean' }, evidence: { type: 'string' } } } }
  ),
  () => agent(
    `Adversarially verify the proposed ArgoCD chart mapping. Try to REFUTE it; default to refuted=true if uncertain.

Proposed: argo-helm 'argo-cd' chart version ${argocd?.argoHelmChartVersion} maps to appVersion v3.4.3.

Independently confirm by an authoritative source — e.g. fetch the Chart.yaml for that chart version: try 'helm show chart argo/argo-cd --version ${argocd?.argoHelmChartVersion}' (after helm repo add argo https://argoproj.github.io/argo-helm && helm repo update) and read the appVersion field, OR curl the argo-helm index.yaml entry. The appVersion MUST read 3.4.3 (or v3.4.3). Also confirm the current pin 9.5.15 maps to 3.4.2. Report refuted (bool) and concrete evidence (quote the appVersion line you found).`,
    { label: 'verify:argocd', phase: 'Verify', schema: { type: 'object', additionalProperties: false, required: ['refuted', 'evidence'], properties: { refuted: { type: 'boolean' }, evidence: { type: 'string' } } } }
  ),
])

return {
  promoter,
  argocd,
  delivery,
  diag,
  verification: { promoter: promoterVerdict, argocd: argocdVerdict },
}
