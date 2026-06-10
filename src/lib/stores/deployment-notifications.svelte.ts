/**
 * App-wide GitOps deployment notifications.
 *
 * Fires a notification when an image actually REPLACES the current deployment —
 * i.e. a real rollout lands and a component's running (live) image tag changes
 * on a cluster. This is the headline "your change is live" signal.
 *
 * Detection = INVENTORY-DIFF (not the event stream). The Argo-Events stream is
 * dominated by ArgoCD health/sync flaps and same-image re-syncs, so it can't
 * reliably tell "the image changed" from "the app re-synced". The hub inventory
 * carries each app's actual `live.images`, so we diff the live tag per
 * `env:component` across snapshots — a tag change (gated on `Synced`) is the
 * real rollout, and is immune to health flaps (flaps don't change the tag).
 *
 * The gitops SSE stream is used only as a low-latency "something changed,
 * re-check the inventory" trigger; a slow fallback poll covers SSE outages.
 *
 * Singleton + module-level $state → app-wide reactive. Started once from the
 * root layout for platform admins only (the inventory/SSE endpoints are
 * admin-gated). Surfaces as a Sonner toast + the sidebar notification bell;
 * the bell's history persists to localStorage.
 */
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { shortTag } from "$lib/utils/gitops-display";

export type DeployNotification = {
	/** Dedupe key: `${env}:${component}:${toTag}`. */
	id: string;
	component: string;
	env: string;
	fromTag: string | null;
	toTag: string;
	syncStatus: string | null;
	healthStatus: string | null;
	/** Epoch ms, stamped on detection. */
	at: number;
	read: boolean;
};

type InventoryApp = {
	component?: string;
	desired?: { image?: string | null } | null;
	live?: { images?: string[] | null; syncStatus?: string | null; healthStatus?: string | null } | null;
};

const STORAGE_KEY = "gitops:deploy-notifications:v1";
const MAX_NOTIFICATIONS = 50;
const POLL_MS = 25_000;
const RECHECK_DEBOUNCE_MS = 2_000;
const RECONNECT_MS = 8_000;
const TOAST_BATCH_LIMIT = 3;
const GITOPS_PIPELINE_PATH = "/admin/gitops/system";

/** Strip the `:tag` (and any `@digest`) off an image ref to get the bare repo. */
function repoOf(ref: string): string {
	return ref.split("@")[0].replace(/:[^:/]+$/, "");
}

/** The SET of tags of an app's OWN org image currently in `live.images`. During a
 *  rollout this can hold BOTH the old and new tag (old+new ReplicaSet pods both
 *  reported), which is exactly why detection diffs the SET rather than a single
 *  "current tag" — a genuinely new tag appearing is the rollout. `live.images`
 *  also carries sidecars (daprd, postgres, …), so we match only the component's
 *  own repo (derived from `desired.image`'s repo, or the canonical org path). */
function liveTagsFor(app: InventoryApp): Set<string> {
	const images = app.live?.images ?? [];
	const repo = app.desired?.image
		? repoOf(app.desired.image)
		: app.component
			? `ghcr.io/pittampalliorg/${app.component}`
			: null;
	const tags = new Set<string>();
	if (repo) {
		const prefix = repo + ":";
		for (const img of images) {
			if (img.startsWith(prefix)) tags.add(img.slice(prefix.length).split("@")[0]);
		}
	}
	if (tags.size === 0 && app.component) {
		const needle = `/${app.component}:`;
		for (const img of images) {
			const i = img.lastIndexOf(needle);
			if (i >= 0) tags.add(img.slice(i + needle.length).split("@")[0]);
		}
	}
	return tags;
}

class DeploymentNotificationStore {
	notifications = $state<DeployNotification[]>([]);

