# Function Templates

This directory contains starter templates for creating custom functions that can be executed by the function-runner service as OCI (container) functions.

## Available Templates

| Language | Directory | Description |
|----------|-----------|-------------|
| TypeScript | `typescript/` | Node.js 22 with TypeScript and Zod validation |
| Python | `python/` | Python 3.12 with Pydantic validation |
| Go | `go/` | Go 1.23 compiled to static binary |

## How Functions Work

1. **Input**: The function receives input via the `INPUT` environment variable (JSON string)
2. **Context**: Additional context is provided via environment variables:
   - `EXECUTION_ID` - Workflow execution ID
   - `WORKFLOW_ID` - Workflow definition ID
   - `NODE_ID` - Node ID in the workflow
   - `NODE_NAME` - Human-readable node name
3. **Credentials**: API keys are injected as environment variables (e.g., `OPENAI_API_KEY`)
4. **Output**: Write JSON to stdout (captured by function-runner)
5. **Logs**: Write to stderr for debugging (not captured as output)

## Creating a Custom Function

### 1. Copy a template

```bash
cp -r function-templates/typescript my-function
cd my-function
```

### 2. Customize the code

Edit `src/index.ts` (or `main.py` / `main.go`):
- Define your input schema
- Implement your logic in the `execute()` function
- Define your output type

### 3. Build the container

```bash
docker build -t my-function:v1 .
```

### 4. Test locally

```bash
# Run with sample input
docker run -e INPUT='{"name":"World"}' my-function:v1

# With credentials
docker run \
  -e INPUT='{"prompt":"Hello"}' \
  -e OPENAI_API_KEY='sk-...' \
  my-function:v1
```

### 5. Push to registry

```bash
docker tag my-function:v1 gitea.cnoe.localtest.me:8443/functions/my-function:v1
docker push gitea.cnoe.localtest.me:8443/functions/my-function:v1
```

### 6. Register in the database

Create a function record in the `functions` table:

```sql
INSERT INTO functions (
  name, slug, description, plugin_id, version,
  execution_type, image_ref,
  input_schema, output_schema,
  timeout_seconds, is_enabled
) VALUES (
  'My Custom Function',
  'custom/my-function',
  'Description of what this function does',
  'custom',
  '1.0.0',
  'oci',
  'gitea.cnoe.localtest.me:8443/functions/my-function:v1',
  '{"type":"object","properties":{"name":{"type":"string"}}}',
  '{"type":"object","properties":{"result":{"type":"string"}}}',
  300,
  true
);
```

## Output Format

Functions should return JSON with at least a `success` field:

```json
{
  "success": true,
  "result": "Your output data"
}
```

Or on error:

```json
{
  "success": false,
  "error": "What went wrong"
}
```

## Best Practices

1. **Validate input** - Use schema validation (Zod, Pydantic, etc.)
2. **Handle errors gracefully** - Always return valid JSON, even on errors
3. **Log to stderr** - Use stderr for debugging, stdout for output only
4. **Exit codes** - Exit 0 on success, non-zero on failure
5. **Timeouts** - Keep functions fast; default timeout is 5 minutes
6. **Stateless** - Functions should be stateless and idempotent
7. **Small images** - Use multi-stage builds for smaller container images

## Example: OpenAI Chat Function

```typescript
const InputSchema = z.object({
  prompt: z.string(),
  model: z.string().default("gpt-4o"),
});

async function execute(input: Input): Promise<Output> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { success: false, error: "OPENAI_API_KEY not set" };
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      messages: [{ role: "user", content: input.prompt }],
    }),
  });

  const data = await response.json();
  return {
    success: true,
    result: data.choices[0].message.content,
  };
}
```
