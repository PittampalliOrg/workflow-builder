// Demo-video auto-editor.
//
// Turns the per-scene WebM clips a run recorded (via the bridge's demo_scene
// virtual tool → agent-browser record_restart) into ONE polished MP4 a human
// can watch to understand what the site does:
//   - dead time removed: freezedetect finds static spans (the LLM "thinking"
//     gaps between actions) and a select-filter cuts them, leaving jump cuts
//     between moments of actual motion;
//   - adaptive pacing: if the trimmed footage still exceeds the target length,
//     every scene is sped up uniformly (capped) to fit;
//   - annotations: a lower-third band with the scene title + caption, and a
//     "Scene N/M" badge, burned into every scene; a title card (site + focus)
//     opens the video and an end card recaps the scenes;
//   - normalized output: 1280×720 30fps H.264 yuv420p MP4 (+faststart), which
//     the run page's <video> renders inline everywhere.
//
// Everything is deterministic ffmpeg/ffprobe (bundled in this image — agent-
// browser itself needs ffmpeg for WebM recording); no LLM in the edit loop.
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const FONT_DIR = "/usr/share/fonts/truetype/liberation";
const FONT_BOLD = `${FONT_DIR}/LiberationSans-Bold.ttf`;
const FONT_REG = `${FONT_DIR}/LiberationSans-Regular.ttf`;
const W = 1280;
const H = 720;
const FPS = 30;
const BG = "0x101828"; // slate-900-ish backdrop for cards and pillarboxing

const TARGET_SECONDS = Number(process.env.DEMO_TARGET_SECONDS || 75);
const MAX_SPEEDUP = Number(process.env.DEMO_MAX_SPEEDUP || 2.5);
// A span must sit still this long to count as dead time; keep a beat of it so
// the result of each action stays readable before the cut.
const FREEZE_MIN_S = Number(process.env.DEMO_FREEZE_MIN_S || 1.4);
const FREEZE_KEEP_S = 0.5;

async function ffprobeDuration(path) {
	const { stdout } = await run("ffprobe", [
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "csv=p=0",
		path,
	]);
	const d = Number.parseFloat(String(stdout).trim());
	return Number.isFinite(d) ? d : 0;
}

/** Screencast-written webm (remote/CDP recordings) carries NO container
 * duration (ffprobe: N/A) AND can change frame size mid-stream (both break
 * the render filter chain: "Failed to configure input pad"). When the
 * duration probe fails, fully re-encode to a constant 1280x720@10fps —
 * verified to recover 4-min lane recordings intact. Returns the clip
 * (possibly re-pathed into `dir`); never throws. */
async function normalizeClip(dir, clip, index) {
	try {
		if ((await ffprobeDuration(clip.path)) >= 0.4) return clip;
		const fixed = join(dir, `norm-${index}.webm`);
		await run("ffmpeg", [
			"-hide_banner", "-y",
			"-fflags", "+genpts",
			"-i", clip.path,
			"-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
			"-r", "10",
			"-c:v", "libvpx", "-b:v", "1M",
			"-deadline", "realtime", "-cpu-used", "8",
			fixed,
		]);
		if ((await ffprobeDuration(fixed)) >= 0.4) return { ...clip, path: fixed };
	} catch {
		/* fall through to the original clip */
	}
	return clip;
}

/** Freeze spans [{start, end}] via freezedetect (end may be clip end). */
async function detectFreezes(path, duration) {
	let stderr = "";
	try {
		const res = await run(
			"ffmpeg",
			["-hide_banner", "-i", path, "-vf", `freezedetect=n=0.003:d=${FREEZE_MIN_S}`, "-an", "-f", "null", "-"],
			{ maxBuffer: 32 * 1024 * 1024 },
		);
		stderr = String(res.stderr || "");
	} catch (err) {
		stderr = String(err?.stderr || "");
	}
	const spans = [];
	let open = null;
	for (const m of stderr.matchAll(/freeze_(start|end): ([\d.]+)/g)) {
		const t = Number.parseFloat(m[2]);
		if (m[1] === "start") open = t;
		else if (open !== null) {
			spans.push({ start: open, end: t });
			open = null;
		}
	}
	if (open !== null) spans.push({ start: open, end: duration });
	return spans;
}

