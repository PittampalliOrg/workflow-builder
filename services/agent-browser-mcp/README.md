# agent-browser-mcp

Vercel's [agent-browser](https://github.com/vercel-labs/agent-browser) CLI exposed as a
**streamable-HTTP MCP server**, so the platform's non-CLI agents (`dapr-agent-py`, including
Kimi K3 vision agents) can drive a real Chrome browser through their `config.mcpServers`.
Screenshot results retain their raw MCP image blocks for model vision, while screenshot /
video / PDF / HAR artifacts are **deterministically persisted to the owning workflow run**.

## Why a service (not in the agent image)

agent-browser is a Rust CLI that controls Chrome over CDP and speaks MCP over **stdio**
(`agent-browser mcp`). Our dapr-agent-py agents attach MCP tools over HTTP
(`transport: streamable_http`), and Chrome + its libraries are heavy. The bridge keeps that
runtime out of the agent image. In-cluster workflow executions lease an isolated browser from
BrowserStation; pod-local Chrome is only the fallback when no farm is configured.

```
dapr-agent-py agent  --(streamable_http MCP)-->  agent-browser-mcp :8000/mcp
                                                   └─ bridge.mjs (HTTP↔stdio MCP proxy
                                                      + artifact persistence + auto-capture)
                                                        └─ agent-browser mcp  (stdio JSON-RPC)
                                                             └─ BrowserStation lane (CDP)
```

## The bridge (`bridge.mjs`)

One agent-browser child process per MCP session (state — the open page, its `@refs` —
persists across calls within the session). On top of plain proxying it adds:

1. **Artifact persistence.** The files agent-browser writes (screenshots, WebM recordings,
   PDFs, HARs, traces) exist only on this pod. The BFF stamps the owning run onto the
   `mcpServers` entry as `X-Wfb-Execution-Id` / `X-Wfb-Workflow-Id` / `X-Wfb-Node-Id`
   headers; after every artifact-producing tool call the bridge reads the produced file and
   POSTs it to `/api/internal/browser-artifacts`. They render on the run page's **Browser**
   tab (screenshots + video inline, PDF/HAR as downloads).
2. **Auto-capture.** The bridge is itself an MCP client of the child, so it starts a network
   HAR and a WebM video recording right after the agent's first successful
   `agent_browser_open`, and stops + persists both when the agent calls
   `agent_browser_close` (or after `AGENT_BROWSER_AUTO_CAPTURE_IDLE_MS` of inactivity, or on
   session teardown). LLMs — especially smaller ones — reliably stall on choreographing
   `record_start`/`record_stop` pairs; taking capture out of the LLM's hands entirely makes
   video + HAR unconditional.
3. **Curated tool surface.** The child runs the full `core,network,debug` profiles (the
   bridge needs the record/HAR tools), but `tools/list` shown to the LLM is filtered to a
   small action set (`AGENT_BROWSER_EXPOSED_TOOLS`, default 19 tools) with schemas pruned
   to the properties that matter (`url`, `selector`, `text`, `path`, …). 77 tools × a dozen
   plumbing props each measurably degraded small-model tool choice. Calls to unlisted tools
   still pass through — filtering only trims discovery.

4. **Demo scenes + auto-editor.** A bridge-implemented virtual tool `demo_scene`
   ({title, caption, focus?}) lets the agent mark scene boundaries with ONE semantic
   call — the bridge translates it to `record_restart` + scene metadata. When the run
   closes, the titled scene clips are auto-edited into a single **demo MP4**
   (`render.mjs`): freezedetect cuts the dead time between actions, footage is sped up
   (capped 2.5×) to fit `DEMO_TARGET_SECONDS` (default 75s), every scene gets a
   lower-third title/caption band and a Scene N/M badge, and a title card + end card
   frame the video. Untitled footage (e.g. recon wandering before the first
   `demo_scene`) never ships in a demo. Runs that never call `demo_scene` keep the
   plain raw session video (previous behavior).

5. **Target-auth (authenticated demos of your own app).** To demo an app that
   requires login, the run's owning session forwards two headers on the browser
   MCP entry: `X-Wfb-Target-Auth` (`<cookieName>=<value>`, or `Bearer <token>`)
   and `X-Wfb-Target-Auth-Host` (the one host it may be presented to). The first
   time the agent opens a page on that host, the bridge plants the credential
   (cookie via `cookies_set`, or an `Authorization` header) and re-opens so the
   agent — and the recorder — see the authenticated app. The credential is
   **host-scoped**: it is never attached to any other origin the browser visits,
   never entered into a login form, and never passed through the LLM or the run
   trace. Intended for apps the run owner controls; it is not a way past
   third-party bot-detection or CAPTCHAs (those are respected, not bypassed).

