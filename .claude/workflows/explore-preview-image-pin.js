export const meta = {
  name: 'explore-preview-image-pin',
  description: 'Explore stale workflow-builder-dev preview image: Tekton dev-images lane, render-script SSOTs, vcluster preview architecture',
  phases: [
    { title: 'Explore', detail: '3 parallel read-only explorations: lane, render/digest map, preview architecture' },
  ],
}

const LANE_SCHEMA = {
  type: 'object',
  required: ['builds_wfb_dev', 'lane_touches_serviceimage', 'latest_pin', 'update_task_targets', 'pin_source_of_truth', 'report'],
  properties: {
    builds_wfb_dev: { type: 'boolean', description: 'does the lane build the workflow-builder-dev image' },
    lane_touches_serviceimage: { type: 'string', description: 'yes/no/partially — does the lane update the dev-preview execution-class serviceImage digest anywhere, with evidence' },
    latest_pin: { type: 'string', description: 'newest workflow-builder-dev image reference (tag and/or digest) found anywhere in repo or lane commits, and where it lives' },
    update_task_targets: { type: 'array', items: { type: 'string' }, description: 'exact files + keys/paths that Task-update-dev-image-pins.yaml patches' },
    pin_source_of_truth: { type: 'string', description: 'where the lane persists pins: release-pins yaml vs direct manifest edits vs both' },
    report: { type: 'string', description: 'full detailed findings with file:line citations and exact before/after values from git show' },
  },
}

const RENDER_SCHEMA = {
  type: 'object',
  required: ['digest_occurrences', 'render_reads_release_pins', 'wfb_dev_in_release_pins', 'revert_mechanism', 'report'],
  properties: {
    digest_occurrences: { type: 'array', items: { type: 'string' }, description: 'every occurrence of the dac850 digest: file:line, whether the file is generated-by-render or hand-source, and which delivery path consumes it (dev overlay / staging overlay / vcluster app-overlay / base manifest / render script)' },
    render_reads_release_pins: { type: 'string', description: 'how the render script reads release-pins/workflow-builder-images.yaml (mechanism, variable names, example for an existing image)' },
    wfb_dev_in_release_pins: { type: 'string', description: 'is workflow-builder-dev present in release-pins/workflow-builder-images.yaml? what entries exist there today' },
    revert_mechanism: { type: 'string', description: 'confirm/refute: re-running the render script overwrites lane-written bumps in the generated overlays — with evidence' },
    report: { type: 'string', description: 'full detailed findings with file:line citations' },
  },
}

const ARCH_SCHEMA = {
  type: 'object',
  required: ['image_flow_into_preview', 'claim_devmode_semantics', 'sync_mechanism', 'midsession_rollback_risk', 'pool_recycling', 'live_state', 'report'],
  properties: {
    image_flow_into_preview: { type: 'string', description: 'end-to-end path: how a vcluster preview pool member and its per-preview wfb service pod get their images (which kustomization/app, who spawns the wfb-dev-preview pod, where serviceImage is read from and WHEN it is resolved)' },
    claim_devmode_semantics: { type: 'string', description: 'what the claim endpoint and devMode flag actually do, with file citations from the workflow-builder repo' },
    sync_mechanism: { type: 'string', description: 'how /__sync works: what it syncs, where, persistence across pod restart' },
    midsession_rollback_risk: { type: 'string', description: 'if an image pin bump lands on main mid-session: does ArgoCD/SEA restart claimed preview pods (losing synced files)? cite selfHeal/reconcile behavior for the vcluster apps and whether SEA re-reconciles running services on class-config change' },
    pool_recycling: { type: 'string', description: 'when warm pool members are created/recycled and hence when they would pick up a new image baseline' },
    live_state: { type: 'string', description: 'current live evidence from the dev cluster (read-only kubectl): SANDBOX_EXECUTION_CLASSES_JSON serviceImage on dev SEA and/or a vcluster SEA, running wfb-dev-preview pod images if any' },
    report: { type: 'string', description: 'full detailed findings with file:line citations' },
  },
}