/** Intervals of the clip worth keeping (motion + a beat of each freeze). */
function keepIntervals(duration, freezes) {
	const keep = [];
	let cursor = 0;
	for (const f of freezes) {
		const cutFrom = Math.max(f.start + FREEZE_KEEP_S, cursor);
		if (cutFrom > cursor) keep.push([cursor, Math.min(cutFrom, duration)]);
		cursor = Math.max(cursor, f.end);
	}
	if (cursor < duration) keep.push([cursor, duration]);
	const total = keep.reduce((s, [a, b]) => s + (b - a), 0);
	// A scene that never moves (static page) still deserves a readable beat.
	if (total < 0.5) return [[0, Math.min(2.5, duration)]];
	return keep;
}

function esc(pathArg) {
	// ffmpeg filter option escaping for file paths (':' and '\').
	return String(pathArg).replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function wrapText(text, width) {
	const words = String(text || "").split(/\s+/).filter(Boolean);
	const lines = [];
	let line = "";
	for (const w of words) {
		if ((line + " " + w).trim().length > width && line) {
			lines.push(line);
			line = w;
		} else {
			line = (line ? line + " " : "") + w;
		}
	}
	if (line) lines.push(line);
	return lines;
}

/** drawtext via textfile= (sidesteps quote/percent escaping entirely). */
async function textFilter(dir, id, text, opts) {
	const file = join(dir, `${id}.txt`);
	await writeFile(file, String(text ?? ""));
	const { font = FONT_REG, size = 24, color = "white", x = "24", y = "24", box = false, boxcolor = "black@0.55", boxborder = 10, spacing = 8 } = opts || {};
	return (
		`drawtext=fontfile=${esc(font)}:textfile=${esc(file)}:fontsize=${size}` +
		`:fontcolor=${color}:x=${x}:y=${y}:line_spacing=${spacing}` +
		(box ? `:box=1:boxcolor=${boxcolor}:boxborderw=${boxborder}` : "")
	);
}

async function renderCard(dir, name, seconds, blocks) {
	// blocks: [{text, size, font, color, yExpr}]
	const filters = [];
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		filters.push(
			await textFilter(dir, `${name}-${i}`, b.text, {
				font: b.font || FONT_REG,
				size: b.size || 28,
				color: b.color || "white",
				x: "(w-text_w)/2",
				y: b.yExpr,
				spacing: 10,
			}),
		);
	}
	const out = join(dir, `${name}.mp4`);
	await run("ffmpeg", [
		"-hide_banner", "-y",
		"-f", "lavfi",
		"-i", `color=c=${BG}:s=${W}x${H}:d=${seconds}:r=${FPS}`,
		"-vf", filters.join(","),
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-an",
		out,
	]);
	return out;
}

async function renderScene(dir, clip, index, total, speedup) {
	const duration = await ffprobeDuration(clip.path);
	if (duration < 0.4) return null;
	const freezes = await detectFreezes(clip.path, duration);
	const keep = keepIntervals(duration, freezes);
	const select = keep.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join("+");

	const title = clip.title || `Scene ${index + 1}`;
	const caption = clip.caption || "";
	const filters = [
		`fps=${FPS}`,
		`select='${select}'`,
		`setpts=N/(${FPS}*TB)`,
	];
	if (speedup > 1.01) filters.push(`setpts=PTS/${speedup.toFixed(3)}`, `fps=${FPS}`);
	filters.push(
		`scale=${W}:-2`,
		`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${BG}`,
		// lower-third band
		`drawbox=x=0:y=${H - 96}:w=${W}:h=96:color=black@0.55:t=fill`,
		await textFilter(dir, `s${index}-title`, title, {
			font: FONT_BOLD, size: 30, x: "28", y: `${H - 84}`,
		}),
		await textFilter(dir, `s${index}-cap`, caption, {
			font: FONT_REG, size: 20, color: "white@0.92", x: "28", y: `${H - 44}`,
		}),
		await textFilter(dir, `s${index}-badge`, `Scene ${index + 1}/${total}`, {
			font: FONT_BOLD, size: 20, x: `w-text_w-24`, y: "20", box: true,
		}),
	);
	const out = join(dir, `scene-${index}.mp4`);
	await run(
		"ffmpeg",
		[
			"-hide_banner", "-y", "-i", clip.path,
			"-vf", filters.join(","),
			"-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-an",
			out,
		],
		{ maxBuffer: 32 * 1024 * 1024 },
	);
	return { out, keptSeconds: keep.reduce((s, [a, b]) => s + (b - a), 0) / (speedup > 1.01 ? speedup : 1) };
}

