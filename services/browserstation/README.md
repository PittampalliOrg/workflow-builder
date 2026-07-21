# BrowserStation

BrowserStation is the Ray-backed browser pool used by `agent-browser-mcp`.

## Rollout admission

`PUT /internal/rollout/lease-admission` temporarily fences `POST /browsers`
while leaving health, status, deletion, WebSocket, and CDP traffic available.
The initial authenticated request contains a lowercase SHA-256 rollout
contract, the Kubernetes rollout holder UID, and a 5-120 second TTL.
BrowserStation returns a server-issued opaque lease token. Renew and DELETE
must present that token with the same contract and holder. An expired token
cannot renew or release a later fence, including one acquired by the same Job.
The fence expires fail-open so a failed rollout Job cannot permanently stop
browser admission. The token is never included in public health output.

Fence mutation and browser creation share one `asyncio.Lock`. A successful PUT
therefore proves that earlier create calls have finished and later creates will
receive a retryable `503` until release or expiry. DELETE with the same contract
and holder releases the fence. `BROWSERSTATION_ROLLOUT_API_KEY` authenticates
these internal operations and defaults to `BROWSERSTATION_API_KEY`.
