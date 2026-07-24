/**
 * Application-layer entry for the archive-on-terminal reconciler.
 *
 * Inbound adapters (the Dapr Job callback `POST /job/run-archive` + the internal
 * `POST /api/internal/workflows/archive/reconcile` ops endpoint) and the boot
 * scheduler reach the sweep through THIS module rather than the concrete adapter
 * — routes depend on application services, never `application/adapters/*`
 * (dependency-cruiser `routes-no-adapters`). The real Postgres/ClickHouse/
 * object-store/Dapr wiring lives in `adapters/run-archive-deps.ts`.
 */
export {
	runRunArchive,
	scheduleRunArchiveJob,
	authenticateRunArchiveJobPayload,
	RUN_ARCHIVE_JOB_NAME,
	type RunRunArchiveResult,
} from "./adapters/run-archive-deps";