/**
 * Render the demo.
 * clips: [{path, title, caption}] in scene order (already excludes untitled footage)
 * meta: {site, focus}
 * Returns {path, seconds, scenes} — caller persists and cleans up `path`.
 */
export async function renderDemo(clips, meta) {
	const dir = await mkdtemp(join(tmpdir(), "demo-"));
	try {
		// First pass: measure kept footage at natural speed to size the speedup.
		let naturalTotal = 0;
		const measured = [];
		for (let ci = 0; ci < clips.length; ci++) {
			const clip = await normalizeClip(dir, clips[ci], ci);
			const duration = await ffprobeDuration(clip.path);
			if (duration < 0.4) continue;
			const keep = keepIntervals(duration, await detectFreezes(clip.path, duration));
			const kept = keep.reduce((s, [a, b]) => s + (b - a), 0);
			naturalTotal += kept;
			measured.push(clip);
		}
		if (!measured.length) throw new Error("no usable scene footage");
		const cardsSeconds = 2.2 + 2.5;
		const budget = Math.max(20, TARGET_SECONDS - cardsSeconds);
		const speedup = Math.min(MAX_SPEEDUP, Math.max(1, naturalTotal / budget));

		const parts = [];
		const site = meta?.site || "";
		const focusLines = wrapText(meta?.focus || "", 52).slice(0, 3).join("\n");
		parts.push(
			await renderCard(dir, "title", 2.2, [
				{ text: site, font: FONT_BOLD, size: 54, yExpr: "(h/2)-110" },
				{ text: focusLines, size: 26, color: "white@0.92", yExpr: "(h/2)-20" },
				{ text: "Automated site demo", size: 20, color: "white@0.6", yExpr: "h-90" },
			]),
		);
		const sceneTitles = [];
		for (let i = 0; i < measured.length; i++) {
			const rendered = await renderScene(dir, measured[i], i, measured.length, speedup);
			if (rendered) {
				parts.push(rendered.out);
				sceneTitles.push(measured[i].title || `Scene ${i + 1}`);
			}
		}
		parts.push(
			await renderCard(dir, "end", 2.5, [
				{ text: "That's the tour", font: FONT_BOLD, size: 44, yExpr: "110" },
				{
					text: sceneTitles.map((t, i) => `${i + 1}.  ${t}`).join("\n"),
					size: 26,
					color: "white@0.92",
					yExpr: "210",
				},
				{ text: site, size: 20, color: "white@0.6", yExpr: "h-90" },
			]),
		);

		const listFile = join(dir, "concat.txt");
		await writeFile(listFile, parts.map((p) => `file '${p}'`).join("\n"));
		const outPath = join(tmpdir(), `demo-${Date.now()}.mp4`);
		await run("ffmpeg", [
			"-hide_banner", "-y",
			"-f", "concat", "-safe", "0", "-i", listFile,
			"-c", "copy", "-movflags", "+faststart",
			outPath,
		]);
		const seconds = await ffprobeDuration(outPath);
		return { path: outPath, seconds, scenes: sceneTitles, speedup };
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

export async function readAndRm(path) {
	const buf = await readFile(path);
	await rm(path, { force: true }).catch(() => {});
	return buf;
}
