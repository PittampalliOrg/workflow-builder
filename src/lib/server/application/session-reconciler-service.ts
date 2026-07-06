/**
 * Application-layer entry for the session liveness reconciler.
 *
 * Routes (the internal `POST /api/internal/sessions/reconcile` ops endpoint + the
 * Dapr Job `/job/session-liveness-reconcile` callback) and the boot scheduler
 * reach the reconciler through THIS module rather than the concrete adapter —
 * routes are inbound adapters and must depend on application services, never on
 * `application/adapters/*` directly (dependency-cruiser `routes-no-adapters`).
 * The real Dapr/K8s/DB wiring lives in `adapters/session-reconciler-deps.ts`.
 */
export {
	runSessionReconcile,
	scheduleSessionReconcilerJob,
	authenticateReconcilerJobPayload,
	type RunSessionReconcileResult,
} from "./adapters/session-reconciler-deps";
