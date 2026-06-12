<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { KeyRound, Loader2, Save, Terminal, Trash2 } from '@lucide/svelte';

	type TokenSummary = {
		provider: string;
		linked: boolean;
		expiresAt: string | null;
		lastValidatedAt: string | null;
		status: string | null;
	};
	type CliRuntime = {
		id: string;
		displayName: string;
		cliAuth: {
			provider: string;
			tokenKind: string;
			credentialKind: 'env_token' | 'file' | 'file_bundle' | 'device_login';
			loginStyle?: 'browser_token' | 'auth_file' | 'device_code';
			envVar?: string;
			credentialPath?: string;
			setupCommand?: string;
		};
	};

	const { data }: { data: { cliRuntimes: CliRuntime[]; tokensByProvider: Record<string, TokenSummary> } } =
		$props();

	// Server-loaded summaries with client-side overrides layered on top after
	// a save/delete — avoids capturing `data` into $state at init.
	let tokenOverrides = $state<Record<string, TokenSummary>>({});
	let drafts = $state<Record<string, string>>({});
	let busy = $state<Record<string, boolean>>({});
	let errors = $state<Record<string, string | null>>({});

	function summaryFor(provider: string): TokenSummary {
		return (
			tokenOverrides[provider] ??
			data.tokensByProvider[provider] ?? {
				provider,
				linked: false,
				expiresAt: null,
				lastValidatedAt: null,
				status: null
			}
		);
	}

	function expiryCountdown(expiresAt: string | null): { label: string; expired: boolean } | null {
		if (!expiresAt) return null;
		const ms = new Date(expiresAt).getTime() - Date.now();
		if (Number.isNaN(ms)) return null;
		if (ms <= 0) return { label: 'expired', expired: true };
		const days = Math.floor(ms / 86_400_000);
		if (days >= 1) return { label: `expires in ${days}d`, expired: false };
		const hours = Math.max(1, Math.floor(ms / 3_600_000));
		return { label: `expires in ${hours}h`, expired: false };
	}

	async function save(provider: string) {
		const token = (drafts[provider] ?? '').trim();
		if (!token || busy[provider]) return;
		busy = { ...busy, [provider]: true };
		errors = { ...errors, [provider]: null };
		try {
			const res = await fetch(
				`/api/v1/users/me/cli-tokens/${encodeURIComponent(provider)}`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ token })
				}
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { message?: string };
				errors = {
					...errors,
					[provider]: body.message ?? `Save failed (${res.status})`
				};
				return;
			}
			tokenOverrides = {
				...tokenOverrides,
				[provider]: (await res.json()) as TokenSummary
			};
			drafts = { ...drafts, [provider]: '' };
		} catch (err) {
			errors = {
				...errors,
				[provider]: err instanceof Error ? err.message : String(err)
			};
		} finally {
			busy = { ...busy, [provider]: false };
		}
	}

	async function remove(provider: string) {
		if (busy[provider]) return;
		if (!confirm('Remove this CLI token? New interactive sessions will fail until you re-link one.'))
			return;
		busy = { ...busy, [provider]: true };
		errors = { ...errors, [provider]: null };
		try {
			const res = await fetch(
				`/api/v1/users/me/cli-tokens/${encodeURIComponent(provider)}`,
				{ method: 'DELETE' }
			);
			if (!res.ok) {
				errors = { ...errors, [provider]: `Delete failed (${res.status})` };
				return;
			}
			tokenOverrides = {
				...tokenOverrides,
				[provider]: {
					provider,
					linked: false,
					expiresAt: null,
					lastValidatedAt: null,
					status: null
				}
			};
		} finally {
			busy = { ...busy, [provider]: false };
		}
	}
</script>

