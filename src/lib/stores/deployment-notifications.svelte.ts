/**
 * App-wide GitOps notifications.
 *
 * Detection = INVENTORY-DIFF (not the event stream), via the pure
 * `notification-detect.ts` module. The Argo-Events stream is dominated by
 * ArgoCD health/sync flaps and same-image re-syncs, so it can't reliably tell
 * "the image changed" / "the build actually failed" from transient churn. The
 * hub inventory carries each app's actual live images, build, promotion, and
 * health, so we diff snapshots per `env:component` — flap-immune, ~1min
 * latency at the inventory cadence.
 *
 * Kinds: deploy (new live tag while Synced — the original signal),
 * build_failed, degraded (confirmed across 2 snapshots), promotion_stuck, and
 * stream_health (events stalled / inventory stale — the only kinds the store
 * detects itself, because they're about the FEED, not a component).
 *
 * The gitops SSE stream is used only as a low-latency "something changed,
 * re-check the inventory" trigger AND as the liveness signal: when NO event
 * (the inventory heartbeat lands at least every ~10min when healthy) arrives
 * for STREAM_STALL_MS, a sticky warning fires — an open socket proves nothing
 * about the upstream eventbus (a real 11h outage once looked "live").
 *
 * Singleton + module-level $state → app-wide reactive. Started once from the
 * root layout for platform admins only (the inventory/SSE endpoints are
 * admin-gated). Surfaces as a Sonner toast + the sidebar notification bell;
 * the bell's history persists to localStorage (v2; v1 deploy-only entries are
 * migrated). Per-kind mute preferences live in notification-prefs.ts;
 * stream_health is never mutable.
 */
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import {
	detect,
	isKnownNotificationKind,
	migrateV1,
	STREAM_HEALTH_IDS,
	type DetectState,
	type GitOpsNotification,
	type InventoryEnv,
	type NotificationKind,
} from "$lib/gitops/notification-detect";
import {
	loadNotificationPrefs,
	saveNotificationPrefs,
	type MutableNotificationKind,
	type NotificationPrefs,
} from "$lib/gitops/notification-prefs";
import { shortTag } from "$lib/utils/gitops-display";

export type { GitOpsNotification, NotificationKind };
/** Back-compat alias (pre-v2 name). */
export type DeployNotification = GitOpsNotification;

const STORAGE_KEY = "gitops:deploy-notifications:v2";
const STORAGE_KEY_V1 = "gitops:deploy-notifications:v1";
const MAX_NOTIFICATIONS = 50;
const POLL_MS = 25_000;
const RECHECK_DEBOUNCE_MS = 2_000;
const RECONNECT_MS = 8_000;
const TOAST_BATCH_LIMIT = 3;
const GITOPS_PIPELINE_PATH = "/admin/gitops";
const STREAM_STALL_CHECK_MS = 60_000;
const DEFAULT_STREAM_STALL_MS = 15 * 60_000;
const INVENTORY_STALE_MS = 15 * 60_000;

/** Dev override (`localStorage["gitops:stall-ms"]`) so the stall path is testable. */
function streamStallMs(): number {
	if (import.meta.env.DEV) {
		const override = Number(localStorage.getItem("gitops:stall-ms"));
		if (Number.isFinite(override) && override > 0) return override;
	}
	return DEFAULT_STREAM_STALL_MS;
}

/** Deep link: land on the pipeline page with the relevant stage pre-selected. */
export function notificationTargetUrl(n: GitOpsNotification): string {
	if (!n.component || !n.env) return GITOPS_PIPELINE_PATH;
	return `${GITOPS_PIPELINE_PATH}?select=${encodeURIComponent(`stage/${n.component}::${n.env}`)}`;
}

type MetadataResponse = {
	generatedAt?: string;
	inventory?: {
		error?: string | null;
		data?: { generatedAt?: string; environments?: InventoryEnv[] } | null;
	};
};

class DeploymentNotificationStore {
	notifications = $state<GitOpsNotification[]>([]);
	prefs = $state<NotificationPrefs>({ muted: {} });
	/** True while the event stream has been silent past the stall threshold. */
	streamStalled = $state(false);

	private started = false;
	private destroyed = false;
	private detectState: DetectState = new Map();
	private baselined = false;
	private lastEventAt = Date.now();
	private es: EventSource | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private stallTimer: ReturnType<typeof setInterval> | null = null;
	private recheckTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	get unread(): number {
		return this.notifications.reduce((n, x) => n + (x.read ? 0 : 1), 0);
	}

	/** Start the app-wide watcher. Idempotent; browser + platform-admin only. */
	start(): void {
		if (this.started || typeof window === "undefined") return;
		this.started = true;
		this.destroyed = false;
		this.prefs = loadNotificationPrefs();
		this.loadPersisted();
		// Seed liveness at start so a fresh page load doesn't instantly alarm.
		this.lastEventAt = Date.now();
		// Establish a baseline WITHOUT notifying (we only announce changes that
		// happen after the app loads — not the state it loaded into), then arm
		// the low-latency SSE trigger + the fallback poll + the stall checker.
		void this.refresh().finally(() => {
			if (this.destroyed) return;
			this.openStream();
			this.pollTimer = setInterval(() => this.scheduleRecheck(), POLL_MS);
			this.stallTimer = setInterval(() => this.checkStreamStall(), STREAM_STALL_CHECK_MS);
		});
	}

