# Workflow Builder Hexagonal Architecture

Status: 2026-07-04, after the strict workflow-data cutover.

This diagram represents the current target shape of the workflow-builder system:
business use cases live behind application ports, infrastructure is hidden behind
adapters, and cross-service orchestration persistence enters workflow-builder
through Dapr service invocation and the internal workflow-data API.

## System Shape

```mermaid
flowchart LR
  browser[Browser UI]
  webhooks[Webhooks and API clients]
  mcp[MCP and tool clients]
  gitops[GitOps and admin operators]

  subgraph inbound[Inbound adapters]
    ui[SvelteKit routes and UI loaders]
    api[Public API routes]
    internal[Internal workflow-data routes]
    auth[Auth and session routes]
    mcpRoutes[MCP gateway routes]
  end

  subgraph core[Workflow-builder application core]
    workflowDefinitions[Workflow definition services]
    executionControl[Workflow execution control]
    workflowData[Workflow-data application service]
    lifecycle[Lifecycle and session services]
    connections[Connections, auth, and MCP services]
    reporting[Benchmarks, usage, and read models]
  end

  subgraph ports[Application ports]
    workflowRepos[Workflow definition repository]
    executionRepos[Execution read/write model]
    lineageRepos[Artifacts, plans, workspaces, and agent runs]
    sessionRepos[Session and lifecycle repositories]
    connectionRepos[Connection and MCP repositories]
    schedulerPort[Durable scheduler/control port]
    runtimePort[Runtime and tool dispatch ports]
    telemetryPort[Telemetry and reporting ports]
  end

  subgraph adapters[Outbound infrastructure adapters]
    postgres[(Postgres via Drizzle adapters)]
    daprWorkflow[Dapr Workflow]
    daprInvoke[Dapr service invocation]
    daprPubsub[Dapr pub/sub]
    daprState[(Dapr state: workflowstatestore)]
    functionRouter[Function router and piece runtimes]
    sandboxes[Kueue, agent-sandbox, and OpenShell]
    observability[OpenTelemetry and ClickHouse]
    gitopsAdapters[GitOps inventory and promoter adapters]
  end

  browser --> ui
  webhooks --> api
  mcp --> mcpRoutes
  gitops --> api

  ui --> core
  api --> core
  auth --> core
  mcpRoutes --> core
  internal --> workflowData

  core --> ports

  workflowRepos --> postgres
  executionRepos --> postgres
  lineageRepos --> postgres
  sessionRepos --> postgres
  connectionRepos --> postgres
  schedulerPort --> daprWorkflow
  schedulerPort --> daprInvoke
  runtimePort --> daprInvoke
  runtimePort --> functionRouter
  runtimePort --> sandboxes
  telemetryPort --> observability
  telemetryPort --> gitopsAdapters
  daprWorkflow --> daprState
  daprPubsub --> daprState

  classDef external fill:#eef6ff,stroke:#4e79a7,color:#102a43
  classDef adapter fill:#f7f7f7,stroke:#777,color:#222
  classDef core fill:#fff4d6,stroke:#c98b00,color:#2b1b00
  classDef port fill:#edf7ed,stroke:#3b873e,color:#0f2f11
  classDef infra fill:#fcecec,stroke:#c44e52,color:#3b0b0b

  class browser,webhooks,mcp,gitops external
  class ui,api,internal,auth,mcpRoutes adapter
  class workflowDefinitions,executionControl,workflowData,lifecycle,connections,reporting core
  class workflowRepos,executionRepos,lineageRepos,sessionRepos,connectionRepos,schedulerPort,runtimePort,telemetryPort port
  class postgres,daprWorkflow,daprInvoke,daprPubsub,daprState,functionRouter,sandboxes,observability,gitopsAdapters infra
```

## Orchestration Persistence Boundary

The Python workflow-orchestrator no longer owns runtime persistence in strict
mode. It calls workflow-builder through the workflow-data port over Dapr service
invocation. Postgres remains the first persistence adapter, but it is behind the
workflow-builder application boundary.

