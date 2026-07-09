export const meta = {
  name: 'phase3-analysis-recon',
  description: 'Ground the Phase 3 Postgres/CloudNativePG analysis in actual manifests: current footprint, consumers, CNPG-in-fleet, backup storage availability',
  phases: [{ title: 'Recon' }],
}

const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'
const WFB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'facts'],
  properties: {
    summary: { type: 'string' },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidence'],
        properties: {
          claim: { type: 'string', description: 'a concrete grounded fact' },
          evidence: { type: 'string', description: 'file:line + the exact value/snippet that proves it' },
        },
      },
    },
  },
}

const tasks = [
  {
    label: 'current-pg-footprint',
    prompt: `In ${STACKS}, find the workflow-builder in-cluster Postgres manifests. Read StatefulSet-postgresql.yaml and Deployment-postgresql-pooler.yaml (search: find . -iname '*postgres*'). 
Report EXACT values: image/tag, replicas, container resources requests AND limits (cpu/memory) for BOTH the postgres statefulset and the pgbouncer pooler, the data PVC size + storageClass (is it local-path/node-pinned or networked/replicated?), any PodDisruptionBudget, and whether the DB password is a hardcoded literal or sourced from a secret. Quote file:line for each. This is the BASELINE we compare CloudNativePG against.`,
  },
  {
    label: 'pg-consumers-and-dbs',
    prompt: `In ${STACKS} and ${WFB}, determine EVERYTHING that durably depends on the single workflow-builder Postgres. 
Specifically: (1) the Dapr Components that use it as a state store — read Component-workflowstatestore.yaml (note actorStateStore + maxConns + connectionString host) and any dapr-agent-py-statestore / agent-workflow components; (2) the app DB (DATABASE_URL) — what host/db name; (3) the JuiceFS 'juicefs' DB (from Job-juicefs-store-bootstrap.yaml — confirm it's the SAME postgres instance, different DB name). 
List the distinct DATABASES on that one instance (workflow_builder, juicefs, others?) and WHAT each holds (Dapr workflow history, agent message lists, app tables, transcript blobs). Quote file:line. Goal: establish that a single PVC loss destroys ALL of these.`,
  },
  {
    label: 'cnpg-in-fleet',
    prompt: `In ${STACKS}, determine whether CloudNativePG is ALREADY deployed anywhere in the hub/ryzen/dev fleet, or whether Phase 3 would introduce it fresh. 
Search broadly: grep -rIl 'cloudnative-pg\\|cloudnativepg\\|cnpg\\|postgresql.cnpg.io\\|kind: Cluster' packages/ ; look for any ArgoCD Application named *cnpg* / *cloudnative*; look at how OTHER stateful services (MLflow, Gitea, Phoenix, Keycloak) run their Postgres — are any already on an operator (Zalando, CNPG, bitnami HA)? Report: is a CNPG operator present (yes/no), any existing Cluster CR + its instances/storage/resources as a sizing reference, and the operator's own resource footprint if deployed. Quote file:line.`,
  },
  {
    label: 'backup-storage-availability',
    prompt: `In ${STACKS}, determine what storage primitives are available that CloudNativePG PITR would need: (1) object storage (S3-compatible: MinIO, SeaweedFS, Rook/Ceph RGW, or a cloud bucket) for WAL archiving + base backups — search 'minio\\|s3\\|seaweedfs\\|objectstore\\|rgw\\|ObjectStore'; (2) what StorageClasses exist and whether any is networked/replicated vs node-local (search 'storageClassName\\|StorageClass\\|local-path\\|longhorn\\|rook\\|ceph\\|topolvm'); (3) any existing VolumeSnapshotClass or scheduled pg_dump/backup CronJobs. 
Report concretely what exists per cluster (hub/ryzen/dev) if distinguishable. This determines whether Phase 3 PITR is even feasible today and how much NEW storage it adds. Quote file:line.`,
  },
]

const results = await parallel(
  tasks.map((t) => () =>
    agent(t.prompt, { label: t.label, phase: 'Recon', schema: SCHEMA, agentType: 'Explore' })
      .then((r) => ({ label: t.label, ...r }))
  )
)

return results.filter(Boolean)