	private started = false;
	private destroyed = false;
	/** `${env}:${component}` → last-seen SET of live image tags. */
	private baseline = new Map<string, Set<string>>();
	private es: EventSource | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
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
		this.loadPersisted();
		// Establish a baseline WITHOUT notifying (we only announce changes that
		// happen after the app loads — not the state it loaded into), then arm
		// the low-latency SSE trigger + the fallback poll.
		void this.refresh(true).finally(() => {
			if (this.destroyed) return;
			this.openStream();
			this.pollTimer = setInterval(() => this.scheduleRecheck(), POLL_MS);
		});
	}

	stop(): void {
		this.destroyed = true;
		this.started = false; // allow a later start() (HMR / re-mount) to re-arm
		this.es?.close();
		this.es = null;
		if (this.pollTimer) clearInterval(this.pollTimer);
		if (this.recheckTimer) clearTimeout(this.recheckTimer);
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.pollTimer = this.recheckTimer = this.reconnectTimer = null;
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

	private scheduleRecheck(): void {
		if (this.recheckTimer || this.destroyed) return;
		this.recheckTimer = setTimeout(() => {
			this.recheckTimer = null;
			void this.refresh(false);
		}, RECHECK_DEBOUNCE_MS);
	}

	private async refresh(isBaseline: boolean): Promise<void> {
		if (this.destroyed) return;
		let metadata: { inventory?: { data?: { environments?: Array<{ name?: string; applications?: InventoryApp[] }> } } };
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
			metadata = await res.json();
		} catch {
			return; // transient; poll/SSE will retry
		}
		if (this.destroyed) return; // stopped while the fetch was in flight
		const envs = metadata?.inventory?.data?.environments ?? [];
		const fresh: DeployNotification[] = [];
		const now = Date.now();
		for (const env of envs) {
			const envName = env.name ?? "";
			for (const app of env.applications ?? []) {
				if (!app.component) continue;
				const current = liveTagsFor(app);
				if (current.size === 0) continue;
				const key = `${envName}:${app.component}`;
				const prev = this.baseline.get(key);
				this.baseline.set(key, current);
				if (isBaseline || prev === undefined) continue;
				// A real rollout: a NEW image tag appeared in this component's live
				// images that wasn't there before, while ArgoCD reports Synced. The
				// set-diff is immune to health flaps (flaps don't add a tag) and to
				// mid-rollout old+new coexistence (the old tag isn't "new").
				if (app.live?.syncStatus !== "Synced") continue;
				for (const tag of current) {
					if (prev.has(tag)) continue;
					const fromTag = [...prev].find((t) => t !== tag) ?? [...prev][0] ?? null;
					fresh.push({
						id: `${key}:${tag}`,
						component: app.component,
						env: envName,
						fromTag,
						toTag: tag,
						syncStatus: app.live?.syncStatus ?? null,
						healthStatus: app.live?.healthStatus ?? null,
						at: now,
						read: false,
					});
				}
			}
		}
		if (fresh.length) this.emit(fresh);
	}

	private emit(fresh: DeployNotification[]): void {
		if (this.destroyed) return; // don't surface anything after stop()
		const existing = new Set(this.notifications.map((n) => n.id));
		const novel = fresh.filter((n) => !existing.has(n.id));
		if (novel.length === 0) return;
		this.notifications = [...novel, ...this.notifications].slice(0, MAX_NOTIFICATIONS);
		this.persist();
		// A batch (e.g. a `[build all]`) can roll many services at once — collapse
		// to one summary toast rather than spamming N, and let the bell hold the rest.
		if (novel.length > TOAST_BATCH_LIMIT) {
			toast.success(`${novel.length} deployments`, {
				description: novel
					.slice(0, 3)
					.map((n) => `${n.component} → ${n.env}`)
					.join(", ") + (novel.length > 3 ? ", …" : ""),
				action: { label: "View", onClick: () => void goto(GITOPS_PIPELINE_PATH) },
			});
			return;
		}
		for (const n of novel) {
			toast.success(`${n.component} → ${n.env}`, {
				description: `now running ${shortTag(n.toTag)}${n.fromTag ? ` (was ${shortTag(n.fromTag)})` : ""}`,
				action: { label: "View", onClick: () => void goto(GITOPS_PIPELINE_PATH) },
			});
		}
	}

	private openStream(): void {
		if (this.destroyed) return;
		try {
			const es = new EventSource("/api/v1/gitops/events/stream?since=latest");
			this.es = es;
			es.addEventListener("gitops.event", () => this.scheduleRecheck());
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
			if (!raw) return;
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) this.notifications = parsed.slice(0, MAX_NOTIFICATIONS);
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