const [lane, render, arch] = await parallel([
  () => agent(`You are exploring the stacks GitOps repo at /home/vpittamp/repos/PittampalliOrg/stacks/main (git repo, branch main, clean). READ-ONLY task — do not modify anything.

CONTEXT: The dev-preview vcluster environment boots its workflow-builder app from a frozen image digest ghcr.io/pittampalliorg/workflow-builder-dev@sha256:dac850b895608d68ddf6b2634efdc6ef6f57da71cb4adc52099629e31c8fa704. A Tekton "dev-images" build lane exists that commits messages like "chore(dev-images): rebuild + bump dev-preview image pins to git-<sha>". We must determine whether that lane is SUPPOSED to update the dev-preview execution-class serviceImage (and is being reverted by a render script), or NEVER targeted it.

DO ALL OF THE FOLLOWING (use git and Read; cite file:line and exact values):
1. Run: git -C /home/vpittamp/repos/PittampalliOrg/stacks/main show a3f22b1e3 — capture the full diff. Note EXACTLY which files changed and the before/after image values (tags like git-<sha> vs digests). Does it touch any occurrence of "workflow-builder-dev" or a serviceImage field or the dac850 digest?
2. Same for: git show c8d16796a
3. Run: git log --oneline --grep='chore(dev-images)' -30 — list all lane commits. git show the MOST RECENT one to find the newest image values the lane wrote (especially any workflow-builder-dev reference). Also note the date of the most recent lane run (git log -1 --format='%ci' <sha>).
4. Read these files fully in packages/components/hub-tekton/manifests/outer-loop-builds/: Task-build-dev-images.yaml, Task-update-dev-image-pins.yaml, TriggerTemplate-dev-images.yaml, Pipeline-perpiece-image-build.yaml. For Task-update-dev-image-pins.yaml, enumerate EXACTLY which files and which keys/yaml-paths it patches (sed/yq commands etc), and whether it knows about (a) the dev-preview execution class serviceImage, (b) scripts/gitops/render-workflow-builder-release-overlays.sh, (c) release-pins/*.yaml. For Task-build-dev-images.yaml: which images does it build (is workflow-builder-dev among them), from which repo/context/dockerfile, and what tag scheme does it push (git-<sha>? does it also produce/record digests?). For TriggerTemplate-dev-images.yaml: what triggers the lane (which repo push? path filter?).
5. Also check how the lane is triggered end-to-end: look for EventListener/TriggerBinding referencing the dev-images TriggerTemplate in the same directory or nearby.
6. Check whether release-pins/ (find the dir, likely at repo root or under a known path — use: git ls-files | grep -i release-pins) contains any workflow-builder-dev entry, and whether ANY lane commit ever wrote there.

Return structured output. In 'report', include the exact before/after image refs from the lane commits and the exact patch commands from Task-update-dev-image-pins.yaml.`, { label: 'explore:tekton-lane', phase: 'Explore', schema: LANE_SCHEMA, agentType: 'Explore' }),

  () => agent(`You are exploring the stacks GitOps repo at /home/vpittamp/repos/PittampalliOrg/stacks/main (git repo, branch main, clean). READ-ONLY task — do not modify anything.

CONTEXT: The digest ghcr.io/pittampalliorg/workflow-builder-dev@sha256:dac850b895608d68ddf6b2634efdc6ef6f57da71cb4adc52099629e31c8fa704 is hardcoded ~8x across packages/ + scripts/. A render script scripts/gitops/render-workflow-builder-release-overlays.sh contains a heredoc that regenerates workflow-builder-system-overlays/{dev,staging}/kustomization.yaml, and its header says "do not edit by hand". We need a complete map of every occurrence and the render-script data flow, to decide how to variable-drive it.

DO ALL OF THE FOLLOWING (cite file:line):
1. Run: grep -rn 'dac850' /home/vpittamp/repos/PittampalliOrg/stacks/main --include='*' -l then grep -rn with context for each hit. For EACH occurrence record: file:line, is the file GENERATED by the render script (check for a generated-file header) or hand-maintained source, and which delivery path consumes it: (a) workflow-builder-system-overlays/dev (main dev cluster), (b) staging overlay, (c) workflow-builder-preview-vcluster app-overlay (vcluster pool), (d) base Deployment manifests (which apps consume those?), (e) the render script itself.
2. Read scripts/gitops/render-workflow-builder-release-overlays.sh IN FULL (it may be long — read all of it). Explain: (a) how it reads release-pins/workflow-builder-images.yaml — exact mechanism (yq? grep?), variable names like image_ref/source_sha, and a concrete example of how an existing image (e.g. the BFF or SEA image) flows from release-pins into the generated overlays; (b) where the dev-preview execution class heredoc is (around line 144?) and its exact current content incl. the hardcoded digest; (c) the FULL list of files the script (re)generates; (d) whether SANDBOX_EXECUTION_CLASSES_JSON appears in generated output, and for which environments; (e) any existing pattern in the script for images that are NOT in release-pins.
3. Find and read the release-pins file(s): git ls-files | grep -i 'release-pins'. Read the workflow-builder images pin file fully — list every image entry and its fields (image_ref, source_sha, etc). Is workflow-builder-dev present? Also check git log -5 --oneline -- <that file> to see who updates it (outer-loop commits?).
4. Read packages/components/workloads/workflow-builder-preview-vcluster/app-overlay/kustomization.yaml — the SANDBOX_EXECUTION_CLASSES_JSON around line 337, plus any images: transformer entries. Is this file generated by the render script or hand-maintained? Does the dev-images Tekton lane update it (check git log -5 --oneline -- on it)?
5. Read packages/components/workloads/workflow-builder-preview/Deployment-workflow-builder-dev.yaml and find the base SEA/BFF Deployment manifests that contain the dac850 digest (from your step-1 map). For each: which ArgoCD app / cluster consumes it, and check git log -3 --oneline -- <file> to see whether the dev-images lane has been updating it.
6. CONFIRM OR REFUTE the revert hypothesis: if the Tekton lane bumps an image value in workflow-builder-system-overlays/{dev,staging}/kustomization.yaml (generated files), would re-running the render script revert that bump because the heredoc hardcodes dac850? Look at whether the generated files' dac850 value comes verbatim from the heredoc.

Return structured output. In 'report' be exhaustive with file:line citations.`, { label: 'explore:render-ssot', phase: 'Explore', schema: RENDER_SCHEMA, agentType: 'Explore' }),

  () => agent(`You are exploring TWO repos READ-ONLY: /home/vpittamp/repos/PittampalliOrg/stacks/main (GitOps) and /home/vpittamp/repos/PittampalliOrg/workflow-builder/main (the app, SvelteKit BFF + sandbox-execution-api "SEA"). You may also run READ-ONLY kubectl against the dev cluster: kubectl --context dev ... (get/describe only, no mutations). Do not modify anything.

CONTEXT: vcluster-based preview/dev environments ("dev-preview") run on the dev cluster. A warm pool of vclusters exists (ns vcluster-pool-<n>); a claim endpoint (/internal/vcluster-preview/claim with {name, devMode}) hands one out; the SEA inside spawns per-preview service pods (e.g. wfb-dev-preview-*) using a serviceImage from an execution-class JSON (SANDBOX_EXECUTION_CLASSES_JSON, class "dev-preview"). A GAN agent developing in a preview edits files and pushes them into the running container via a /__sync mechanism. GOAL of this exploration: understand the full image lifecycle of a preview and the interplay with active development, so we can design "previews boot with latest main images, but in-flight dev work is never rolled back by GitOps".

DO ALL OF THE FOLLOWING (cite file:line):
1. In the stacks repo: explore packages/components/workloads/workflow-builder-preview-vcluster/ fully (tree it, read the key manifests). How is the warm pool created (controller? cronjob? appset?), what's inside each pool vcluster (which apps/deployments), and how do manifests flow from the stacks repo into the vcluster (ArgoCD app? which one, with what syncPolicy — automated? selfHeal? prune?). Find where SANDBOX_EXECUTION_CLASSES_JSON is set for the vcluster SEA.
2. In the workflow-builder repo: find the claim endpoint implementation (search for 'vcluster-preview/claim', 'devMode', 'warm pool', 'pool'). What exactly does devMode change? Find where the SEA reads SANDBOX_EXECUTION_CLASSES_JSON and WHEN serviceImage is resolved (at service-spawn time per preview? cached?). Search for how the per-preview service pod (wfb-dev-preview) is created and whether SEA ever restarts/re-reconciles it when class config changes.
3. Find the /__sync mechanism (search '__sync' in workflow-builder repo): what does it do (copy files into running container? trigger HMR/vite? rebuild?), is synced state ephemeral (lost on pod restart)?
4. Mid-session rollback risk: determine what happens to a CLAIMED preview when a new image pin lands on main: (a) does ArgoCD sync the change into the vcluster pool namespaces (selfHeal on which app)? (b) does that restart the SEA or the spawned wfb-dev-preview pod? (c) is there any claim-time snapshot/pause mechanism already (annotations like skip-reconcile, sync windows, ignoreDifferences)?
5. Pool lifecycle: when are pool members recycled (TTL? after release? on config change?) — i.e., when would a pool member naturally pick up a NEW image baseline? Search stacks + workflow-builder for the pool controller/recycler logic.
6. Baseline flow to the MAIN dev cluster: how do latest images reach the main dev cluster BFF/SEA today (chore(outer-loop) release-pin commits -> render -> overlay -> appset)? Just a concise summary of that path with file citations (release-pins -> generated dev overlay -> which ArgoCD app).
7. LIVE evidence (read-only): kubectl --context dev -n workflow-builder get deploy sandbox-execution-api -o jsonpath on the SANDBOX_EXECUTION_CLASSES_JSON env (or get the deployment yaml and extract it). List vcluster pool namespaces: kubectl --context dev get ns | grep vcluster-pool. For one UNPROTECTED pool ns (NOT any with label/annotation vcluster-preview-protected=true — check labels first; avoid vcluster-pool-5953 and vcluster-pool-2576 entirely), find the SEA pod inside the vcluster if feasible cheaply (vcluster pods appear in the host ns with -x- names); extract the image of any wfb-dev-preview-* pod visible. If kubectl access fails, note it and move on — repo evidence is the priority.

Return structured output. In 'report' be exhaustive with file:line citations.`, { label: 'explore:preview-arch', phase: 'Explore', schema: ARCH_SCHEMA, agentType: 'Explore' }),
])

return { lane, render, arch }