<div class="space-y-6">
	<div>
		<h2 class="text-lg font-semibold flex items-center gap-2">
			<KeyRound class="size-5" /> CLI tokens
		</h2>
		<p class="text-sm text-muted-foreground mt-1">
			Link your personal subscription tokens for interactive CLI runtimes. Tokens are encrypted at
			rest, are only injected into your own session pods, and are never shown again after saving.
		</p>
	</div>

	{#if data.cliRuntimes.length === 0}
		<Alert>
			<AlertDescription>No registered runtime requires a CLI token.</AlertDescription>
		</Alert>
	{/if}

	{#each data.cliRuntimes as runtime (runtime.id)}
		{@const summary = summaryFor(runtime.cliAuth.provider)}
		{@const countdown = expiryCountdown(summary.expiresAt)}
		{@const kind = runtime.cliAuth.credentialKind}
		{@const isFile = kind === 'file'}
		{@const isAutoCapture = kind === 'file_bundle'}
		{@const isTerminalLogin = kind === 'device_login' || kind === 'file_bundle'}
		<Card>
			<CardHeader>
				<CardTitle class="text-base flex items-center gap-2 flex-wrap">
					<Terminal class="size-4" />
					{runtime.displayName}
					<code class="text-[11px] font-normal text-muted-foreground">{runtime.id}</code>
					{#if kind === 'device_login'}
						<Badge variant="outline" class="text-[10px] gap-1 border-sky-500/40 text-sky-600 dark:text-sky-400">
							Terminal login
						</Badge>
					{:else if summary.linked}
						<Badge
							variant="outline"
							class="text-[10px] gap-1 bg-green-600/15 text-green-700 dark:text-green-400 border-transparent"
						>
							<span class="size-1.5 rounded-full bg-green-500"></span>
							{isAutoCapture ? 'Captured' : 'Linked'}
						</Badge>
						{#if countdown && !isAutoCapture}
							<Badge
								variant="outline"
								class="text-[10px] {countdown.expired
									? 'border-red-500/40 text-red-500'
									: 'border-amber-500/40 text-amber-600 dark:text-amber-400'}"
							>
								{countdown.label}
							</Badge>
						{/if}
					{:else if isAutoCapture}
						<Badge variant="outline" class="text-[10px] gap-1 border-sky-500/40 text-sky-600 dark:text-sky-400">
							Terminal login
						</Badge>
					{:else}
						<Badge variant="outline" class="text-[10px]">Not linked</Badge>
					{/if}
				</CardTitle>
				<CardDescription>
					{#if kind === 'device_login'}
						Authenticates in the terminal via {runtime.cliAuth.provider} OAuth (device code) —
						nothing is stored here.
					{:else if kind === 'file_bundle'}
						Log in once in a session terminal ({runtime.cliAuth.provider} device code); your login
						is captured automatically so future sessions boot already signed in.
					{:else if kind === 'file'}
						OAuth login file ({runtime.cliAuth.provider}) materialized in your session pod at
						<code class="text-[11px]">{runtime.cliAuth.credentialPath}</code>.
					{:else}
						Subscription OAuth token ({runtime.cliAuth.provider}) delivered to the session pod as
						<code class="text-[11px]">{runtime.cliAuth.envVar}</code>.
					{/if}
				</CardDescription>
			</CardHeader>
			<CardContent class="space-y-4">
				{#if isTerminalLogin}
					<!-- Terminal login: the user authenticates inside the web terminal.
					     file_bundle additionally auto-captures the login for reuse. -->
					<div class="rounded-md border bg-muted/30 p-3 text-xs space-y-1.5">
						<div class="font-medium">How sign-in works</div>
						<ol class="list-decimal list-inside space-y-1 text-muted-foreground">
							<li>Start a session with this runtime — the CLI opens in the web terminal.</li>
							<li>
								It prints a {runtime.cliAuth.provider} authorization URL (and a code). Open the URL
								on your own device, approve, then paste the returned code back into the terminal.
							</li>
							{#if isAutoCapture}
								<li>
									Your login is then <strong>captured automatically</strong> — future sessions boot
									already signed in, no repeat login.
								</li>
							{:else}
								<li>
									Usage stays on your own account. Nothing needs to be saved on this page.
								</li>
							{/if}
						</ol>
						{#if isAutoCapture && summary.linked}
							<div class="text-green-600 dark:text-green-400">
								✓ Login captured — your sessions boot signed in.
							</div>
						{/if}
					</div>
				{:else}
					{#if summary.linked}
						<div class="text-xs text-muted-foreground space-y-0.5">
							<div>
								Credential: <code class="font-mono"
									>{kind === 'file' ? 'auth.json ••••••' : 'sk-ant-oat••••••••••••'}</code
								>
							</div>
							<div>
								Last validated:
								{summary.lastValidatedAt
									? new Date(summary.lastValidatedAt).toLocaleString()
									: 'never'}
							</div>
						</div>
					{/if}

					<div class="rounded-md border bg-muted/30 p-3 text-xs space-y-1.5">
						<div class="font-medium">How to enroll</div>
						{#if kind === 'file'}
							<ol class="list-decimal list-inside space-y-1 text-muted-foreground">
								<li>
									On your own machine, run
									<code class="rounded bg-muted px-1 py-0.5">{runtime.cliAuth.setupCommand}</code>
									and complete the browser ChatGPT login.
								</li>
								<li>
									Paste the entire contents of
									<code class="rounded bg-muted px-1 py-0.5">~/.codex/auth.json</code> below.
									API-key logins are rejected — only the ChatGPT OAuth file keeps usage on your
									subscription.
								</li>
								<li>Codex auto-refreshes the token inside the session; re-paste if it ever expires.</li>
							</ol>
						{:else}
							<ol class="list-decimal list-inside space-y-1 text-muted-foreground">
								<li>
									On your own machine, run
									<code class="rounded bg-muted px-1 py-0.5">{runtime.cliAuth.setupCommand}</code>
									and complete the browser login.
								</li>
								<li>
									Copy the printed <code class="rounded bg-muted px-1 py-0.5">sk-ant-oat…</code> token
									and paste it below. API keys (<code class="rounded bg-muted px-1 py-0.5"
										>sk-ant-api…</code
									>) are rejected — they would bill the metered API instead of your subscription.
								</li>
								<li>Interactive TUI usage stays on your subscription limits, not workspace API spend.</li>
							</ol>
						{/if}
					</div>

					<div class="space-y-2">
						<Label for={`cli-token-${runtime.id}`}>
							{summary.linked
								? 'Replace credential'
								: kind === 'file'
									? 'Paste auth.json'
									: 'Paste token'}
						</Label>
						<div class="flex gap-2 {isFile ? 'flex-col' : ''}">
							{#if isFile}
								<textarea
									id={`cli-token-${runtime.id}`}
									class="flex min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									placeholder={'{ "tokens": { "access_token": …, "refresh_token": … } }'}
									autocomplete="off"
									spellcheck="false"
									bind:value={drafts[runtime.cliAuth.provider]}
								></textarea>
							{:else}
								<Input
									id={`cli-token-${runtime.id}`}
									type="password"
									placeholder="sk-ant-oat…"
									autocomplete="off"
									bind:value={drafts[runtime.cliAuth.provider]}
								/>
							{/if}
							<div class="flex gap-2 {kind === 'file' ? 'justify-end' : ''}">
								<Button
									size="sm"
									class="shrink-0 gap-1"
									disabled={!(drafts[runtime.cliAuth.provider] ?? '').trim() ||
										busy[runtime.cliAuth.provider]}
									onclick={() => save(runtime.cliAuth.provider)}
								>
									{#if busy[runtime.cliAuth.provider]}
										<Loader2 class="size-3.5 animate-spin" />
									{:else}
										<Save class="size-3.5" />
									{/if}
									Save
								</Button>
								{#if summary.linked}
									<Button
										size="sm"
										variant="outline"
										class="shrink-0 gap-1 text-destructive hover:text-destructive"
										disabled={busy[runtime.cliAuth.provider]}
										onclick={() => remove(runtime.cliAuth.provider)}
									>
										<Trash2 class="size-3.5" /> Delete
									</Button>
								{/if}
							</div>
						</div>
						{#if errors[runtime.cliAuth.provider]}
							<p class="text-xs text-destructive">{errors[runtime.cliAuth.provider]}</p>
						{/if}
					</div>
				{/if}
			</CardContent>
		</Card>
	{/each}
</div>
