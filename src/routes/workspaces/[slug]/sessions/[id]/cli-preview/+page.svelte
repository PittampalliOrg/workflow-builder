<script lang="ts">
	import { page } from "$app/state";

	const sessionId = page.params.id as string;

	let loading = $state(false);
	let ready = $state(false);
	let errorMessage = $state("");
	let previewUrl = $state("");
	let logText = $state("");
	// Defaults match the gan-harness / coding-redesign sandbox layout.
	let cwd = $state("/sandbox/work/repo");
	let port = $state(4321);
	let previewCommand = $state("");

	async function startPreview() {
		loading = true;
		errorMessage = "";
		logText = "";
		try {
			const res = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/cli-preview`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					cwd: cwd.trim() || undefined,
					port,
					previewCommand: previewCommand.trim() || undefined,
				}),
			});
			const body = (await res.json().catch(() => ({}))) as {
				ready?: boolean;
				proxyUrl?: string;
				log?: string;
				message?: string;
			};
			if (!res.ok) {
				throw new Error(body.message || `Failed to start preview (${res.status})`);
			}
			ready = body.ready === true;
			logText = body.log ?? "";
			// Cache-bust the iframe each (re)start; carry the chosen port.
			previewUrl = `${body.proxyUrl ?? ""}?port=${port}&t=${Date.now()}`;
			if (!ready) {
				errorMessage =
					"Preview server did not report ready — it may still be starting, or the app isn't built yet. Check the log, then retry.";
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : "Failed to start preview";
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head><title>Live preview · {sessionId}</title></svelte:head>

<div class="flex h-screen flex-col">
	<div class="flex flex-wrap items-end gap-2 border-b px-4 py-2">
		<div class="flex flex-col">
			<span class="text-[10px] uppercase text-muted-foreground">Working dir</span>
			<input
				bind:value={cwd}
				class="w-56 rounded border bg-background px-2 py-1 text-xs font-mono"
				placeholder="/sandbox/work/repo"
			/>
		</div>
		<div class="flex flex-col">
			<span class="text-[10px] uppercase text-muted-foreground">Port</span>
			<input
				type="number"
				bind:value={port}
				class="w-20 rounded border bg-background px-2 py-1 text-xs font-mono"
			/>
		</div>
		<div class="flex flex-col">
			<span class="text-[10px] uppercase text-muted-foreground">Preview command (optional)</span>
			<input
				bind:value={previewCommand}
				class="w-56 rounded border bg-background px-2 py-1 text-xs font-mono"
				placeholder="auto (npm run preview → dev)"
			/>
		</div>
		<button
			type="button"
			onclick={startPreview}
			disabled={loading}
			class="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
		>
			{loading ? "Starting…" : ready ? "Restart preview" : "Start preview"}
		</button>
		{#if previewUrl}
			<a
				href={previewUrl}
				target="_blank"
				rel="noreferrer"
				class="rounded border px-3 py-1.5 text-xs hover:bg-muted">Open in new tab ↗</a
			>
		{/if}
		{#if ready}
			<span class="text-xs text-emerald-600 dark:text-emerald-400">● live</span>
		{/if}
	</div>

	{#if errorMessage}
		<div class="border-b bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
			{errorMessage}
		</div>
	{/if}

	{#if previewUrl && ready}
		<iframe title="Sandbox live preview" src={previewUrl} class="min-h-0 flex-1 border-0 bg-white"></iframe>
	{:else}
		<div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
			<p class="max-w-md">
				Live preview of the app this CLI agent built in its sandbox. Set the working dir (where
				the repo + its build output live), then <strong>Start preview</strong> — the dev/preview
				server runs in the session pod and is proxied here over the tailnet.
			</p>
			{#if logText}
				<pre class="max-h-48 w-full max-w-2xl overflow-auto rounded bg-muted p-2 text-left text-[11px]">{logText}</pre>
			{/if}
		</div>
	{/if}
</div>
