# agent-browser-mcp

Vercel's [agent-browser](https://github.com/vercel-labs/agent-browser) CLI exposed as a
**streamable-HTTP MCP server**, so the platform's non-CLI agents (`dapr-agent-py`, e.g. a
GLM 5.2 browser agent) can drive a real Chrome browser through their `config.mcpServers` —
with the artifacts the browser produces (screenshot / video / PDF / HAR) **deterministically
persisted to the owning workflow run**.

## Why a service (not in the agent image)

agent-browser is a Rust CLI that controls Chrome for Testing over CDP and speaks MCP over
**stdio** (`agent-browser mcp`). Our dapr-agent-py agents attach MCP tools over HTTP
(`transport: streamable_http`), and Chrome + its libraries are heavy. Running agent-browser
as its own service keeps Chrome isolated in one image and leaves the agent image untouched —
any agent can gain browser tools just by pointing `mcpServers` at this endpoint.

```
dapr-agent-py agent  --(streamable_http MCP)-->  agent-browser-mcp :8000/mcp
                                                   └─ bridge.mjs (HTTP↔stdio MCP proxy
                                                      + artifact persistence + auto-capture)
                                                        └─ agent-browser mcp  (stdio JSON-RPC)
                                                             └─ Chrome for Testing (CDP, headless)
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
   small action set (`AGENT_BROWSER_EXPOSED_TOOLS`, default 11 tools: open, snapshot, click,
   fill, scroll, screenshot, get_text, get_url, get_title, pdf, close) with schemas pruned
   to the properties that matter (`url`, `selector`, `text`, `path`, …). 77 tools × a dozen
   plumbing props each measurably degraded small-model tool choice (observed: GLM 5.2
   stall-looping). Calls to unlisted tools still pass through — filtering only trims
   discovery.

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
   "url": "http://agent-browser-mcp.workflow-builder.svc.cluster.local:8000/mcp" }]
```

The agent then calls `browser_agent_browser_open`, `browser_agent_browser_snapshot`, etc.
Screenshots and PDFs it takes, plus the automatic video + HAR, land on the run's Browser tab.

## Env

| var | default | meaning |
| --- | --- | --- |
| `PORT` | `8000` | HTTP port for the MCP endpoint |
| `AGENT_BROWSER_TOOLS` | `core,network,debug` | tool profiles the **child** runs (record/HAR live in debug/network) |
| `AGENT_BROWSER_EXPOSED_TOOLS` | 11 curated tools | comma list shown to the LLM in `tools/list`; empty = expose everything |
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
