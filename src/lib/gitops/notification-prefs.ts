/**
 * Per-kind GitOps notification mute preferences (localStorage, same pattern as
 * preferred-filter.ts). `stream_health` is intentionally NOT mutable — it's the
 * flying-blind alarm.
 */
export type MutableNotificationKind = "deploy" | "build_failed" | "degraded" | "promotion_stuck";

export const MUTABLE_NOTIFICATION_KINDS: readonly MutableNotificationKind[] = [
	"deploy",
	"build_failed",
	"degraded",
	"promotion_stuck",
] as const;

export const NOTIFICATION_KIND_LABELS: Record<MutableNotificationKind, string> = {
	deploy: "Deployments",
	build_failed: "Build failures",
	degraded: "Degraded apps",
	promotion_stuck: "Stuck promotions",
};

export type NotificationPrefs = {
	muted: Partial<Record<MutableNotificationKind, boolean>>;
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { muted: {} };

const STORAGE_KEY = "gitops:notification-prefs:v1";

export function loadNotificationPrefs(): NotificationPrefs {
	if (typeof localStorage === "undefined") return { ...DEFAULT_NOTIFICATION_PREFS };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_NOTIFICATION_PREFS };
		const parsed = JSON.parse(raw) as Partial<NotificationPrefs> | null;
		return {
			...DEFAULT_NOTIFICATION_PREFS,
			...parsed,
			muted: { ...(parsed?.muted ?? {}) },
		};
	} catch {
		return { ...DEFAULT_NOTIFICATION_PREFS };
	}
}

export function saveNotificationPrefs(prefs: NotificationPrefs): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		/* quota / private mode — preferences are best-effort */
	}
}