```mermaid
sequenceDiagram
  autonumber
  participant User as Browser or webhook
  participant BFF as workflow-builder BFF
  participant App as Application services
  participant Dapr as Dapr workflow runtime
  participant Orch as workflow-orchestrator
  participant WDC as workflow_data_client
  participant Internal as workflow-data internal API
  participant Repo as Application ports
  participant PG as Postgres adapter
  participant Runtime as Function router or agent runtime

  User->>BFF: Start or control workflow
  BFF->>App: Validate request and workspace scope
  App->>Repo: Create execution/read-model row
  Repo->>PG: Persist through adapter
  App->>Dapr: Schedule durable workflow
  Dapr->>Orch: Run workflow activity graph
  Orch->>WDC: Persist logs, phase, artifacts, plans, workspaces, agent runs
  WDC->>Internal: Dapr service invocation to workflow-builder
  Internal->>App: Execute workflow-data use case
  App->>Repo: Use application-owned DTOs and ports
  Repo->>PG: Persist through Postgres adapter
  Orch->>Runtime: Dispatch action or child workflow through Dapr
  Runtime-->>Orch: Return normalized result
  Orch->>WDC: Final status and result update
```

Strict mode invariant:

- `WORKFLOW_DATA_API_MODE=http` uses workflow-data over Dapr and does not fall
  back to direct Postgres access.
- `http-fallback-db` and rollback paths are documented separately from the
  runtime path.
- Legacy `app.py` helper behavior remains isolated from migrated runtime
  activities.

## vCluster Preview Isolation

Preview environments use the same ports and adapters as shared environments, but
they run with isolated infrastructure and strict workflow-data mode so portability
problems surface before promotion.

```mermaid
flowchart TB
  subgraph gitopsLane[GitOps lane]
    main[workflow-builder and stacks main]
    images[GHCR git-sha images]
    pins[Release and workload image pins]
  end

  subgraph preview[vCluster preview environment]
    previewBff[workflow-builder]
    previewOrch[workflow-orchestrator]
    previewRouter[function-router]
    previewDapr[Dapr sidecars and components]
    previewState[(workflowstatestore actor state)]
    previewDb[(preview Postgres)]
    previewNats[(preview NATS)]
    smoke[strict smoke job]
  end

  subgraph dev[Dev cluster rollout]
    devBff[workflow-builder]
    devOrch[workflow-orchestrator]
    devDapr[Dapr sidecars and components]
    devState[(workflowstatestore actor state)]
    devDb[(dev Postgres)]
  end

  main --> images
  images --> pins
  pins --> previewBff
  pins --> previewOrch
  pins --> previewRouter
  pins --> devBff
  pins --> devOrch

  smoke --> previewBff
  smoke --> previewOrch
  previewBff --> previewDapr
  previewOrch --> previewDapr
  previewDapr --> previewState
  previewBff --> previewDb
  previewBff --> previewNats

  devBff --> devDapr
  devOrch --> devDapr
  devDapr --> devState
  devBff --> devDb

  classDef source fill:#eef6ff,stroke:#4e79a7,color:#102a43
  classDef previewClass fill:#fff4d6,stroke:#c98b00,color:#2b1b00
  classDef devClass fill:#edf7ed,stroke:#3b873e,color:#0f2f11
  classDef store fill:#fcecec,stroke:#c44e52,color:#3b0b0b

  class main,images,pins source
  class previewBff,previewOrch,previewRouter,previewDapr,smoke previewClass
  class devBff,devOrch,devDapr devClass
  class previewState,previewDb,previewNats,devState,devDb store
```

## Current Invariants

- UI routes are presentation adapters. Business rules, persistence decisions, and
  infrastructure calls belong in application services and adapters.
- Orchestrator runtime persistence enters through workflow-data over Dapr service
  invocation.
- Drizzle schema types stay inside Postgres adapter code.
- The single visible Dapr actor state store is `workflowstatestore`.
- Postgres is retained as the first adapter, not as a service-to-service
  coupling contract.
- vCluster preview smoke tests run in strict HTTP/Dapr mode before GitOps
  promotion.
