# workflow-data contract fixtures

Shared wire-level contract for the `/api/internal/workflow-data` boundary — the
strict-mode persistence API between the **workflow-orchestrator** (Python,
`activities/workflow_data_client.py`, Dapr invoke → app-id `workflow-builder`)
and the **BFF routes** (`src/routes/api/internal/workflow-data/**/+server.ts`).

One JSON fixture per endpoint/client-method pairing (22 fixtures covering all
19 route files). Each fixture is a concrete example of a request/response
exchange:

```jsonc
{
	"description": "...",                       // which client method this pins
	"method": "POST",                           // HTTP verb
	"pathTemplate": "/api/internal/workflow-data/executions/{executionId}",
	"path": "/api/internal/workflow-data/executions/exec-1", // concrete example (incl. query)
	"pathParams": { "executionId": "exec-1" },  // SvelteKit route params for the example
	"queryParams": { "by": "id" },              // optional
	"requestBody": { ... } | null,              // exactly what the client sends
	"responseBody": { ... }                     // envelope the client parses
}
```

## Consumers (both must stay green)

- **TS**: `src/routes/api/internal/workflow-data/workflow-data-contract.test.ts`
  replays each fixture request against the real route handler (application port
  mocked) and asserts the response **superset-matches** `responseBody` — extra
  keys are allowed, missing/renamed keys fail.
- **Python**: the contract section of
  `services/workflow-orchestrator/tests/test_workflow_data_activity_migration.py`
  drives `WorkflowDataClient` with a fixture-fed HTTP stub and asserts the
  client emits exactly `method` + `path` + `requestBody`, and parses
  `responseBody` to the expected return value.

## Contract rules

1. **Additive-only.** New optional request fields and new response keys are
   fine. Removing or renaming a field, changing a path, or changing an
   envelope key (`execution`, `workflow`, `ok`, `log`, `targets`, …) is a
   breaking change.
2. **Breaking changes migrate both sides in one PR**: the route(s), the Python
   client/activities, and the fixture — never the fixture alone.
3. **Fixtures are the source of truth.** If a suite disagrees with a fixture,
   fix the code or make a deliberate, reviewed fixture change — both suites
   consume these files directly; there is no second copy to drift.
