<script lang="ts">
	// Unified post-run live preview for a workflow RUN, across both workspace
	// backends:
	//   - cli       → JuiceFS execution-keyed preview: provision a fresh
	//                 credential-less pod that re-mounts the run's retained
	//                 /sandbox/work and serves `npm run preview`/`dev` (#253).
	//   - openshell → retained dapr/openshell sandbox: start a dev server in the
	//                 kept workspace (sandbox-preview).
	// Both are proxied to this iframe over the BFF tailnet hostname. The backend is
	// resolved from /preview-info so the same tab serves every runtime.
	import { onMount } from "svelte";

	let { executionId }: { executionId: string } = $props();

	let backend = $state<"cli" | "openshell" | null | "loading">("loading");
	let loading = $state(false);
	let provisioning = $state(false);
	let ready = $state(false);
	let errorMessage = $state("");
	let previewUrl = $state("");
	let pageUrl = $state("");
	let logText = $state("");

	// cli inputs
	let cwd = $state("/sandbox/work/repo");
	let port = $state(4321);
	let previewCommand = $state("");
	// openshell inputs
	let repoPath = $state("");
	let installCommand = $state("");
	let devServerCommand = $state("");

	const MAX_RETRIES = 18; // ~18 * 8s ≈ 2.4 min cli cold-start budget

	onMount(async () => {
		try {
			const res = await fetch(
				`/api/workflows/executions/${encodeURIComponent(executionId)}/preview-info`,
			);
			const body = (await res.json().catch(() => ({}))) as { backend?: string | null };
			backend = (body.backend as "cli" | "openshell" | null) ?? null;
		} catch {
			backend = null;
		}
	});

	async function startCli() {
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
				};
				if (!res.ok) throw new Error(body.message || `Failed to start preview (${res.status})`);
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
			errorMessage = "Preview pod did not become ready in time — retry in a moment.";
		} catch (err) {
			provisioning = false;
			errorMessage = err instanceof Error ? err.message : "Failed to start preview";
		} finally {
			loading = false;
		}
	}

	async function startOpenshell() {
		loading = true;
		errorMessage = "";
		ready = false;
		try {
			const res = await fetch(
				`/api/workflows/executions/${encodeURIComponent(executionId)}/sandbox-preview`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						repoPath: repoPath.trim() || undefined,
						installCommand: installCommand.trim() || undefined,
						devServerCommand: devServerCommand.trim() || undefined,
					}),
				},
			);
			const body = (await res.json().catch(() => ({}))) as {
				proxyUrl?: string;
				pageUrl?: string;
				message?: string;
				error?: string;
			};
			if (!res.ok || !body.proxyUrl) {
				throw new Error(body.message || body.error || `Failed to start preview (${res.status})`);
			}
			ready = true;
			pageUrl = body.pageUrl ?? "";
			previewUrl = `${body.proxyUrl}?t=${Date.now()}`;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : "Failed to start preview";
		} finally {
			loading = false;
		}
	}

	const isCli = $derived(backend === "cli");
	function start() {
		return isCli ? startCli() : startOpenshell();
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	{#if backend === "loading"}
		<div class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
			Checking preview availability…
		</div>
	{:else if backend === null}
		<div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
			<p class="max-w-md">
				No live preview is available for this run. Live preview is for runs whose agents built an app
				in a shared workspace (interactive-cli runs, or a dapr/openshell run that kept its sandbox).
			</p>
		</div>
	{:else}
		<div class="flex flex-wrap items-end gap-2 border-b border-border px-4 py-2">
			<span class="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground"
				>{backend} backend</span
			>
			{#if isCli}
				<div class="flex flex-col">
					<span class="text-[10px] uppercase text-muted-foreground">Working dir</span>
					<input bind:value={cwd} class="w-56 rounded border bg-background px-2 py-1 text-xs font-mono" placeholder="/sandbox/work/repo" />
				</div>
				<div class="flex flex-col">
					<span class="text-[10px] uppercase text-muted-foreground">Port</span>
					<input type="number" bind:value={port} class="w-20 rounded border bg-background px-2 py-1 text-xs font-mono" />
				</div>
				<div class="flex flex-col">
					<span class="text-[10px] uppercase text-muted-foreground">Preview command</span>
					<input bind:value={previewCommand} class="w-52 rounded border bg-background px-2 py-1 text-xs font-mono" placeholder="auto (preview → dev)" />
				</div>
			{:else}
				<div class="flex flex-col">
					<span class="text-[10px] uppercase text-muted-foreground">Repo path</span>
					<input bind:value={repoPath} class="w-52 rounded border bg-background px-2 py-1 text-xs font-mono" placeholder="(auto-detect)" />
				</div>
				<div class="flex flex-col">
					<span class="text-[10px] uppercase text-muted-foreground">Install command</span>
					<input bind:value={installCommand} class="w-44 rounded border bg-background px-2 py-1 text-xs font-mono" placeholder="(auto)" />
				</div>
				<div class="flex flex-col">
					<span class="text-[10px] uppercase text-muted-foreground">Dev server command</span>
					<input bind:value={devServerCommand} class="w-44 rounded border bg-background px-2 py-1 text-xs font-mono" placeholder="(auto)" />
				</div>
			{/if}
			<button
				type="button"
				onclick={start}
				disabled={loading}
				class="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
			>
				{loading ? (provisioning ? "Provisioning…" : "Starting…") : ready ? "Restart preview" : "Start preview"}
			</button>
			{#if previewUrl && ready}
				<a href={pageUrl || previewUrl} target="_blank" rel="noreferrer" class="rounded border px-3 py-1.5 text-xs hover:bg-muted">Open in new tab ↗</a>
			{/if}
			{#if ready}<span class="text-xs text-emerald-600 dark:text-emerald-400">● live</span>{/if}
		</div>

		{#if provisioning}
			<div class="border-b bg-sky-50 px-4 py-2 text-xs text-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
				Provisioning a preview pod against this run's retained workspace (cold start, ~30–60s)…
			</div>
		{/if}
		{#if errorMessage}
			<div class="border-b bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">{errorMessage}</div>
		{/if}

		{#if previewUrl && ready}
			<iframe title="Run live preview" src={previewUrl} class="min-h-0 flex-1 border-0 bg-white"></iframe>
		{:else}
			<div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
				<p class="max-w-md">
					Live preview of the app this run's agents built in their shared workspace. Works after the
					run completes — set the options, then <strong>Start preview</strong>. The dev/preview
					server runs in-cluster and is proxied here over the tailnet.
				</p>
				{#if logText}
					<pre class="max-h-48 w-full max-w-2xl overflow-auto rounded bg-muted p-2 text-left text-[11px]">{logText}</pre>
				{/if}
			</div>
		{/if}
	{/if}
</div>
