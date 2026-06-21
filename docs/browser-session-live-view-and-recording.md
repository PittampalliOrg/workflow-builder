# Browser Session Live View & Recording (Playwright-MCP evaluator/critic)

**Status:** design / options evaluation (no implementation yet)
**Scope:** how to (a) show the user the browser **live** while a Playwright-MCP agent (e.g. the design critic/evaluator) drives it, and/or (b) **persist a replayable recording** as a workflow artifact — optimised for efficiency/performance.

This doc compares the credible industry patterns against our existing architecture and gives a recommendation. It deliberately does **not** prescribe a full implementation plan — it is the "current system + options + pros/cons + recommendation" artifact.

---

## 1. The problem

When the critic agent drives a real Chromium via `@playwright/mcp` (the Playwright-MCP design critic), the run looks like a stream of `agent.tool_use`/`tool_result` events with the occasional screenshot. The user can't *see* the browser being driven, and once the run ends there's no replayable record of what the agent actually saw and did. Two separable capabilities:

- **A. Live view** — watch the agent drive, in real time, during the run.
- **B. Persisted recording** — a replayable artifact (video / trace) attached to the run, viewable after the fact.

Credible products implement both, with **different** technology for each — don't conflate them.

---

## 2. What we already have (current architecture)

| Concern | Today | Files |
| --- | --- | --- |
| **Browser** | Headless Chromium **sidecar** (CDP on pod-local `:9222`) + `playwright-mcp` (MCP on pod-local `:3100/mcp`), injected when `requiresBrowserSidecars`/Playwright MCP preset matches. Runs in `openshell` ns. CLI family runs `@playwright/mcp` over stdio with in-pod Chromium instead. | `src/lib/server/agents/mcp-sidecar.ts`, `runtime-registry.data.json` |
| **Live view (exists!)** | A **1 fps screenshot poll**: `browser-state-panel.svelte` polls `GET /api/v1/sessions/[id]/browser/screenshot` (1 s, raw JPEG) + `/browser/state` (2 s; url/title/console tail). Each screenshot is an **MCP `browser_take_screenshot` call** through the BFF MCP client (single cached session/slug, 60 s TTL — calls serialize). | `browser-state-panel.svelte`, `playwright-mcp-client.ts`, `routes/api/v1/sessions/[id]/browser/{screenshot,state}` |
| **Screenshot artifacts** | `browser/validate` capture-flow → `workflow_browser_artifacts` (+ `_blob_payloads`), `capture_flow_v1`. | `browser-artifacts.ts`, `services/openshell-sandbox/Dockerfile` |
| **Recording schema (half-built)** | `workflow_browser_artifacts` asset kinds **already include `screenshot \| trace \| video \| video-annotated \| caption`**, content-type `video/webm`, blob storage refs. **No capture path and no UI renderer for video/trace yet.** | `browser-artifacts.ts:~30` |
| **Generic artifacts** | `workflow_artifacts` (inline ≤256 KB or `file_id`); renderer handles `markdown/json/text/table/image/link/card/html/goal_spec` — **no `video` kind**. Files API: SHA-1 dedup, **25 MB cap**. | `workflow-artifacts.ts`, `artifact-renderer.svelte`, `schema.ts` |
| **Live data bus** | `session_events` append-only + Postgres LISTEN/NOTIFY → SSE `/api/v1/sessions/[id]/events/stream`; Run Console renders it live. | `session-stream.svelte.ts`, `run-console.svelte` |
| **Encoder** | **`ffmpeg` already installed** in `openshell-agent-runtime` image (currently unused). | `services/openshell-sandbox` Dockerfile |

**Two constraints that shape every option:**
1. **The browser is behind the sandbox.** Chromium CDP (`:9222`) is **pod-local**; only the `playwright-mcp` MCP endpoint is reached from the BFF. Any pixel/CDP stream must be **proxied out of the pod** (mirror the existing live-preview proxy pattern), not connected to directly.
2. **MCP screenshots serialize.** The current live view re-issues a full-page screenshot per second through a single cached MCP session — it competes with the agent's own tool calls and won't scale past a few fps.

---

## 3. Credible external references

- **Browserbase Live View** (the de-facto reference for agent browsers): an **`<iframe>` backed by a CDP screencast over WebSocket** (`debuggerUrl`/`debuggerFullscreenUrl`). Read-only via `pointer-events:none`; interactive mode enables human-in-the-loop (CAPTCHA/2FA/file-upload handoff). Their **session replay** also moved from DOM-based to a **CDP screencast** capture "because it records what the browser actually renders" — deterministic and accurate.
- **Vercel `agent-browser`**: same screencast + live-preview pattern.
- **Anthropic computer-use**: streams a whole desktop via **VNC/noVNC** (because it controls a full GUI, not just a tab).
- **PostHog / Sentry / Datadog session replay**: **rrweb** (DOM-mutation JSON, not pixels).
- **Playwright**: first-class **`recordVideo` (.webm)** and **trace (`trace.zip`) → Trace Viewer**; `@playwright/mcp` exposes `browser_start_video`/`browser_stop_video`/`browser_video_chapter` and `browser_start_tracing`/`browser_stop_tracing` (require the `devtools` cap / `--save-video`).