6. **Execution-scoped browser lifecycle.** Any MCP session carrying
   `X-Wfb-Execution-Id` leases a BrowserStation lane when the farm is configured, independent
   of the optional per-node header. Explicit `agent_browser_close` releases it immediately;
   idle auto-capture cleanup persists the pending artifacts and then closes the abandoned
   browser. This keeps browser processes isolated per workflow run and prevents Chrome
   processes from accumulating in the bridge pod.

## Endpoint

- MCP endpoint: `http://agent-browser-mcp.workflow-builder.svc.cluster.local:8000/mcp`
- Health: `GET /healthz`

## Attaching it to an agent

```jsonc
// agent config.mcpServers — NOTE: server name must be [A-Za-z0-9_] (no hyphens),
// dapr-agent-py presents tools as {server}_{tool} and LLM function-calling
// rejects hyphenated names.
[{ "name": "browser",
   "transport": "streamable_http",
   "url": "http://agent-browser-mcp.workflow-builder.svc.cluster.local:8000/mcp",
   "headers": {
     "X-Wfb-Target-Auth-Host": "workflow-builder.workflow-builder.svc.cluster.local"
   } }]
```

BrowserStation workers run in `ray-system`, so browser targets in another
namespace must also use a cross-namespace service FQDN, for example
`http://workflow-builder.workflow-builder.svc.cluster.local:3000`. When creating
the agent through Workflow MCP, provide that hostname as the MCP entry's
`target_auth_host`; the adapter writes the host restriction, while the BFF mints
and injects the actual credential only for the execution.

The agent then calls `browser_agent_browser_open`, `browser_agent_browser_snapshot`, etc.
Screenshots and PDFs it takes, plus the automatic video + HAR, land on the run's Browser tab.

## Vision contract

- `agent_browser_screenshot` returns a structured MCP `image` block with base64 bytes. The
  bridge forwards that result unchanged to the agent and separately persists a copy as a run
  artifact. Kimi K3 therefore receives the pixels, not a JSON string describing the file.
- `agent_browser_snapshot` and `agent_browser_get_text` remain available for accessibility-tree
  refs, exact text, and deterministic assertions. They do not replace screenshots for layout,
  color, clipping, spacing, responsive behavior, or any other visual judgment.
- The service intentionally exposes no OCR, image-caption, screenshot-description, or visual
  analysis proxy action. Visual interpretation belongs to the model.

## Env

| var | default | meaning |
| --- | --- | --- |
| `PORT` | `8000` | HTTP port for the MCP endpoint |
| `AGENT_BROWSER_TOOLS` | `core,network,debug` | tool profiles the **child** runs (record/HAR live in debug/network) |
| `AGENT_BROWSER_EXPOSED_TOOLS` | 19 curated tools | comma list shown to the LLM in `tools/list`; empty = expose everything |
| `AGENT_BROWSER_AUTO_CAPTURE` | `video,har` | what the bridge records automatically; empty disables |
| `AGENT_BROWSER_AUTO_CAPTURE_IDLE_MS` | `300000` | stop+persist recordings after this idle gap (agent abandoned the session) |
| `WORKFLOW_BUILDER_URL` | in-cluster BFF | artifact sink base URL |
| `INTERNAL_API_TOKEN` | _(unset)_ | internal token for `/api/internal/browser-artifacts` |
| `AGENT_BROWSER_ENCRYPTION_KEY` | _(unset)_ | optional; encrypts saved auth state |
| `DEMO_TARGET_SECONDS` | `75` | target length of the rendered demo video |
| `DEMO_MAX_SPEEDUP` | `2.5` | cap on the uniform speed-up used to fit the target |
| `DEMO_FREEZE_MIN_S` | `1.4` | static span length that counts as dead time |
| `AGENT_BROWSER_TOOLS` includes `state` | for the bridge's own `cookies_set` (target-auth) |  |

## Related: the agent-browser skill

For **CLI** agents (claude-code/codex/agy) the native integration is the Bash-based
agent-browser *skill* (`agent-browser skills get core`), not this MCP service. This service is
specifically for MCP-consuming (non-CLI) agents.
