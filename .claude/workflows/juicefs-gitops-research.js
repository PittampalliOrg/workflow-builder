export const meta = {
  name: 'juicefs-gitops-research',
  description: 'Research + verify the juicefs-csi-driver Helm app + Postgres-store bootstrap, anchored to the proven dev install',
  phases: [
    { title: 'Research', detail: 'chart values, format/bootstrap mechanics, live dev install' },
    { title: 'Verify', detail: 'reconcile into an authoritative author-ready spec' },
  ],
}

const CHART_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['chartRepo', 'chartVersionForDriver031x', 'valuesObjectYaml', 'rendersCsiDriverObject', 'immutableEnvApproach', 'notes'],
  properties: {
    chartRepo: { type: 'string', description: 'Helm repo URL for juicefs-csi-driver' },
    chartVersionForDriver031x: { type: 'string', description: 'Chart version (targetRevision) whose juicefs-csi-driver image is v0.31.x (match dev v0.31.3 as closely as possible)' },
    driverImageVersion: { type: 'string' },
    valuesObjectYaml: { type: 'string', description: 'EXACT helm.valuesObject YAML (2-space indent, ready to paste under spec.source.helm.valuesObject) that adds JUICEFS_IMMUTABLE=true env to BOTH the controller and node plugin containers. Use the real chart value keys.' },
    rendersCsiDriverObject: { type: 'boolean', description: 'Does the chart render the CSIDriver object (csi.juicefs.com)? If yes, what is its default fsGroupPolicy / volumeLifecycleModes?' },
    csiDriverDefaults: { type: 'string' },
    immutableEnvApproach: { type: 'string', description: 'How the chart exposes adding env vars to the plugin containers (e.g. controller.envs / node.envs / extraEnvs); cite the values key path' },
    needsKustomizePatch: { type: 'boolean', description: 'True if the chart canNOT add the env via values and a multi-source kustomize patch is required' },
    notes: { type: 'string' },
  },
}

const BOOTSTRAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['juicefsCliImage', 'formatCommandTemplate', 'formatIdempotent', 'createDbRoleSql', 'notes'],
  properties: {
    juicefsCliImage: { type: 'string', description: 'A container image that contains the `juicefs` CLI binary usable in a bootstrap Job (prefer one already implied by the csi driver, e.g. juicedata/mount:* or the csi-driver image). Give the exact path to the binary.' },
    formatCommandTemplate: { type: 'string', description: 'Exact `juicefs format --storage postgres ...` command for metadata+data BOTH in Postgres (PGFS), parameterized by metaurl + fs name (wfbcli). Match the proven dev secret shape (storage=postgres, bucket=<host>/<db>, access-key=<pguser>, secret-key=<pgpass>).' },
    formatIdempotent: { type: 'boolean', description: 'Is re-running `juicefs format` on an already-formatted FS safe/idempotent?' },
    createDbRoleSql: { type: 'string', description: 'Idempotent psql to CREATE the juicefs role + database in the existing workflow-builder Postgres (role login, owns db). Use DO-block / pg_roles guard for idempotency.' },
    passwordStrategy: { type: 'string', description: 'Recommended way to derive/persist the juicefs PG password idempotently WITHOUT a new secret-store key (e.g. deterministic from an existing secret, or read-back from the juicefs-wfbcli Secret if it already exists).' },
    notes: { type: 'string' },
    caveats: { type: 'array', items: { type: 'string' } },
  },
}

const LIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['controllerImmutableEnv', 'nodeImmutableEnv', 'driverImage', 'csiDriverSpecJson', 'secretKeysRedacted', 'notes'],
  properties: {
    controllerImmutableEnv: { type: 'string' },
    nodeImmutableEnv: { type: 'string' },
    driverImage: { type: 'string' },
    csiDriverSpecJson: { type: 'string', description: 'JSON of csidriver csi.juicefs.com .spec' },
    secretKeysRedacted: { type: 'string', description: 'The juicefs-wfbcli secret keys + non-sensitive values (passwords redacted), from the dev jfs-test ns' },
    installMethodHint: { type: 'string', description: 'How the manual dev install was done (helm? raw manifest? any labels app.kubernetes.io/managed-by) — read from the live objects' },
    rbacObjectsPresent: { type: 'string', description: 'ClusterRole/Role names the driver uses (so the Helm app recreates them)' },
    notes: { type: 'string' },
  },
}

const FINAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['helmAppValuesObjectYaml', 'bootstrapJobScript', 'rbacYaml', 'classEnableJson', 'readyToAuthor', 'inconsistencies'],
  properties: {
    helmAppValuesObjectYaml: { type: 'string', description: 'FINAL helm.valuesObject YAML for the ArgoCD app (driver pinned to ~v0.31.x, JUICEFS_IMMUTABLE=true on controller+node), reconciled with the live install. If the chart cannot set the env, instead provide a complete multi-source (helm+kustomize patch) plan in this string.' },
    chartRepo: { type: 'string' },
    chartVersion: { type: 'string' },
    bootstrapJobScript: { type: 'string', description: 'The full shell script body for a Job (container args) that idempotently: creates the juicefs DB+role, derives/persists the password, writes the juicefs-wfbcli Secret in workflow-builder ns (6 keys), and runs juicefs format. Reference env from workflow-builder-secrets (DATABASE_URL/POSTGRES_PASSWORD).' },
    bootstrapJobImage: { type: 'string', description: 'Image for the bootstrap Job (must have juicefs CLI + psql, or note a two-step/init approach)' },
    rbacYaml: { type: 'string', description: 'The Role+RoleBinding (workflow-builder ns) granting the bootstrap Job SA secret create/get/patch, AND the ClusterRole additions for sandbox-execution-api SA to create/delete PV (cluster) + PVC (namespaced).' },
    classEnableJson: { type: 'string', description: 'The exact transcriptStore* JSON keys to merge into the interactive-cli entry of SANDBOX_EXECUTION_CLASSES_JSON.' },
    readyToAuthor: { type: 'boolean' },
    inconsistencies: { type: 'array', items: { type: 'string' }, description: 'Any conflict between the Helm-chart approach and the proven live install that needs a human decision' },
  },
}