---

## 4. Option set — LIVE VIEW

### L0. Keep screenshot polling (status quo), maybe tune
- **+** Already works; zero new infra; trivially read-only; works wherever MCP works (incl. CLI stdio browsers).
- **−** ~1 fps ceiling; each frame is a full MCP round-trip that **serializes with the agent's own tool calls** (can slow the agent); re-encodes/transfers a whole JPEG each tick; choppy.
- **Efficiency:** poor at >1–2 fps; fine as a universal fallback.

### L1. CDP `Page.startScreencast` → WebSocket → UI  ⭐ recommended live path
The chromium sidecar pushes JPEG frames over its CDP WebSocket; a tiny in-pod proxy (or the `playwright-mcp` container) relays them out of the pod; the BFF proxies to the browser; the UI paints into a `<canvas>`/`<img>`.
- **+** Industry standard (Browserbase/Vercel). **~70 fps achievable vs ~5 fps for screenshot polling**; JPEG quality/scale **tunable** to trade bandwidth for smoothness; single tab (no desktop overhead); **doesn't go through the agent's MCP session** so it doesn't contend with the agent loop; read-only by construction (we never forward input).
- **−** Needs a frame proxy out of the pod (CDP `:9222` is pod-local) + a small UI canvas renderer; multi-tab needs target selection.
- **Efficiency:** best pixel-accurate live option. **Gate it on-demand** — only screencast while a viewer is actually watching (panel open / WS subscribed), like the current poll already stops when the panel closes. Zero cost when unobserved.