	stop(): void {
		this.destroyed = true;
		this.started = false; // allow a later start() (HMR / re-mount) to re-arm
		this.baselined = false;
		this.detectState = new Map();
		this.es?.close();
		this.es = null;
		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.stallTimer) clearInterval(this.stallTimer);
		if (this.recheckTimer) clearTimeout(this.recheckTimer);
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.pollTimer = this.stallTimer = null;
		this.recheckTimer = this.reconnectTimer = null;
	}

	markAllRead(): void {
		if (this.unread === 0) return;
		this.notifications = this.notifications.map((n) => (n.read ? n : { ...n, read: true }));
		this.persist();
	}

	dismiss(id: string): void {
		this.notifications = this.notifications.filter((n) => n.id !== id);
		this.persist();
	}

	clear(): void {
		this.notifications = [];
		this.persist();
	}

	setMuted(kind: MutableNotificationKind, muted: boolean): void {
		this.prefs = { ...this.prefs, muted: { ...this.prefs.muted, [kind]: muted } };
		saveNotificationPrefs(this.prefs);
	}

	/** Dev-only: fabricate one notification of a kind through the full emit path. */
	simulate(kind: NotificationKind): void {
		if (!import.meta.env.DEV) return;
		const now = Date.now();
		const samples: Record<NotificationKind, GitOpsNotification> = {
			deploy: { id: `sim:deploy:${now}`, kind: "deploy", severity: "info", component: "workflow-builder", env: "dev", title: "deployed", detail: null, fromTag: "git-old1234", toTag: "git-new5678", at: now, read: false },
			build_failed: { id: `sim:build:${now}`, kind: "build_failed", severity: "error", component: "workflow-builder", env: "dev", title: "build failed", detail: "outer-loop-workflow-builder-xyz · Failed", fromTag: null, toTag: null, at: now, read: false },
			degraded: { id: `sim:degraded:${now}`, kind: "degraded", severity: "error", component: "workflow-builder", env: "ryzen", title: "degraded", detail: "health Degraded across 2 consecutive checks", fromTag: null, toTag: null, at: now, read: false },
			promotion_stuck: { id: `sim:promo:${now}`, kind: "promotion_stuck", severity: "warning", component: "release-pins", env: "dev", title: "promotion stuck", detail: "Pending for 15m+", fromTag: null, toTag: null, at: now, read: false },
			stream_health: { id: STREAM_HEALTH_IDS.eventsStalled, kind: "stream_health", severity: "warning", component: "", env: "", title: "event stream stalled", detail: "no GitOps events for 15m+ — eventbus may be down", fromTag: null, toTag: null, at: now, read: false },
		};
		this.emit([samples[kind]]);
	}

	private scheduleRecheck(): void {
		if (this.recheckTimer || this.destroyed) return;
		this.recheckTimer = setTimeout(() => {
			this.recheckTimer = null;
			void this.refresh();
		}, RECHECK_DEBOUNCE_MS);
	}

	private async refresh(): Promise<void> {
		if (this.destroyed) return;
		let metadata: MetadataResponse;
		try {
			// No `fresh=1`: the ingest endpoint invalidates the hub-inventory cache
			// when an event lands (including the inventory-updated event), so a plain
			// fetch already sees the new snapshot — and event bursts can't stampede
			// the upstream sources through this store.
			const res = await fetch("/api/v1/gitops/deployment-metadata", {
				headers: { accept: "application/json" },
			});
			if (res.status === 401 || res.status === 403) {
				this.stop(); // not an admin / lost session — don't loop
				return;
			}
			if (!res.ok) return;
			metadata = (await res.json()) as MetadataResponse;
		} catch {
			return; // transient; poll/SSE will retry
		}
		if (this.destroyed) return; // stopped while the fetch was in flight

		this.checkInventoryStale(metadata);

		const envs = metadata?.inventory?.data?.environments ?? [];
		if (envs.length === 0) return;
		const { next, fresh } = detect(this.detectState, envs, Date.now(), !this.baselined);
		this.detectState = next;
		this.baselined = true;
		const allowed = fresh.filter(
			(n) => !this.prefs.muted[n.kind as MutableNotificationKind],
		);
		if (allowed.length) this.emit(allowed);
	}

	/** Inventory generator health, through the same notification channel. */
	private checkInventoryStale(metadata: MetadataResponse): void {
		const generatedAt = metadata?.inventory?.data?.generatedAt;
		const age = generatedAt ? Date.now() - Date.parse(generatedAt) : Number.POSITIVE_INFINITY;
		const stale = Boolean(metadata?.inventory?.error) || age > INVENTORY_STALE_MS;
		const existing = this.notifications.some((n) => n.id === STREAM_HEALTH_IDS.inventoryStale);
		if (stale && !existing) {
			this.emit([
				{
					id: STREAM_HEALTH_IDS.inventoryStale,
					kind: "stream_health",
					severity: "warning",
					component: "",
					env: "",
					title: "inventory stale",
					detail: metadata?.inventory?.error
						? `inventory fetch failing: ${metadata.inventory.error}`
						: "hub inventory snapshot is >15m old — the generator may be failing",
					fromTag: null,
					toTag: null,
					at: Date.now(),
					read: false,
				},
			]);
		} else if (!stale && existing) {
			this.dismiss(STREAM_HEALTH_IDS.inventoryStale);
		}
	}

	private checkStreamStall(): void {
		if (this.destroyed) return;
		const silentFor = Date.now() - this.lastEventAt;
		if (!this.streamStalled && silentFor > streamStallMs()) {
			this.streamStalled = true;
			this.emit([
				{
					id: STREAM_HEALTH_IDS.eventsStalled,
					kind: "stream_health",
					severity: "warning",
					component: "",
					env: "",
					title: "event stream stalled",
					detail:
						"no GitOps events received for 15m+ (heartbeat expected every ~10min) — the hub eventbus may be down; state shown may be stale",
					fromTag: null,
					toTag: null,
					at: Date.now(),
					read: false,
				},
			]);
		}
	}

	private onEventReceived(): void {
		this.lastEventAt = Date.now();
		if (this.streamStalled) {
			this.streamStalled = false;
			this.dismiss(STREAM_HEALTH_IDS.eventsStalled);
			toast.info("GitOps event stream recovered");
		}
		this.scheduleRecheck();
	}

	private emit(fresh: GitOpsNotification[]): void {
		if (this.destroyed) return; // don't surface anything after stop()
		const existing = new Set(this.notifications.map((n) => n.id));
		const novel = fresh.filter((n) => !existing.has(n.id));
		if (novel.length === 0) return;
		this.notifications = [...novel, ...this.notifications].slice(0, MAX_NOTIFICATIONS);
		this.persist();

		const infos = novel.filter((n) => n.severity === "info");
		const alerts = novel.filter((n) => n.severity !== "info");

		// Failures/warnings always toast individually (their volume is inherently
		// low and they must not collapse into a success summary).
		for (const n of alerts) {
			const fn = n.severity === "error" ? toast.error : toast.warning;
			fn(n.component ? `${n.component} → ${n.env}: ${n.title}` : n.title, {
				description: n.detail ?? undefined,
				action: { label: "View", onClick: () => void goto(notificationTargetUrl(n)) },
			});
		}

		// A batch (e.g. a `[build all]`) can roll many services at once — collapse
		// to one summary toast rather than spamming N, and let the bell hold the rest.
		if (infos.length > TOAST_BATCH_LIMIT) {
			toast.success(`${infos.length} deployments`, {
				description:
					infos
						.slice(0, 3)
						.map((n) => `${n.component} → ${n.env}`)
						.join(", ") + (infos.length > 3 ? ", …" : ""),
				action: { label: "View", onClick: () => void goto(GITOPS_PIPELINE_PATH) },
			});
			return;
		}
		for (const n of infos) {
			toast.success(`${n.component} → ${n.env}`, {
				description: `now running ${shortTag(n.toTag)}${n.fromTag ? ` (was ${shortTag(n.fromTag)})` : ""}`,
				action: { label: "View", onClick: () => void goto(notificationTargetUrl(n)) },
			});
		}
	}

	private openStream(): void {
		if (this.destroyed) return;
		try {
			const es = new EventSource("/api/v1/gitops/events/stream?since=latest");
			this.es = es;
			es.addEventListener("gitops.event", () => this.onEventReceived());
			es.onerror = () => {
				es.close();
				if (this.es === es) this.es = null;
				if (!this.destroyed && !this.reconnectTimer) {
					this.reconnectTimer = setTimeout(() => {
						this.reconnectTimer = null;
						this.openStream();
					}, RECONNECT_MS);
				}
			};
		} catch {
			/* EventSource unavailable — the fallback poll still covers detection. */
		}
	}

	private persist(): void {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.notifications.slice(0, MAX_NOTIFICATIONS)));
		} catch {
			/* quota / private mode — history is best-effort */
		}
	}

	private loadPersisted(): void {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (raw) {
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) {
					this.notifications = (parsed as GitOpsNotification[])
						.filter((n) => isKnownNotificationKind(n?.kind))
						.slice(0, MAX_NOTIFICATIONS);
				}
				return;
			}
			// v1 → v2 migration (deploy-only history).
			const rawV1 = localStorage.getItem(STORAGE_KEY_V1);
			if (!rawV1) return;
			this.notifications = migrateV1(JSON.parse(rawV1)).slice(0, MAX_NOTIFICATIONS);
			this.persist();
			localStorage.removeItem(STORAGE_KEY_V1);
		} catch {
			/* corrupt storage — start empty */
		}
	}
}

export const deploymentNotifications = new DeploymentNotificationStore();

// Dev only: on HMR the module re-evaluates into a fresh singleton — stop the old
// one first so its timers + EventSource don't leak / double-fire.
if (import.meta.hot) {
	import.meta.hot.dispose(() => deploymentNotifications.stop());
}
