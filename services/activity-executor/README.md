# Activity Executor Service

A Node.js/TypeScript microservice that enables Dapr workflows to execute all 35+ existing plugin step handlers from the workflow-builder UI.

## Architecture

```
┌─────────────────────────┐     ┌─────────────────────────────────────────┐
│  Next.js (BFF Proxy)    │     │  Kubernetes Cluster                     │
│  - UI + API routes      │     │                                         │
│  - No Dapr sidecar      │     │  ┌─────────────────────────────────┐   │
└────────────┬────────────┘     │  │  activity-executor (Node.js)   │   │
             │                  │  │  POST /execute                  │   │
             │                  │  │  - Reuses existing step handlers│   │
             │                  │  │  - DB access for credentials    │   │
             │                  │  │  - Template resolution          │   │
             │                  │  └───────────────▲─────────────────┘   │
             │                  │                  │ Dapr Service Invoke  │
             │                  │  ┌───────────────┴─────────────────┐   │
             └──────────────────┼──▶  workflow-orchestrator (Python)  │   │
                                │  │  - Dapr Workflow runtime        │   │
                                │  │  - Calls activity-executor      │   │
                                │  └─────────────────────────────────┘   │
                                └─────────────────────────────────────────┘
```

## API Endpoints

### POST /execute

Execute a workflow step/activity.

**Request:**
```json
{
  "activity_id": "slack/send-message",
  "execution_id": "exec-123",
  "workflow_id": "wf-456",
  "node_id": "node-789",
  "node_name": "Send Notification",
  "input": {
    "slackChannel": "#general",
    "slackMessage": "Hello from {{@prev:Generate Text.text}}"
  },
  "node_outputs": {
    "prev": { "label": "Generate Text", "data": { "text": "AI response" } }
  },
  "integration_id": "int_abc123"
}
```

**Response:**
```json
{
  "success": true,
  "data": { "ts": "1234567890.123456", "channel": "C0123456789" },
  "duration_ms": 250
}
```

### GET /activities

List all available activities.

### GET /health

Liveness probe - returns 200 if service is running.

### GET /ready

Readiness probe - returns 200 if database connection is working.

## Development

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Type check
pnpm type-check

# Build for production
pnpm build
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `INTEGRATION_ENCRYPTION_KEY` | 64-char hex key for AES-256-GCM | Yes |
| `PORT` | Server port (default: 8080) | No |
| `HOST` | Server host (default: 0.0.0.0) | No |
| `LOG_LEVEL` | Logging level (default: info) | No |

## Docker

```bash
# Build from repo root
docker build -f services/activity-executor/Dockerfile -t activity-executor .

# Run
docker run -p 8080:8080 \
  -e DATABASE_URL=postgres://... \
  -e INTEGRATION_ENCRYPTION_KEY=... \
  activity-executor
```

## Kubernetes Deployment

The service is designed to run with a Dapr sidecar in Kubernetes:

```yaml
annotations:
  dapr.io/enabled: "true"
  dapr.io/app-id: "activity-executor"
  dapr.io/app-port: "8080"
```

The Python orchestrator calls this service via Dapr service invocation:

```python
async def execute_step(ctx: WorkflowActivityContext, input: dict) -> dict:
    async with httpx.AsyncClient() as client:
        response = await client.post(
            "http://localhost:3500/v1.0/invoke/activity-executor/method/execute",
            json=input
        )
        return response.json()
```

## How It Works

1. **Request received** - The Python orchestrator sends an execution request
2. **Validate** - Request is validated using Zod schemas
3. **Fetch credentials** - If `integration_id` is provided, credentials are fetched from the database and decrypted
4. **Resolve templates** - Template variables like `{{@nodeId:Label.field}}` are resolved using `node_outputs`
5. **Load step** - The step module is dynamically imported from `plugins/{integration}/steps/{stepImportPath}`
6. **Execute** - The step function is called with resolved input and credentials
7. **Return result** - Result is normalized and returned with timing information

## Reused Code

The service reuses these modules from the main workflow-builder app via path aliases:

- `lib/utils/template.ts` - Template variable resolution
- `lib/db/schema.ts` - Drizzle ORM schema
- `plugins/registry.ts` - Plugin registration and lookup
- `plugins/*/steps/*.ts` - All 35+ step handler implementations