### L2. rrweb (DOM-event stream)
- **+** Tiny bandwidth (~1–5 MB/30 min), low CPU, naturally scrubbable; same stream serves live + replay.
- **−** **Reconstructs the DOM** → lossy for `<canvas>`, cross-origin iframes, `<video>`, complex CSS; needs **script injection** into every page. A design critic visits **arbitrary** sites → high chance of visual divergence from what the agent saw. Undermines "show the real browser."
- **Efficiency:** unbeatable on bytes, but **wrong fidelity** for a general-web critic. Only attractive if we controlled the page (we don't).

### L3. VNC / noVNC (stream the desktop)
- **+** Dead simple conceptually; enables true interactive takeover; the computer-use pattern.
- **−** Requires a **headed** browser + Xvfb + VNC server (we run headless); tuned for interactivity, **not** low-latency passive viewing; heaviest CPU/bandwidth; streams the whole desktop, not just the tab.
- **Efficiency:** worst fit for headless Playwright. Only revisit if we move toward computer-use-style GUI control.

---

## 5. Option set — PERSISTED RECORDING

### R1. Playwright-native video (`recordVideo` / `@playwright/mcp browser_start_video`) → `.webm`  ⭐ recommended persisted path
- **+** **Protocol-level capture** in the browser process — works identically headless, **no external tooling**, near-zero extra cost, matches viewport. Lands as a `.webm`. **Our `workflow_browser_artifacts` schema already has the `video` kind + `video/webm` content-type** — capture in-pod, upload, done. `@playwright/mcp` can even be driven by the agent (`browser_start_video`).
- **−** Whole-session video can be large → likely exceeds the **25 MB files cap** (raise the cap for video, or store via the browser-artifact blob path which already exists); need a `<video>` UI renderer (the one gap). Less granular than a trace for "why did this fail."
- **Efficiency:** cheapest faithful recording. **Retain-on-completion / on-interesting**, never per-step.

### R2. Playwright trace (`browser_start_tracing`) → `trace.zip` → Trace Viewer
- **+** Richest: DOM snapshots (before/after each action) + action timeline + network + console + screenshots; time-travel debugging; `@playwright/mcp` supports it.
- **−** Bigger than video; needs the **Trace Viewer** to render (host `trace.viewer` or deep-link to `trace.playwright.dev`); more than most reviewers need.
- **Efficiency:** great value-per-byte for **debugging failures**; offer as an **opt-in richer tier**, not the default.

### R3. CDP screencast frames → `ffmpeg` → `.mp4`
- **+** Reuses the L1 frame source; `ffmpeg` **already in the image**; mp4 plays everywhere; one stream can feed both live (L1) and the recording.
- **−** Extra encode step + CPU during the run; we own muxing/timing; Playwright-native video (R1) gives the same result for less work.
- **Efficiency:** attractive **only** if we build L1 anyway and want one pipeline for live+record. Otherwise R1 wins.

### R4. rrweb JSON recording
- **+** Tiny, scrubbable, same caveats/benefits as L2.
- **−** Same fidelity loss as L2 for a general-web critic.
- **Efficiency:** smallest artifact, **wrong fidelity** here.

---

## 6. Comparison at a glance

**Live view**

| Option | Fidelity | ~Max fps | Bandwidth | CPU on run | Contends w/ agent? | New infra | Fit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L0 screenshot poll (today) | exact | ~1–2 | high/frame | med (MCP) | **yes** | none | fallback |
| **L1 CDP screencast** | **exact** | **~70** | tunable | low–med | **no** | frame proxy + canvas | **recommended** |
| L2 rrweb | lossy | n/a (DOM) | very low | low–med | no | rrweb + replayer | poor (arbitrary sites) |
| L3 noVNC | exact (desktop) | med | high | high | no | headed+Xvfb+VNC | poor (headless) |

**Persisted recording**

| Option | Fidelity | Size | Capture cost | Renderer needed | Reuses our schema | Fit |
| --- | --- | --- | --- | --- | --- | --- |
| **R1 Playwright `.webm`** | exact | med | ~none (protocol) | `<video>` (gap) | **yes (`video` kind)** | **recommended default** |
| R2 trace → Trace Viewer | exact + DOM/net/console | large | low | Trace Viewer host/link | yes (`trace` kind) | opt-in debug tier |
| R3 CDP→ffmpeg mp4 | exact | med | med (encode) | `<video>` | yes | only if L1 built |
| R4 rrweb JSON | lossy | tiny | low | rrweb player | no | poor here |

---

## 7. Recommendation

Treat live and persisted as two tiers that share as much as possible, and lean on what already exists.

1. **Persisted (do first — highest value/effort ratio):** **R1 — Playwright-native `.webm`.** The capture is essentially free (protocol-level), `@playwright/mcp` already exposes `browser_start_video`, and **`workflow_browser_artifacts` already models the `video` kind**. The only real work is (a) enabling capture for the critic's browser context and uploading the `.webm` (raise/relieve the 25 MB cap for video, or use the existing browser-artifact blob path), and (b) a `<video>` renderer in the artifacts UI. **Retain-on-completion / on-interesting**, not per-step. Add **R2 (trace)** as an opt-in richer tier for failed/contested evaluations.

2. **Live (do second):** **L1 — on-demand CDP `Page.startScreencast`**, read-only, proxied out of the pod (reuse the live-preview proxy), painted into a `<canvas>` — replacing the 1 fps screenshot poll (keep L0 as the universal fallback, esp. for CLI stdio browsers). **Critical efficiency rule: only stream while a viewer is connected** (mirror today's "poll stops when panel closes"), so we pay nothing when unobserved, and the screencast runs off CDP rather than through the agent's MCP session.

3. **If we ever want one pipeline for both**, R3 (screencast→ffmpeg, ffmpeg already present) lets the same CDP frame source feed live **and** the persisted mp4 — but only worth it once L1 exists; until then R1 is strictly less work.

**Explicitly not recommended as primary:** rrweb (lossy for a critic on arbitrary/canvas/cross-origin pages) and noVNC (needs a headed browser; heaviest) — revisit noVNC only if we pivot to computer-use-style GUI control.

---

## 8. Open questions / constraints to resolve before building

- **Frame egress:** which container exposes the screencast WS out of the sandbox (a thin proxy beside `playwright-mcp`, or the chromium container), and how the BFF proxies it (extend the live-preview proxy / `getExecutionSandboxPreviewInfo`).
- **Files cap:** `.webm` will routinely exceed 25 MB — raise the cap for `video`, or persist via the browser-artifact blob path (already chunk-friendly) rather than the generic files table.
- **MCP version:** confirm our pinned `@playwright/mcp` exposes `browser_start_video`/`browser_start_tracing` and that the `devtools` cap is enabled in the sidecar preset.
- **Multi-tab:** screencast is per-target; pick the active target (and surface a tab switcher) for agents that open multiple tabs.
- **Retention/cost:** default retain-on-completion + TTL (industry guidance: 30–90 days); never record every step (a naive record-all is 15–25 GB per heavy suite).
- **CLI family:** stdio in-pod Chromium has no `:3100` sidecar — L1 needs a per-family egress story or falls back to L0/R1-via-MCP.

---

## References
- Browserbase — [Live View](https://docs.browserbase.com/features/session-live-view), [Session replay = CDP screencast](https://www.browserbase.com/blog/session-recordings)
- Vercel `agent-browser` — [Screencasting & live preview](https://deepwiki.com/vercel-labs/agent-browser/6.2-screencasting-and-live-preview)
- CDP `startScreencast` perf (~70 fps vs ~5 fps polling) — [selenide#2145](https://github.com/selenide/selenide/issues/2145)
- noVNC performance characteristics — [novnc group](https://groups.google.com/g/novnc/c/61JQ_A7AOkY)
- rrweb — [repo](https://github.com/rrweb-io/rrweb), [session-replay benchmark](https://www.highlight.io/blog/session-replay-performance)
- Playwright — [Trace Viewer](https://playwright.dev/docs/trace-viewer), MCP [video](https://playwright.dev/mcp/tools/video) / [tracing](https://playwright.dev/mcp/tools/tracing)
