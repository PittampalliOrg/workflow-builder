/**
 * Stable per-member identity colors for Agent Teams surfaces (TeamPulse
 * topology, activity-feed chips, transcript sender chips). LITERAL Tailwind
 * class bundles — the JIT compiler cannot see composed class names, so every
 * class string here must appear verbatim.
 *
 * `lead` is pinned to the amber slot (crown color) everywhere; other names
 * hash stably into the remaining palette so a member keeps its color across
 * pages, polls, and sessions.
 */

export type MemberColor = {
	/** Small dot / avatar fill. */
	dot: string;
	/** Soft background tint. */
	bg: string;
	/** Border/ring accent. */
	ring: string;
	/** Foreground text accent. */
	text: string;
	/** SVG stroke (connector lines / pulses). */
	stroke: string;
};

const LEAD: MemberColor = {
	dot: 'bg-amber-400',
	bg: 'bg-amber-500/10',
	ring: 'border-amber-400/50',
	text: 'text-amber-300',
	stroke: 'stroke-amber-400'
};

const PALETTE: MemberColor[] = [
	{ dot: 'bg-violet-400', bg: 'bg-violet-500/10', ring: 'border-violet-400/50', text: 'text-violet-300', stroke: 'stroke-violet-400' },
	{ dot: 'bg-teal-400', bg: 'bg-teal-500/10', ring: 'border-teal-400/50', text: 'text-teal-300', stroke: 'stroke-teal-400' },
	{ dot: 'bg-sky-400', bg: 'bg-sky-500/10', ring: 'border-sky-400/50', text: 'text-sky-300', stroke: 'stroke-sky-400' },
	{ dot: 'bg-rose-400', bg: 'bg-rose-500/10', ring: 'border-rose-400/50', text: 'text-rose-300', stroke: 'stroke-rose-400' },
	{ dot: 'bg-emerald-400', bg: 'bg-emerald-500/10', ring: 'border-emerald-400/50', text: 'text-emerald-300', stroke: 'stroke-emerald-400' },
	{ dot: 'bg-cyan-400', bg: 'bg-cyan-500/10', ring: 'border-cyan-400/50', text: 'text-cyan-300', stroke: 'stroke-cyan-400' },
	{ dot: 'bg-fuchsia-400', bg: 'bg-fuchsia-500/10', ring: 'border-fuchsia-400/50', text: 'text-fuchsia-300', stroke: 'stroke-fuchsia-400' },
	{ dot: 'bg-lime-400', bg: 'bg-lime-500/10', ring: 'border-lime-400/50', text: 'text-lime-300', stroke: 'stroke-lime-400' },
	{ dot: 'bg-orange-400', bg: 'bg-orange-500/10', ring: 'border-orange-400/50', text: 'text-orange-300', stroke: 'stroke-orange-400' },
	{ dot: 'bg-indigo-400', bg: 'bg-indigo-500/10', ring: 'border-indigo-400/50', text: 'text-indigo-300', stroke: 'stroke-indigo-400' }
];

function hash(name: string): number {
	let h = 5381;
	for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
	return Math.abs(h);
}

/** Stable color bundle for a member name; `lead`/`team` map to the amber slot. */
export function memberColor(name: string | null | undefined): MemberColor {
	const n = (name ?? '').trim().toLowerCase();
	if (!n || n === 'lead' || n === 'team' || n === 'script') return LEAD;
	return PALETTE[hash(n) % PALETTE.length];
}

/** 1–2 letter initials for the avatar node. */
export function memberInitials(name: string | null | undefined): string {
	const n = (name ?? '?').trim();
	if (!n) return '?';
	const parts = n.split(/[\s_-]+/).filter(Boolean);
	if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
	return n.slice(0, 2).toUpperCase();
}
