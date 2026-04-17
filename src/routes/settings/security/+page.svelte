<script lang="ts">
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Shield, ExternalLink } from 'lucide-svelte';
</script>

<div class="space-y-6">
	<div>
		<h2 class="text-lg font-semibold flex items-center gap-2">
			<Shield class="size-4" /> Security and compliance
		</h2>
		<p class="text-xs text-muted-foreground mt-1">
			How this workspace protects your data.
		</p>
	</div>

	<Card>
		<CardHeader>
			<CardTitle class="text-base">Encryption</CardTitle>
			<CardDescription>At-rest encryption for credentials.</CardDescription>
		</CardHeader>
		<CardContent class="text-sm space-y-2">
			<p>
				<strong>Vault credentials</strong> — AES-256-CBC with a random IV per value. Key material
				lives in <code>AP_ENCRYPTION_KEY</code> (64-char hex or 32-byte binary).
			</p>
			<p>
				<strong>Proxy pattern</strong> — credentials are injected into outbound MCP/tool calls by
				<code>function-router</code> after the request leaves the sandbox. The agent container
				never sees the decrypted secret.
			</p>
			<p>
				<strong>Refresh token storage</strong> — OAuth refresh tokens are encrypted separately so
				access-token rotation doesn't decrypt the refresh token, and vice versa.
			</p>
		</CardContent>
	</Card>

	<Card>
		<CardHeader>
			<CardTitle class="text-base">Audit log</CardTitle>
			<CardDescription>What's tracked.</CardDescription>
		</CardHeader>
		<CardContent class="text-sm space-y-2">
			<p>
				<strong>Credential access</strong> — every vault decrypt writes to
				<code>credential_access_logs</code> with execution id + source + fallback reason.
			</p>
			<p>
				<strong>Vault refresh</strong> — every OAuth refresh attempt writes to
				<code>vault_credential_refresh_log</code> with status (success/failure), HTTP status, and
				any error message.
			</p>
			<p>
				<strong>Session events</strong> — all agent events persist in <code>session_events</code>
				with monotonic sequence numbers; enables exact replay.
			</p>
		</CardContent>
	</Card>

	<Card>
		<CardHeader>
			<CardTitle class="text-base">Session isolation</CardTitle>
		</CardHeader>
		<CardContent class="text-sm space-y-2">
			<p>
				Each session's tools run inside an OpenShell sandbox provisioned per the session's
				environment. Sandboxes are torn down when the session terminates (or per the
				environment's <code>keepAfterRun</code> / <code>ttlSeconds</code> policy).
			</p>
			<p>
				<a
					href="https://docs.openshell.io/security-model"
					class="text-primary hover:underline"
					target="_blank"
					rel="noreferrer"
				>
					OpenShell security model <ExternalLink class="inline size-3" />
				</a>
			</p>
		</CardContent>
	</Card>
</div>
