<script lang="ts">
	// Post-run live preview of the app a CLI agent built in this run's shared
	// JuiceFS workspace. Works AFTER the run completes: the BFF provisions a fresh
	// credential-less pod that re-mounts the run's retained `/sandbox/work` and
	// serves `npm run preview`/`dev`, proxied here over the tailnet. The provision
	// is a cold start (~30-60s), so a 202 "provisioning" response is auto-retried.

	let { executionId }: { executionId: string } = $props();

	let loading = $state(false);
	let provisioning = $state(false);
	let ready = $state(false);
	let errorMessage = $state("");
	let previewUrl = $state("");
	let logText = $state("");
	let cwd = $state("/sandbox/work/repo");
	let port = $state(4321);
	let previewCommand = $state("");

	const MAX_RETRIES = 18; // ~18 * 8s ≈ 2.4 min of cold-start budget

	async function startPreview() {
		loading = true;
		provisioning = false;
		errorMessage = "";
		logText = "";
		ready = false;
		try {
			let attempt = 0;
			while (attempt <= MAX_RETRIES) {
				const res = await fetch(
					`/api/workflows/executions/${encodeURIComponent(executionId)}/cli-preview`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							cwd: cwd.trim() || undefined,
							port,
							previewCommand: previewCommand.trim() || undefined,
						}),
					},
				);
				// 202: pod still booting — show "provisioning" and retry shortly.
				if (res.status === 202) {
					provisioning = true;
					attempt += 1;
					await new Promise((r) => setTimeout(r, 8000));
					continue;
				}
				const body = (await res.json().catch(() => ({}))) as {
					ready?: boolean;
					proxyUrl?: string;
					log?: string;
					message?: string;
					reused?: boolean;
				};
				if (!res.ok) {
					throw new Error(body.message || `Failed to start preview (${res.status})`);
				}
				provisioning = false;
				ready = body.ready === true;
				logText = body.log ?? "";
				previewUrl = `${body.proxyUrl ?? ""}?port=${port}&t=${Date.now()}`;
				if (!ready) {
					errorMessage =
						"Preview server did not report ready — the app may not be built (try a different command/dir), or it is still starting. Check the log, then retry.";
				}
				return;
			}
			provisioning = false;
			errorMessage =
				"Preview pod did not become ready in time. It may still be provisioning — retry in a moment.";
		} catch (err) {
			provisioning = false;
			errorMessage = err instanceof Error ? err.message : "Failed to start preview";
		} finally {
			loading = false;
		}
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex flex-wrap items-end gap-2 border-b border-border px-4 py-2">
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
			{loading
				? provisioning
					? "Provisioning…"
					: "Starting…"
				: ready
					? "Restart preview"
					: "Start preview"}
		</button>
		{#if previewUrl && ready}
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

	{#if provisioning}
		<div class="border-b bg-sky-50 px-4 py-2 text-xs text-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
			Provisioning a preview pod against this run's retained workspace (cold start, ~30–60s)…
		</div>
	{/if}
	{#if errorMessage}
		<div class="border-b bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
			{errorMessage}
		</div>
	{/if}

	{#if previewUrl && ready}
		<iframe title="Run live preview" src={previewUrl} class="min-h-0 flex-1 border-0 bg-white"></iframe>
	{:else}
		<div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
			<p class="max-w-md">
				Live preview of the app this run's CLI agents built in their shared sandbox
				(<code>/sandbox/work/repo</code>). Works after the run completes — set the working dir, then
				<strong>Start preview</strong>. A fresh pod re-mounts the run's retained workspace and is
				proxied here over the tailnet.
			</p>
			{#if logText}
				<pre class="max-h-48 w-full max-w-2xl overflow-auto rounded bg-muted p-2 text-left text-[11px]">{logText}</pre>
			{/if}
		</div>
	{/if}
</div>