phase('Research')
const [chart, bootstrap, live] = await parallel([
  () => agent(
    `Research the JuiceFS CSI driver Helm chart so we can deploy it via an ArgoCD Application (spec.source.helm.valuesObject), matching driver image v0.31.x (dev runs v0.31.3).\n` +
    `CRITICAL need: add the env var JUICEFS_IMMUTABLE=true to BOTH the controller (StatefulSet) AND node (DaemonSet) "juicefs-plugin" containers — this is the Talos read-only /etc fix (it makes pod.go skip the /etc/updatedb.conf hostPath mount).\n` +
    `Find: the chart repo URL; the chart version (targetRevision) whose appVersion/image is v0.31.x; the EXACT values.yaml key path(s) to inject that env into controller+node plugin containers; whether the chart renders the CSIDriver object (csi.juicefs.com) and its default fsGroupPolicy + volumeLifecycleModes; and whether a kustomize patch is needed if values can't do it.\n` +
    `Use WebFetch on the chart's values.yaml in the juicedata/charts or juicedata/juicefs-csi-driver repo (raw GitHub) and the CSI docs. Return the ready-to-paste valuesObject YAML.`,
    { label: 'chart-values', phase: 'Research', schema: CHART_SCHEMA }
  ),
  () => agent(
    `Research JuiceFS "format" + a Kubernetes bootstrap Job to provision a Postgres-backed JuiceFS filesystem (PGFS: metadata AND data both in Postgres, NO object store).\n` +
    `Context: our store is named "wfbcli" on the workflow-builder Postgres (service postgresql.workflow-builder.svc.cluster.local:5432). The proven dev secret juicefs-wfbcli has keys: name=wfbcli, storage=postgres, access-key=<pguser juicefs>, secret-key=<pgpass>, metaurl=postgres://juicefs:<pw>@postgresql.workflow-builder.svc.cluster.local:5432/juicefs?sslmode=disable, bucket=postgresql.workflow-builder.svc.cluster.local:5432/juicefs?sslmode=disable.\n` +
    `Find: (1) which container image contains the juicefs CLI binary for a Job (and the binary path); (2) the exact 'juicefs format --storage postgres' command (metadata+data in PG); (3) whether re-running format on an existing FS is idempotent/safe; (4) idempotent psql to create the 'juicefs' role+database in an EXISTING postgres (DO-block guards); (5) a password strategy that's idempotent WITHOUT a new secret-store key (deterministic-derive from POSTGRES_PASSWORD, or read-back from the Secret if present).\n` +
    `Use WebFetch on JuiceFS docs (juicefs.com/docs) for format + postgres metadata/storage. Return concrete commands/SQL.`,
    { label: 'bootstrap', phase: 'Research', schema: BOOTSTRAP_SCHEMA }
  ),
  () => agent(
    `Read the LIVE, PROVEN juicefs-csi-driver install on the dev cluster (kubectl --context admin@dev) so the GitOps app reproduces it. Run read-only commands only.\n` +
    `Collect: (1) the JUICEFS_IMMUTABLE env on statefulset/juicefs-csi-controller and ds/juicefs-csi-node (container juicefs-plugin); (2) the juicefs-plugin image on both; (3) 'kubectl get csidriver csi.juicefs.com -o json' .spec; (4) the juicefs-wfbcli secret keys in ns jfs-test with passwords REDACTED (decode but mask anything after '://user:' and the secret-key value); (5) any app.kubernetes.io/managed-by or helm labels on the driver objects (was it helm-installed?); (6) the ClusterRole/Role names the driver SA uses (kubectl -n kube-system get clusterrole,role | grep -i juicefs).\n` +
    `Return structured facts; never print full passwords.`,
    { label: 'live-dev', phase: 'Research', schema: LIVE_SCHEMA }
  ),
])

phase('Verify')
const finalSpec = await agent(
  `You are reconciling research into an AUTHORITATIVE, author-ready GitOps spec for a Postgres-backed JuiceFS transcript store on a Talos cluster.\n\n` +
  `CHART RESEARCH:\n${JSON.stringify(chart, null, 2)}\n\n` +
  `BOOTSTRAP RESEARCH:\n${JSON.stringify(bootstrap, null, 2)}\n\n` +
  `LIVE DEV INSTALL (ground truth):\n${JSON.stringify(live, null, 2)}\n\n` +
  `Produce: (a) the FINAL helm.valuesObject YAML for an ArgoCD Application that installs the driver pinned ~v0.31.x with JUICEFS_IMMUTABLE=true on controller+node — it MUST reproduce the live install's behavior; if the chart truly cannot set that env via values, give a complete multi-source helm+kustomize-patch plan instead (in the same string).\n` +
  `(b) the bootstrap Job shell script (idempotent: create juicefs DB+role, derive/persist password without a new secret-store key, write the juicefs-wfbcli Secret with all 6 keys in ns workflow-builder, run juicefs format) + the image that has BOTH juicefs CLI and psql (or an init-container split if no single image has both — state which).\n` +
  `(c) the RBAC YAML: Role+RoleBinding (workflow-builder ns) for the bootstrap Job SA (secrets create/get/patch), PLUS the ClusterRole rule additions letting the sandbox-execution-api SA create/delete persistentvolumes (cluster) and persistentvolumeclaims (namespaced).\n` +
  `(d) the transcriptStore* JSON to merge into the interactive-cli class entry of SANDBOX_EXECUTION_CLASSES_JSON (driver csi.juicefs.com, secret juicefs-wfbcli in workflow-builder, mountPath /sandbox/.transcripts, capacity 10Gi, mountOptions [allow_other]).\n` +
  `Flag any inconsistency between the Helm approach and the live install that needs a human decision. Be exact and conservative — prefer reproducing the proven install.`,
  { label: 'reconcile', phase: 'Verify', schema: FINAL_SCHEMA }
)

return finalSpec
