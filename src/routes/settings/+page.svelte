<script lang="ts">
	import { page } from '$app/stores';
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Card, CardHeader, CardTitle, CardContent } from '$lib/components/ui/card';
	import { Label } from '$lib/components/ui/label';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '$lib/components/ui/dialog';
	import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table';
	import { CircleAlert, Copy, Check, Lock, LockOpen, Trash2, Loader2, RefreshCw, Power, PowerOff, Plus, Globe } from 'lucide-svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { env } from '$env/dynamic/public';

	type ApiKey = {
		id: string;
		name: string | null;
		keyPrefix: string;
		createdAt: string;
		lastUsedAt: string | null;
	};

	let activeTab = $state('api-keys');
	let apiKeys = $state<ApiKey[]>([]);
	let loading = $state(false);
	let newKeyName = $state('');
	let creating = $state(false);
	let generatedKey = $state<string | null>(null);
	let showKeyDialog = $state(false);
	let deleteConfirmId = $state<string | null>(null);
	let deleting = $state(false);
	let errorMessage = $state<string | null>(null);
	let copiedField = $state<string | null>(null);

	// Server-loaded data
	const profile = $derived($page.data.profile as {
		id: string;
		name: string | null;
		email: string | null;
		image: string | null;
		platformId: string | null;
		platformRole: string | null;
	} | null);

	const baseUrl = $derived($page.data.baseUrl as string);

	// Database-loaded OAuth apps (enriched with display names and logos from server)
	const oauthApps = $derived(($page.data.oauthApps ?? []) as Array<{
		id: string;
		pieceName: string;
		clientId: string;
		displayName: string;
		logoUrl: string | null;
		createdAt: string;
		updatedAt: string;
	}>);

	// Redirect URI for OAuth apps
	const redirectUri = $derived(`${baseUrl}/redirect`);

	// OAuth app configure dialog
	let oauthDialogOpen = $state(false);
	let oauthDialogApp = $state<typeof oauthApps[number] | null>(null);
	let oauthClientId = $state('');
	let oauthClientSecret = $state('');
	let oauthSaving = $state(false);

	function openOauthDialog(app: typeof oauthApps[number]) {
		oauthDialogApp = app;
		oauthClientId = app.clientId;
		oauthClientSecret = '';
		oauthDialogOpen = true;
	}

	async function saveOauthApp() {
		if (!oauthDialogApp || !oauthClientId.trim()) return;
		oauthSaving = true;
		try {
			const res = await fetch('/api/settings/oauth-apps', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					id: oauthDialogApp.id,
					pieceName: oauthDialogApp.pieceName,
					clientId: oauthClientId.trim(),
					clientSecret: oauthClientSecret.trim() || undefined
				})
			});
			if (res.ok) {
				oauthDialogOpen = false;
				oauthDialogApp = null;
				toast.success('OAuth app updated');
				await invalidateAll();
			} else {
				toast.error('Failed to update OAuth app');
			}
		} catch {
			toast.error('Failed to update OAuth app');
		} finally {
			oauthSaving = false;
		}
	}

	async function deleteOauthApp(app: typeof oauthApps[number]) {
		try {
			const res = await fetch(`/api/settings/oauth-apps?id=${app.id}`, { method: 'DELETE' });
			if (res.ok) {
				toast.success(`Removed ${app.displayName}`);
				await invalidateAll();
			} else {
				toast.error('Failed to remove OAuth app');
			}
		} catch {
			toast.error('Failed to remove OAuth app');
		}
	}

	type ClaudeOAuthStatus = {
		authenticated: boolean;
		subscription_type?: string | null;
		email?: string | null;
		expires_at?: number | null;
		expired?: boolean;
		scopes?: string[];
	};

	let claudeOAuthStatus = $state<ClaudeOAuthStatus | null>(null);
	let claudeOAuthLoading = $state(false);
	let claudeOAuthBusy = $state(false);
	let claudeOAuthError = $state<string | null>(null);
	let claudeOAuthCode = $state('');
	let claudeOAuthRedirectUri = $state<string | null>(null);

	type OpenAIPendingLogin = {
		verification_url: string;
		user_code: string;
		interval: number;
		expires_at: number;
	};

	type OpenAIOAuthStatus = {
		authenticated: boolean;
		email?: string | null;
		chatgpt_plan_type?: string | null;
		chatgpt_user_id?: string | null;
		chatgpt_account_id?: string | null;
		expires_at?: number | null;
		expired?: boolean;
		pending_login?: OpenAIPendingLogin | null;
	};

	let openaiOAuthStatus = $state<OpenAIOAuthStatus | null>(null);
	let openaiOAuthLoading = $state(false);
	let openaiOAuthBusy = $state(false);
	let openaiOAuthError = $state<string | null>(null);
	let openaiPendingLogin = $state<OpenAIPendingLogin | null>(null);

	type GeminiOAuthStatus = {
		authenticated: boolean;
		email?: string | null;
		name?: string | null;
		expires_at?: number | null;
		expired?: boolean;
		scopes?: string[];
		vertex_configured?: boolean;
		project?: string | null;
		location?: string | null;
		oauth_mode?: string | null;
		pending_login?: { redirect_uri: string; scopes: string[]; created_at: number } | null;
	};

	let geminiOAuthStatus = $state<GeminiOAuthStatus | null>(null);
	let geminiOAuthLoading = $state(false);
	let geminiOAuthBusy = $state(false);
	let geminiOAuthError = $state<string | null>(null);
	let geminiOAuthCode = $state('');
	let geminiOAuthRedirectUri = $state<string | null>(null);

	function formatOAuthExpiry(value: number | null | undefined): string {
		if (!value) return 'Unknown';
		return new Date(value).toLocaleString();
	}

	async function readOAuthError(response: Response, fallback: string): Promise<string> {
		const body = await response.json().catch(() => null);
		if (body && typeof body.message === 'string') return body.message;
		if (body && typeof body.error === 'string') return body.error;
		return fallback;
	}

	async function loadClaudeOAuthStatus({ quiet = false }: { quiet?: boolean } = {}) {
		if (!quiet) claudeOAuthLoading = true;
		claudeOAuthError = null;
		try {
			const res = await fetch('/api/dapr-agent-py/oauth/status');
			if (!res.ok) throw new Error(await readOAuthError(res, 'Failed to load Claude OAuth status'));
			claudeOAuthStatus = await res.json();
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to load Claude OAuth status';
			claudeOAuthError = message;
			if (!quiet) toast.error(message);
		} finally {
			if (!quiet) claudeOAuthLoading = false;
		}
	}

	async function connectClaudeOAuth() {
		claudeOAuthBusy = true;
		claudeOAuthError = null;
		try {
			const res = await fetch('/api/dapr-agent-py/oauth/login', { method: 'POST' });
			if (!res.ok) throw new Error(await readOAuthError(res, 'Failed to start Claude OAuth'));
			const body = await res.json() as { authorize_url?: string; redirect_uri?: string };
			if (!body.authorize_url) throw new Error('Claude OAuth did not return an authorization URL');
			claudeOAuthRedirectUri = body.redirect_uri ?? null;
			window.open(body.authorize_url, 'claude-oauth', 'popup,width=960,height=720');
			toast.info('Authorize Claude, then paste the callback URL or code here.');
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to start Claude OAuth';
			claudeOAuthError = message;
			toast.error(message);
		} finally {
			claudeOAuthBusy = false;
		}
	}

	async function completeClaudeOAuth() {
		const code = claudeOAuthCode.trim();
		if (!code) {
			toast.error('Paste the Claude callback URL or authorization code first.');
			return;
		}
		claudeOAuthBusy = true;
		claudeOAuthError = null;
		try {
			const res = await fetch('/api/dapr-agent-py/oauth/complete', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code })
			});
			if (!res.ok) throw new Error(await readOAuthError(res, 'Failed to complete Claude OAuth'));
			claudeOAuthStatus = await res.json();
			claudeOAuthCode = '';
			toast.success('Claude OAuth connected');
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to complete Claude OAuth';
			claudeOAuthError = message;
			toast.error(message);
		} finally {
			claudeOAuthBusy = false;
		}
	}

	async function refreshClaudeOAuth() {
		claudeOAuthBusy = true;
		try {
			const res = await fetch('/api/dapr-agent-py/oauth/refresh', { method: 'POST' });
			if (!res.ok) throw new Error(await readOAuthError(res, 'Failed to refresh Claude OAuth token'));
			await loadClaudeOAuthStatus({ quiet: true });
			toast.success('Claude OAuth token refreshed');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Failed to refresh Claude OAuth token');
		} finally {
			claudeOAuthBusy = false;
		}
	}

	async function disconnectClaudeOAuth() {
		claudeOAuthBusy = true;
		try {
			const res = await fetch('/api/dapr-agent-py/oauth/logout', { method: 'POST' });
			if (!res.ok) throw new Error(await readOAuthError(res, 'Failed to disconnect Claude OAuth'));
			await loadClaudeOAuthStatus({ quiet: true });
			toast.success('Claude OAuth disconnected');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Failed to disconnect Claude OAuth');
		} finally {
			claudeOAuthBusy = false;
		}
	}

	async function loadOpenAIOAuthStatus({ quiet = false }: { quiet?: boolean } = {}) {
		if (!quiet) openaiOAuthLoading = true;
		openaiOAuthError = null;
		try {
			const res = await fetch('/api/dapr-agent-py/openai-oauth/status');
			if (!res.ok) throw new Error(await readOAuthError(res, 'Failed to load OpenAI OAuth status'));
			openaiOAuthStatus = await res.json();
			openaiPendingLogin = openaiOAuthStatus?.pending_login ?? openaiPendingLogin;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to load OpenAI OAuth status';
			openaiOAuthError = message;
			if (!quiet) toast.error(message);
		} finally {
			if (!quiet) openaiOAuthLoading = false;
		}
	}

	async function connectOpenAIOAuth() {
		openaiOAuthBusy = true;
		openaiOAuthError = null;
		try {
			const res = await fetch('/api/dapr-agent-py/openai-oauth/login', { method: 'POST' });
			if (!res.ok) throw new Error(await readOAuthError(res, 'Failed to start OpenAI OAuth'));
			const body = await res.json() as OpenAIPendingLogin & { completion_mode?: string };
			if (!body.verification_url || !body.user_code) {
				throw new Error('OpenAI OAuth did not return a device code');
			}
			openaiPendingLogin = body;
			window.open(body.verification_url, 'openai-oauth', 'popup,width=960,height=720');
			toast.info('Enter the OpenAI device code, then check authorization here.');
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to start OpenAI OAuth';
			openaiOAuthError = message;
			toast.error(message);
		} finally {
			openaiOAuthBusy = false;
		}
	}

	async function pollOpenAIOAuth({ quiet = false }: { quiet?: boolean } = {}) {
		openaiOAuthBusy = true;
		openaiOAuthError = null;
		try {
			const res = await fetch('/api/dapr-agent-py/openai-oauth/poll', { method: 'POST' });
			if (res.status === 202) {
				const body = await res.json();
				openaiPendingLogin = {
					verification_url: openaiPendingLogin?.verification_url ?? 'https://auth.openai.com/codex/device',
					user_code: openaiPendingLogin?.user_code ?? '',
					interval: body.interval ?? openaiPendingLogin?.interval ?? 5,
					expires_at: body.expires_at ?? openaiPendingLogin?.expires_at ?? 0
				};
				if (!quiet) toast.info('OpenAI authorization is still pending.');
				return;
			}
			if (!res.ok) throw new Error(await readOAuthError(res, 'Failed to complete OpenAI OAuth'));
			openaiOAuthStatus = await res.json();
			openaiPendingLogin = null;
			toast.success('OpenAI OAuth connected');
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to complete OpenAI OAuth';
			openaiOAuthError = message;
			toast.error(message);
		} finally {
			openaiOAuthBusy = false;
		}
	}

	async function refreshOpenAIOAuth() {
		openaiOAuthBusy = true;
		try {
			const res = await fetch('/api/dapr-agent-py/openai-oauth/refresh', { method: 'POST' });
			if (!res.ok) throw new Error(await readOAuthError(res, 'Failed to refresh OpenAI OAuth token'));
			await loadOpenAIOAuthStatus({ quiet: true });
			toast.success('OpenAI OAuth token refreshed');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Failed to refresh OpenAI OAuth token');
		} finally {
			openaiOAuthBusy = false;
		}
	}

	async function disconnectOpenAIOAuth() {
		openaiOAuthBusy = true;
		try {
			const res = await fetch('/api/dapr-agent-py/openai-oauth/logout', { method: 'POST' });
			if (!res.ok) throw new Error(await readOAuthError(res, 'Failed to disconnect OpenAI OAuth'));
			openaiPendingLogin = null;
			await loadOpenAIOAuthStatus({ quiet: true });
			toast.success('OpenAI OAuth disconnected');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Failed to disconnect OpenAI OAuth');
		} finally {
			openaiOAuthBusy = false;
		}
	}

	async function loadGeminiOAuthStatus({ quiet = false }: { quiet?: boolean } = {}) {
		if (!quiet) geminiOAuthLoading = true;
		geminiOAuthError = null;
		try {
			const res = await fetch('/api/dapr-agent-py/gemini-oauth/status');
			if (!res.ok) throw new Error(await readOAuthError(res, 'Failed to load Gemini OAuth status'));
			geminiOAuthStatus = await res.json();
			geminiOAuthRedirectUri = geminiOAuthStatus?.pending_login?.redirect_uri ?? geminiOAuthRedirectUri;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to load Gemini OAuth status';
			geminiOAuthError = message;
			if (!quiet) toast.error(message);
		} finally {
			if (!quiet) geminiOAuthLoading = false;
		}
	}

	async function connectGeminiOAuth() {
		geminiOAuthBusy = true;
		geminiOAuthError = null;
		try {
			const res = await fetch('/api/dapr-agent-py/gemini-oauth/login', { method: 'POST' });
			if (!res.ok) throw new Error(await readOAuthError(res, 'Failed to start Gemini OAuth'));
			const body = await res.json() as { authorize_url?: string; redirect_uri?: string };
			if (!body.authorize_url) throw new Error('Gemini OAuth did not return an authorization URL');
			geminiOAuthRedirectUri = body.redirect_uri ?? null;
			window.open(body.authorize_url, 'gemini-oauth', 'popup,width=960,height=720');
			toast.info('Authorize Google, then paste the returned code here.');
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to start Gemini OAuth';
			geminiOAuthError = message;
			toast.error(message);
		} finally {
			geminiOAuthBusy = false;
		}
	}

	async function completeGeminiOAuth() {
		const code = geminiOAuthCode.trim();
		if (!code) {
			toast.error('Paste the Gemini callback URL or authorization code first.');
			return;
		}
		geminiOAuthBusy = true;
		geminiOAuthError = null;
		try {
			const res = await fetch('/api/dapr-agent-py/gemini-oauth/complete', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code })
			});
			if (!res.ok) throw new Error(await readOAuthError(res, 'Failed to complete Gemini OAuth'));
			geminiOAuthStatus = await res.json();
			geminiOAuthCode = '';
			toast.success('Gemini OAuth connected');
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to complete Gemini OAuth';
			geminiOAuthError = message;
			toast.error(message);
		} finally {
			geminiOAuthBusy = false;
		}
	}

	async function refreshGeminiOAuth() {
		geminiOAuthBusy = true;
		try {
			const res = await fetch('/api/dapr-agent-py/gemini-oauth/refresh', { method: 'POST' });
			if (!res.ok) throw new Error(await readOAuthError(res, 'Failed to refresh Gemini OAuth token'));
			await loadGeminiOAuthStatus({ quiet: true });
			toast.success('Gemini OAuth token refreshed');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Failed to refresh Gemini OAuth token');
		} finally {
			geminiOAuthBusy = false;
		}
	}

	async function disconnectGeminiOAuth() {
		geminiOAuthBusy = true;
		try {
			const res = await fetch('/api/dapr-agent-py/gemini-oauth/logout', { method: 'POST' });
			if (!res.ok) throw new Error(await readOAuthError(res, 'Failed to disconnect Gemini OAuth'));
			await loadGeminiOAuthStatus({ quiet: true });
			toast.success('Gemini OAuth disconnected');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Failed to disconnect Gemini OAuth');
		} finally {
			geminiOAuthBusy = false;
		}
	}

	// MCP Connections
	interface McpConnection {
		id: string;
		displayName: string;
		sourceType: string;
		pieceName: string | null;
		connectionExternalId: string | null;
		serverUrl: string | null;
		status: string;
		metadata: Record<string, unknown> | null;
		createdAt: string;
	}

	interface AppConnection {
		externalId: string;
		pieceName: string;
		displayName: string;
		providerId: string;
		providerLabel: string;
		status: string;
		type: string;
	}

	let mcpConnections = $state<McpConnection[]>([]);
	let appConnections = $state<AppConnection[]>([]);
	let mcpLoading = $state(false);
	let mcpCustomName = $state('');
	let mcpCustomUrl = $state('');
	let mcpCreating = $state(false);
	let mcpBusyId = $state<string | null>(null);

	async function loadMcpConnections() {
		mcpLoading = true;
		try {
			const res = await fetch('/api/mcp-connections');
			if (res.ok) mcpConnections = await res.json();
		} catch { /* */ } finally { mcpLoading = false; }
	}

	async function loadAppConnections() {
		try {
			const res = await fetch('/api/app-connections');
			if (res.ok) appConnections = await res.json();
		} catch { /* */ }
	}

	async function createMcpCustom() {
		if (!mcpCustomName.trim() || !mcpCustomUrl.trim()) return;
		mcpCreating = true;
		try {
			const res = await fetch('/api/mcp-connections', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ displayName: mcpCustomName.trim(), serverUrl: mcpCustomUrl.trim(), sourceType: 'custom_url' })
			});
			if (res.ok) {
				mcpCustomName = '';
				mcpCustomUrl = '';
				toast.success('MCP connection created');
				await loadMcpConnections();
			} else { toast.error('Failed to create connection'); }
		} catch { toast.error('Failed to create connection'); } finally { mcpCreating = false; }
	}

	async function toggleMcpStatus(conn: McpConnection) {
		mcpBusyId = conn.id;
		const newStatus = conn.status === 'ENABLED' ? 'DISABLED' : 'ENABLED';
		try {
			const res = await fetch(`/api/mcp-connections/${conn.id}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: newStatus })
			});
			if (res.ok) { toast.success(`${conn.displayName} ${newStatus.toLowerCase()}`); await loadMcpConnections(); }
			else { toast.error('Failed to update status'); }
		} catch { toast.error('Failed to update status'); } finally { mcpBusyId = null; }
	}

	async function updateMcpCredential(conn: McpConnection, connectionExternalId: string) {
		mcpBusyId = conn.id;
		try {
			const res = await fetch(`/api/mcp-connections/${conn.id}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ connectionExternalId: connectionExternalId || null })
			});
			if (res.ok) {
				toast.success('MCP credential binding updated');
				await loadMcpConnections();
			} else {
				const data = await res.json().catch(() => ({}));
				toast.error(data.message || 'Failed to update credential binding');
			}
		} catch {
			toast.error('Failed to update credential binding');
		} finally {
			mcpBusyId = null;
		}
	}

	async function deleteMcpConnection(conn: McpConnection) {
		mcpBusyId = conn.id;
		try {
			const res = await fetch(`/api/mcp-connections/${conn.id}`, { method: 'DELETE' });
			if (res.ok) { toast.success(`Deleted ${conn.displayName}`); await loadMcpConnections(); }
			else { const data = await res.json().catch(() => ({})); toast.error(data.message || 'Failed to delete'); }
		} catch { toast.error('Failed to delete'); } finally { mcpBusyId = null; }
	}

	function mcpSourceLabel(type: string): string {
		switch (type) {
			case 'nimble_piece': return 'Piece';
			case 'nimble_shared': return 'Shared';
			case 'custom_url': return 'Custom';
			case 'hosted_workflow': return 'Hosted';
			default: return type;
		}
	}

	function mcpToolCount(conn: McpConnection): number {
		return (conn.metadata as Record<string, unknown>)?.toolCount as number ?? 0;
	}

	function normalizePieceName(value: string | null | undefined): string {
		return (value || '')
			.trim()
			.toLowerCase()
			.replace(/^@activepieces\/piece-/, '')
			.replace(/[_\s]+/g, '-')
			.replace(/-+/g, '-');
	}

	function appConnectionsForMcp(conn: McpConnection): AppConnection[] {
		const piece = normalizePieceName(conn.pieceName);
		if (!piece) return [];
		return appConnections.filter((app) => normalizePieceName(app.pieceName) === piece && app.status === 'ACTIVE');
	}

	async function loadApiKeys() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/settings/api-keys');
			if (res.ok) {
				apiKeys = await res.json();
			} else {
				errorMessage = 'Failed to load API keys';
			}
		} catch {
			errorMessage = 'Failed to load API keys';
		} finally {
			loading = false;
		}
	}

	async function createApiKey() {
		if (!newKeyName.trim()) return;
		creating = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/settings/api-keys', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newKeyName.trim() })
			});
			if (res.ok) {
				const data = await res.json();
				generatedKey = data.key;
				showKeyDialog = true;
				newKeyName = '';
				await loadApiKeys();
			} else {
				const err = await res.json().catch(() => ({}));
				errorMessage = err.message || 'Failed to create API key';
			}
		} catch {
			errorMessage = 'Failed to create API key';
		} finally {
			creating = false;
		}
	}

	async function deleteApiKey(id: string) {
		deleting = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/settings/api-keys/${id}`, { method: 'DELETE' });
			if (res.ok) {
				deleteConfirmId = null;
				await loadApiKeys();
			} else {
				errorMessage = 'Failed to delete API key';
			}
		} catch {
			errorMessage = 'Failed to delete API key';
		} finally {
			deleting = false;
		}
	}

	function formatDate(dateStr: string | null): string {
		if (!dateStr) return 'Never';
		return new Date(dateStr).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function copyToClipboard(text: string, field?: string) {
		navigator.clipboard.writeText(text);
		if (field) {
			copiedField = field;
			setTimeout(() => {
				copiedField = null;
			}, 2000);
		}
	}

	// Load API keys on mount
	$effect(() => {
		if (activeTab === 'api-keys') {
			loadApiKeys();
		}
		if (activeTab === 'claude-oauth' && !claudeOAuthStatus && !claudeOAuthLoading) {
			void loadClaudeOAuthStatus();
		}
		if (activeTab === 'openai-oauth' && !openaiOAuthStatus && !openaiOAuthLoading) {
			void loadOpenAIOAuthStatus();
		}
		if (activeTab === 'gemini-oauth' && !geminiOAuthStatus && !geminiOAuthLoading) {
			void loadGeminiOAuthStatus();
		}
	});
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center border-b border-border px-6">
		<h1 class="text-sm font-semibold tracking-tight">Settings</h1>
	</header>
	<div class="flex-1 overflow-auto p-6">
		<div class="mx-auto max-w-5xl">
			<Tabs value={activeTab} onValueChange={(v) => { activeTab = v; if (v === 'mcp-connections') { if (mcpConnections.length === 0) loadMcpConnections(); if (appConnections.length === 0) loadAppConnections(); } }}>
				<TabsList class="mb-6 h-9">
					<TabsTrigger value="api-keys" class="text-xs px-3">API Keys</TabsTrigger>
					<TabsTrigger value="profile" class="text-xs px-3">Profile</TabsTrigger>
					<TabsTrigger value="claude-oauth" class="text-xs px-3">Claude OAuth</TabsTrigger>
					<TabsTrigger value="openai-oauth" class="text-xs px-3">OpenAI OAuth</TabsTrigger>
					<TabsTrigger value="gemini-oauth" class="text-xs px-3">Gemini OAuth</TabsTrigger>
					<TabsTrigger value="oauth-apps" class="text-xs px-3">OAuth Apps</TabsTrigger>
					<TabsTrigger value="mcp-connections" class="text-xs px-3">MCP Connections</TabsTrigger>
				</TabsList>

				<!-- API Keys Tab -->
				<TabsContent value="api-keys">
					<div class="space-y-6">
						<div>
							<h2 class="text-base font-semibold">API Keys</h2>
							<p class="text-sm text-muted-foreground">
								Create and manage API keys for programmatic access to the workflow builder.
							</p>
						</div>

						{#if errorMessage}
							<Alert variant="destructive">
								<CircleAlert class="size-4" />
								<AlertDescription>{errorMessage}</AlertDescription>
							</Alert>
						{/if}

						<!-- Create new key -->
						<Card>
							<CardContent class="pt-6">
								<div class="flex items-end gap-3">
									<div class="flex-1 space-y-1.5">
										<Label for="key-name">Key Name</Label>
										<Input
											id="key-name"
											placeholder="e.g. CI/CD Pipeline"
											value={newKeyName}
											oninput={(e) => {
												newKeyName = e.currentTarget.value;
											}}
											onkeydown={(e) => {
												if (e.key === 'Enter') createApiKey();
											}}
										/>
									</div>
									<Button onclick={createApiKey} disabled={creating || !newKeyName.trim()}>
										{creating ? 'Creating...' : 'Generate Key'}
									</Button>
								</div>
							</CardContent>
						</Card>

						<!-- Keys list -->
						{#if loading}
							<div class="py-8 text-center text-sm text-muted-foreground">Loading API keys...</div>
						{:else if apiKeys.length === 0}
							<Card>
								<CardContent class="py-8 text-center">
									<p class="text-sm text-muted-foreground">
										No API keys yet. Create one above to get started.
									</p>
								</CardContent>
							</Card>
						{:else}
							<div class="space-y-3">
								{#each apiKeys as key (key.id)}
									<Card>
										<CardContent class="flex items-center justify-between py-4">
											<div class="min-w-0 flex-1">
												<div class="flex items-center gap-2">
													<span class="text-sm font-medium">{key.name || 'Unnamed'}</span>
													<Badge variant="outline">
														<code class="text-xs">{key.keyPrefix}</code>
													</Badge>
													<Badge variant="secondary" class="text-xs">Active</Badge>
												</div>
												<div class="mt-1 flex gap-4 text-xs text-muted-foreground">
													<span>Created: {formatDate(key.createdAt)}</span>
													<span>Last used: {formatDate(key.lastUsedAt)}</span>
												</div>
											</div>
											<div>
												{#if deleteConfirmId === key.id}
													<div class="flex items-center gap-2">
														<span class="text-xs text-muted-foreground">Delete?</span>
														<Button
															size="sm"
															variant="destructive"
															onclick={() => deleteApiKey(key.id)}
															disabled={deleting}
														>
															{deleting ? '...' : 'Yes'}
														</Button>
														<Button
															size="sm"
															variant="outline"
															onclick={() => (deleteConfirmId = null)}
														>
															No
														</Button>
													</div>
												{:else}
													<Button
														size="sm"
														variant="ghost"
														onclick={() => (deleteConfirmId = key.id)}
													>
														Delete
													</Button>
												{/if}
											</div>
										</CardContent>
									</Card>
								{/each}
							</div>
						{/if}
					</div>
				</TabsContent>

				<!-- Profile Tab -->
				<TabsContent value="profile">
					<div class="space-y-6">
						<div>
							<h2 class="text-base font-semibold">Profile</h2>
							<p class="text-sm text-muted-foreground">Your account information.</p>
						</div>

						{#if profile}
							<Card>
								<CardHeader>
									<CardTitle class="text-sm">Profile</CardTitle>
								</CardHeader>
								<CardContent class="space-y-3">
									<div class="flex items-center justify-between">
										<Label class="text-muted-foreground">Name</Label>
										<span class="text-sm">{profile.name || 'Not set'}</span>
									</div>
									<div class="flex items-center justify-between">
										<Label class="text-muted-foreground">Email</Label>
										<span class="text-sm">{profile.email || 'Not set'}</span>
									</div>
									<div class="flex items-center justify-between">
										<Label class="text-muted-foreground">Avatar</Label>
										<div>
											{#if profile.image}
												<img
													src={profile.image}
													alt="Avatar"
													class="h-8 w-8 rounded-full"
												/>
											{:else}
												<div
													class="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium"
												>
													{(profile.name || profile.email || '?').charAt(0).toUpperCase()}
												</div>
											{/if}
										</div>
									</div>
									<div class="flex items-center justify-between">
										<Label class="text-muted-foreground">Platform ID</Label>
										<code class="rounded bg-muted px-2 py-0.5 text-xs"
											>{profile.platformId || 'Not set'}</code
										>
									</div>
									<div class="flex items-center justify-between">
										<Label class="text-muted-foreground">User ID</Label>
										<code class="rounded bg-muted px-2 py-0.5 text-xs">{profile.id}</code>
									</div>
								</CardContent>
							</Card>
						{:else}
							<Card>
								<CardContent class="py-8 text-center">
									<p class="text-sm text-muted-foreground">No session found. Please sign in.</p>
								</CardContent>
							</Card>
						{/if}
					</div>
				</TabsContent>

				<!-- Claude OAuth Tab -->
				<TabsContent value="claude-oauth">
					<div class="space-y-6">
						<div>
							<h2 class="text-base font-semibold">Claude OAuth</h2>
							<p class="text-sm text-muted-foreground">
								Connect Claude subscription authentication for dapr-agent-py Anthropic calls.
							</p>
						</div>

						{#if claudeOAuthError}
							<Alert variant="destructive">
								<CircleAlert class="size-4" />
								<AlertDescription>{claudeOAuthError}</AlertDescription>
							</Alert>
						{/if}

						<Card>
							<CardHeader>
								<CardTitle class="flex items-center gap-2 text-sm">
									<Globe size={16} />
									dapr-agent-py
								</CardTitle>
							</CardHeader>
							<CardContent class="space-y-4">
								{#if claudeOAuthLoading}
									<div class="flex items-center gap-2 text-sm text-muted-foreground">
										<Loader2 size={14} class="animate-spin" />
										Loading Claude OAuth status...
									</div>
								{:else}
									<div class="flex flex-wrap items-center gap-2">
										{#if claudeOAuthStatus?.authenticated}
											<Badge variant="default" class="gap-1">
												<Lock size={11} />
												Connected
											</Badge>
											{#if claudeOAuthStatus.expired}
												<Badge variant="destructive">Expired</Badge>
											{/if}
										{:else}
											<Badge variant="secondary" class="gap-1">
												<LockOpen size={11} />
												Not connected
											</Badge>
										{/if}
									</div>

									<div class="grid gap-3 rounded-md border border-border p-3 text-sm sm:grid-cols-2">
										<div>
											<p class="text-xs text-muted-foreground">Account</p>
											<p class="truncate font-medium">{claudeOAuthStatus?.email || 'Not connected'}</p>
										</div>
										<div>
											<p class="text-xs text-muted-foreground">Subscription</p>
											<p class="font-medium">{claudeOAuthStatus?.subscription_type || 'Unknown'}</p>
										</div>
										<div>
											<p class="text-xs text-muted-foreground">Token Expires</p>
											<p class="font-medium">{formatOAuthExpiry(claudeOAuthStatus?.expires_at)}</p>
										</div>
										<div>
											<p class="text-xs text-muted-foreground">Scopes</p>
											<p class="truncate font-mono text-xs">{claudeOAuthStatus?.scopes?.join(' ') || 'None'}</p>
										</div>
									</div>
								{/if}

								<div class="flex flex-wrap gap-2">
									<Button onclick={connectClaudeOAuth} disabled={claudeOAuthBusy}>
										{#if claudeOAuthBusy}<Loader2 size={12} class="animate-spin" />{/if}
										{claudeOAuthStatus?.authenticated ? 'Reconnect Claude' : 'Connect Claude'}
									</Button>
									<Button variant="outline" onclick={() => loadClaudeOAuthStatus()} disabled={claudeOAuthLoading || claudeOAuthBusy}>
										<RefreshCw size={12} />
										Refresh Status
									</Button>
									{#if claudeOAuthStatus?.authenticated}
										<Button variant="outline" onclick={refreshClaudeOAuth} disabled={claudeOAuthBusy}>
											Refresh Token
										</Button>
										<Button variant="ghost" onclick={disconnectClaudeOAuth} disabled={claudeOAuthBusy}>
											Disconnect
										</Button>
									{/if}
								</div>

								{#if !claudeOAuthStatus?.authenticated}
									<div class="space-y-2">
										<Label for="claude-oauth-code">Callback URL or authorization code</Label>
										<textarea
											id="claude-oauth-code"
											class="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
											placeholder="Paste the Claude callback URL or code after authorizing."
											bind:value={claudeOAuthCode}
										></textarea>
										<div class="flex flex-wrap items-center gap-2">
											<Button variant="outline" onclick={completeClaudeOAuth} disabled={claudeOAuthBusy || !claudeOAuthCode.trim()}>
												Complete Connection
											</Button>
											{#if claudeOAuthRedirectUri}
												<span class="text-xs text-muted-foreground">
													Claude redirects to {claudeOAuthRedirectUri}
												</span>
											{/if}
										</div>
									</div>
								{/if}

								<p class="text-xs text-muted-foreground">
									The browser authorizes at claude.ai, then Claude returns a code on its registered callback page. Paste that URL or code here so dapr-agent-py can store tokens in its Dapr state store.
								</p>
							</CardContent>
						</Card>
					</div>
				</TabsContent>

				<!-- OpenAI OAuth Tab -->
				<TabsContent value="openai-oauth">
					<div class="space-y-6">
						<div>
							<h2 class="text-base font-semibold">OpenAI OAuth</h2>
							<p class="text-sm text-muted-foreground">
								Connect ChatGPT subscription authentication for dapr-agent-py OpenAI model calls.
							</p>
						</div>

						{#if openaiOAuthError}
							<Alert variant="destructive">
								<CircleAlert class="size-4" />
								<AlertDescription>{openaiOAuthError}</AlertDescription>
							</Alert>
						{/if}

						<Card>
							<CardHeader>
								<CardTitle class="flex items-center gap-2 text-sm">
									<Globe size={16} />
									dapr-agent-py
								</CardTitle>
							</CardHeader>
							<CardContent class="space-y-4">
								{#if openaiOAuthLoading}
									<div class="flex items-center gap-2 text-sm text-muted-foreground">
										<Loader2 size={14} class="animate-spin" />
										Loading OpenAI OAuth status...
									</div>
								{:else}
									<div class="flex flex-wrap items-center gap-2">
										{#if openaiOAuthStatus?.authenticated}
											<Badge variant="default" class="gap-1">
												<Lock size={11} />
												Connected
											</Badge>
											{#if openaiOAuthStatus.expired}
												<Badge variant="destructive">Expired</Badge>
											{/if}
										{:else}
											<Badge variant="secondary" class="gap-1">
												<LockOpen size={11} />
												Not connected
											</Badge>
										{/if}
									</div>

									<div class="grid gap-3 rounded-md border border-border p-3 text-sm sm:grid-cols-2">
										<div>
											<p class="text-xs text-muted-foreground">Account</p>
											<p class="truncate font-medium">{openaiOAuthStatus?.email || 'Not connected'}</p>
										</div>
										<div>
											<p class="text-xs text-muted-foreground">Plan</p>
											<p class="font-medium">{openaiOAuthStatus?.chatgpt_plan_type || 'Unknown'}</p>
										</div>
										<div>
											<p class="text-xs text-muted-foreground">Token Expires</p>
											<p class="font-medium">{formatOAuthExpiry(openaiOAuthStatus?.expires_at)}</p>
										</div>
										<div>
											<p class="text-xs text-muted-foreground">Account ID</p>
											<p class="truncate font-mono text-xs">{openaiOAuthStatus?.chatgpt_account_id || 'None'}</p>
										</div>
									</div>
								{/if}

								<div class="flex flex-wrap gap-2">
									<Button onclick={connectOpenAIOAuth} disabled={openaiOAuthBusy}>
										{#if openaiOAuthBusy}<Loader2 size={12} class="animate-spin" />{/if}
										{openaiOAuthStatus?.authenticated ? 'Reconnect OpenAI' : 'Connect OpenAI'}
									</Button>
									<Button variant="outline" onclick={() => loadOpenAIOAuthStatus()} disabled={openaiOAuthLoading || openaiOAuthBusy}>
										<RefreshCw size={12} />
										Refresh Status
									</Button>
									{#if openaiOAuthStatus?.authenticated}
										<Button variant="outline" onclick={refreshOpenAIOAuth} disabled={openaiOAuthBusy}>
											Refresh Token
										</Button>
										<Button variant="ghost" onclick={disconnectOpenAIOAuth} disabled={openaiOAuthBusy}>
											Disconnect
										</Button>
									{/if}
								</div>

								{#if !openaiOAuthStatus?.authenticated && openaiPendingLogin}
									<div class="space-y-3 rounded-md border border-border p-3">
										<div class="space-y-1">
											<Label>Device Code</Label>
											<div class="flex items-center gap-2">
												<code class="rounded bg-muted px-3 py-1.5 font-mono text-lg font-semibold tracking-wider">
													{openaiPendingLogin.user_code}
												</code>
												<Button
													variant="outline"
													size="sm"
													onclick={() => copyToClipboard(openaiPendingLogin?.user_code ?? '', 'openai-code')}
												>
													{#if copiedField === 'openai-code'}
														<Check size={12} class="text-green-500" />
													{:else}
														<Copy size={12} />
													{/if}
												</Button>
											</div>
										</div>
										<div class="space-y-1">
											<Label>Authorization Page</Label>
											<div class="flex min-w-0 items-center gap-2">
												<code class="min-w-0 flex-1 truncate rounded bg-muted px-3 py-1.5 font-mono text-xs">
													{openaiPendingLogin.verification_url}
												</code>
												<Button
													variant="outline"
													size="sm"
													onclick={() => window.open(openaiPendingLogin?.verification_url, 'openai-oauth', 'popup,width=960,height=720')}
												>
													Open
												</Button>
											</div>
										</div>
										<div class="flex flex-wrap items-center gap-2">
											<Button variant="outline" onclick={() => pollOpenAIOAuth()} disabled={openaiOAuthBusy}>
												Check Authorization
											</Button>
											<span class="text-xs text-muted-foreground">
												Code expires {formatOAuthExpiry(openaiPendingLogin.expires_at)}
											</span>
										</div>
									</div>
								{/if}

								<p class="text-xs text-muted-foreground">
									The browser authorizes at auth.openai.com using the same device-code pattern as Codex. dapr-agent-py stores the resulting tokens in its Dapr state store and uses them for OpenAI Responses API calls, with OPENAI_API_KEY as fallback.
								</p>
							</CardContent>
						</Card>
					</div>
				</TabsContent>

				<!-- Gemini OAuth Tab -->
				<TabsContent value="gemini-oauth">
					<div class="space-y-6">
						<div>
							<h2 class="text-base font-semibold">Gemini OAuth</h2>
							<p class="text-sm text-muted-foreground">
								Connect Google OAuth for dapr-agent-py Gemini calls through Vertex AI.
							</p>
						</div>

						{#if geminiOAuthError}
							<Alert variant="destructive">
								<CircleAlert class="size-4" />
								<AlertDescription>{geminiOAuthError}</AlertDescription>
							</Alert>
						{/if}

						{#if geminiOAuthStatus && !geminiOAuthStatus.vertex_configured}
							<Alert>
								<CircleAlert class="size-4" />
								<AlertDescription>
									Set GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION on dapr-agent-py before OAuth tokens can be used for Vertex AI Gemini calls.
								</AlertDescription>
							</Alert>
						{/if}

						<Card>
							<CardHeader>
								<CardTitle class="flex items-center gap-2 text-sm">
									<Globe size={16} />
									dapr-agent-py
								</CardTitle>
							</CardHeader>
							<CardContent class="space-y-4">
								{#if geminiOAuthLoading}
									<div class="flex items-center gap-2 text-sm text-muted-foreground">
										<Loader2 size={14} class="animate-spin" />
										Loading Gemini OAuth status...
									</div>
								{:else}
									<div class="flex flex-wrap items-center gap-2">
										{#if geminiOAuthStatus?.authenticated}
											<Badge variant="default" class="gap-1">
												<Lock size={11} />
												Connected
											</Badge>
											{#if geminiOAuthStatus.expired}
												<Badge variant="destructive">Expired</Badge>
											{/if}
										{:else}
											<Badge variant="secondary" class="gap-1">
												<LockOpen size={11} />
												Not connected
											</Badge>
										{/if}
										{#if geminiOAuthStatus?.vertex_configured}
											<Badge variant="outline">Vertex AI configured</Badge>
										{:else}
											<Badge variant="secondary">Vertex AI not configured</Badge>
										{/if}
									</div>

									<div class="grid gap-3 rounded-md border border-border p-3 text-sm sm:grid-cols-2">
										<div>
											<p class="text-xs text-muted-foreground">Account</p>
											<p class="truncate font-medium">{geminiOAuthStatus?.email || 'Not connected'}</p>
										</div>
										<div>
											<p class="text-xs text-muted-foreground">Name</p>
											<p class="truncate font-medium">{geminiOAuthStatus?.name || 'Unknown'}</p>
										</div>
										<div>
											<p class="text-xs text-muted-foreground">Token Expires</p>
											<p class="font-medium">{formatOAuthExpiry(geminiOAuthStatus?.expires_at)}</p>
										</div>
										<div>
											<p class="text-xs text-muted-foreground">Vertex AI</p>
											<p class="truncate font-mono text-xs">
												{geminiOAuthStatus?.project && geminiOAuthStatus?.location
													? `${geminiOAuthStatus.project}/${geminiOAuthStatus.location}`
													: 'Not configured'}
											</p>
										</div>
										<div class="sm:col-span-2">
											<p class="text-xs text-muted-foreground">Scopes</p>
											<p class="truncate font-mono text-xs">{geminiOAuthStatus?.scopes?.join(' ') || 'None'}</p>
										</div>
									</div>
								{/if}

								<div class="flex flex-wrap gap-2">
									<Button onclick={connectGeminiOAuth} disabled={geminiOAuthBusy}>
										{#if geminiOAuthBusy}<Loader2 size={12} class="animate-spin" />{/if}
										{geminiOAuthStatus?.authenticated ? 'Reconnect Gemini' : 'Connect Gemini'}
									</Button>
									<Button variant="outline" onclick={() => loadGeminiOAuthStatus()} disabled={geminiOAuthLoading || geminiOAuthBusy}>
										<RefreshCw size={12} />
										Refresh Status
									</Button>
									{#if geminiOAuthStatus?.authenticated}
										<Button variant="outline" onclick={refreshGeminiOAuth} disabled={geminiOAuthBusy}>
											Refresh Token
										</Button>
										<Button variant="ghost" onclick={disconnectGeminiOAuth} disabled={geminiOAuthBusy}>
											Disconnect
										</Button>
									{/if}
								</div>

								{#if !geminiOAuthStatus?.authenticated}
									<div class="space-y-2">
										<Label for="gemini-oauth-code">Authorization code or callback URL</Label>
										<textarea
											id="gemini-oauth-code"
											class="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
											placeholder="Paste the code shown by Google's Gemini Code Assist page, or a callback URL when custom web OAuth is enabled."
											bind:value={geminiOAuthCode}
										></textarea>
										<div class="flex flex-wrap items-center gap-2">
											<Button variant="outline" onclick={completeGeminiOAuth} disabled={geminiOAuthBusy || !geminiOAuthCode.trim()}>
												Complete Connection
											</Button>
											{#if geminiOAuthRedirectUri}
												<span class="text-xs text-muted-foreground">
													Google sends the code to {geminiOAuthRedirectUri}
												</span>
											{/if}
										</div>
									</div>
								{/if}

								<p class="text-xs text-muted-foreground">
									The browser authorizes with Google using the Gemini CLI manual-code flow, PKCE, and cloud-platform scope. dapr-agent-py stores tokens in its Dapr state store and uses them for Vertex AI Gemini calls when GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION are set.
								</p>
							</CardContent>
						</Card>
					</div>
				</TabsContent>

				<!-- OAuth Apps Tab -->
				<TabsContent value="oauth-apps">
					<div class="space-y-4">
						<!-- Redirect URI helper -->
						<Card class="bg-muted/30">
							<CardContent class="py-3 space-y-1.5">
								<div>
									<Label class="text-xs font-medium">Redirect URI</Label>
									<p class="text-[10px] text-muted-foreground">Use this as the redirect/callback URI when registering OAuth apps with providers.</p>
								</div>
								<div class="flex items-center gap-2">
									<code class="flex-1 rounded-md bg-muted px-3 py-1.5 font-mono text-[11px] truncate">{redirectUri}</code>
									<Button
										variant="outline"
										size="sm"
										class="h-7 shrink-0"
										onclick={() => copyToClipboard(redirectUri, 'redirect-uri')}
									>
										{#if copiedField === 'redirect-uri'}
											<Check size={12} class="text-green-500" />
										{:else}
											<Copy size={12} />
										{/if}
									</Button>
								</div>
							</CardContent>
						</Card>

						<!-- OAuth Apps Table -->
						{#if oauthApps.length === 0}
							<div class="py-12 text-center text-sm text-muted-foreground">
								No OAuth apps configured. Sync piece metadata first.
							</div>
						{:else}
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Piece</TableHead>
										<TableHead>Client ID</TableHead>
										<TableHead>Status</TableHead>
										<TableHead class="text-right">Actions</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{#each oauthApps as app (app.id)}
										<TableRow>
											<TableCell>
												<div class="flex items-center gap-2">
													{#if app.logoUrl}
														<img src={app.logoUrl} alt={app.displayName} class="h-5 w-5 rounded" />
													{:else}
														<div class="flex h-5 w-5 items-center justify-center rounded bg-muted text-[9px] font-medium">
															{app.displayName.charAt(0)}
														</div>
													{/if}
													<span class="text-xs font-medium">{app.displayName}</span>
												</div>
											</TableCell>
											<TableCell>
												<code class="font-mono text-[10px] text-muted-foreground">{app.clientId}</code>
											</TableCell>
											<TableCell>
												<Badge variant="default" class="gap-1 text-[9px]">
													<Lock size={10} />
													Configured
												</Badge>
											</TableCell>
											<TableCell class="text-right">
												<div class="flex items-center justify-end gap-1">
													<Button variant="outline" size="sm" class="h-7 text-[10px]" onclick={() => openOauthDialog(app)}>Update</Button>
													<Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground hover:text-destructive" onclick={() => deleteOauthApp(app)}>
														<Trash2 size={12} />
													</Button>
												</div>
											</TableCell>
										</TableRow>
									{/each}
								</TableBody>
							</Table>
						{/if}
					</div>
				</TabsContent>

				<!-- MCP Connections Tab -->
				<TabsContent value="mcp-connections">
					<div class="space-y-6">
						<Card>
							<CardHeader>
								<CardTitle class="text-sm">MCP Connections have moved to Vaults</CardTitle>
							</CardHeader>
							<CardContent class="space-y-3 text-xs text-muted-foreground">
								<p>
									MCP credentials now live in <strong>Vaults</strong>. Vaults group encrypted
									credentials that agents and sessions attach by id; the proxy injects them
									into MCP tool calls at call time so the sandbox never sees the secret.
								</p>
								<p>
									Open the new <a href="/workspaces/default/vaults" class="text-primary hover:underline">Vaults library</a>
									to create a vault, add credentials, and attach it to an agent.
								</p>
							</CardContent>
						</Card>
						{#if false}
						<!-- Legacy MCP section retained below for compile — dead code -->
						<!-- MCP Connections Table -->
						<div>
							<h3 class="text-sm font-semibold mb-3">Managed Connections</h3>
							{#if mcpLoading}
								<div class="flex items-center justify-center py-8">
									<Loader2 size={16} class="animate-spin text-muted-foreground" />
								</div>
							{:else if mcpConnections.length === 0}
								<Card>
									<CardContent class="py-8 text-center text-muted-foreground">
										<p class="text-xs">No MCP connections configured.</p>
									</CardContent>
								</Card>
							{:else}
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Name</TableHead>
											<TableHead>Source</TableHead>
											<TableHead>Credential</TableHead>
											<TableHead>Status</TableHead>
											<TableHead>Server URL</TableHead>
											<TableHead>Tools</TableHead>
											<TableHead class="text-right">Actions</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{#each mcpConnections as conn (conn.id)}
											{@const matchingAppConnections = appConnectionsForMcp(conn)}
											<TableRow>
												<TableCell class="font-medium text-xs">{conn.displayName}</TableCell>
												<TableCell>
													<Badge variant="outline" class="text-[9px]">{mcpSourceLabel(conn.sourceType)}</Badge>
												</TableCell>
												<TableCell>
													{#if conn.sourceType === 'nimble_piece'}
														{#if matchingAppConnections.length > 0}
															<NativeSelect
																value={conn.connectionExternalId || ''}
																disabled={mcpBusyId === conn.id}
																class="h-7 max-w-[190px] text-[10px]"
																onchange={(event) => updateMcpCredential(conn, (event.currentTarget as HTMLSelectElement).value)}
															>
																<option value="">No credential</option>
																{#each matchingAppConnections as app (app.externalId)}
																	<option value={app.externalId}>{app.displayName || app.providerLabel}</option>
																{/each}
															</NativeSelect>
														{:else}
															<span class="text-[9px] text-muted-foreground">No matching app connection</span>
														{/if}
													{:else}
														<span class="text-[9px] text-muted-foreground">—</span>
													{/if}
												</TableCell>
												<TableCell>
													{#if conn.status === 'ENABLED'}
														<Badge variant="default" class="text-[9px] bg-emerald-500/10 text-emerald-600 border-emerald-500/30">Enabled</Badge>
													{:else if conn.status === 'ERROR'}
														<Badge variant="destructive" class="text-[9px]">Error</Badge>
													{:else}
														<Badge variant="secondary" class="text-[9px]">Disabled</Badge>
													{/if}
												</TableCell>
												<TableCell>
													{#if conn.serverUrl}
														<code class="font-mono text-[9px] text-muted-foreground truncate max-w-[200px] block">{conn.serverUrl}</code>
													{:else}
														<span class="text-[9px] text-muted-foreground">—</span>
													{/if}
												</TableCell>
												<TableCell>
													<span class="text-[10px] text-muted-foreground">{mcpToolCount(conn)}</span>
												</TableCell>
												<TableCell class="text-right">
													<div class="flex items-center justify-end gap-0.5">
														<Button
															variant="ghost"
															size="icon"
															class="h-7 w-7"
															disabled={mcpBusyId === conn.id}
															onclick={() => toggleMcpStatus(conn)}
														>
															{#if mcpBusyId === conn.id}
																<Loader2 size={12} class="animate-spin" />
															{:else if conn.status === 'ENABLED'}
																<PowerOff size={12} class="text-muted-foreground" />
															{:else}
																<Power size={12} class="text-green-500" />
															{/if}
														</Button>
														{#if conn.sourceType !== 'hosted_workflow'}
															<Button
																variant="ghost"
																size="icon"
																class="h-7 w-7 text-muted-foreground hover:text-destructive"
																disabled={mcpBusyId === conn.id}
																onclick={() => deleteMcpConnection(conn)}
															>
																<Trash2 size={12} />
															</Button>
														{/if}
													</div>
												</TableCell>
											</TableRow>
										{/each}
									</TableBody>
								</Table>
							{/if}
						</div>
						{/if}
					</div>
				</TabsContent>
			</Tabs>
		</div>
	</div>
</div>

<!-- Generated Key Dialog -->
<Dialog
	open={showKeyDialog}
	onOpenChange={(v) => {
		if (!v) {
			showKeyDialog = false;
			generatedKey = null;
		}
	}}
>
	<DialogHeader>
		<DialogTitle>API Key Created</DialogTitle>
		<DialogDescription>Copy your API key now. It will not be shown again.</DialogDescription>
	</DialogHeader>
	{#if generatedKey}
		<div class="my-4 rounded-md border border-border bg-muted p-3">
			<code class="block break-all text-sm">{generatedKey}</code>
		</div>
		<DialogFooter>
			<Button
				variant="outline"
				onclick={() => {
					showKeyDialog = false;
					generatedKey = null;
				}}
			>
				Close
			</Button>
			<Button onclick={() => copyToClipboard(generatedKey!)}>Copy to Clipboard</Button>
		</DialogFooter>
	{/if}
</Dialog>

<!-- OAuth App Configure Dialog -->
<Dialog open={oauthDialogOpen} onOpenChange={(v) => { if (!v) { oauthDialogOpen = false; oauthDialogApp = null; } }}>
	<DialogContent class="sm:max-w-md">
		<DialogHeader>
			<DialogTitle class="flex items-center gap-2">
				{#if oauthDialogApp?.logoUrl}
					<img src={oauthDialogApp.logoUrl} alt="" class="h-5 w-5 rounded" />
				{/if}
				Configure {oauthDialogApp?.displayName ?? 'OAuth App'}
			</DialogTitle>
			<DialogDescription>
				Enter the OAuth2 credentials for this integration.
			</DialogDescription>
		</DialogHeader>
		<form class="space-y-4" onsubmit={(e) => { e.preventDefault(); saveOauthApp(); }}>
			<div class="space-y-1.5">
				<Label for="oauth-client-id">Client ID</Label>
				<Input id="oauth-client-id" bind:value={oauthClientId} placeholder="Your OAuth2 Client ID" class="text-xs font-mono" />
			</div>
			<div class="space-y-1.5">
				<Label for="oauth-client-secret">Client Secret</Label>
				<Input id="oauth-client-secret" type="password" bind:value={oauthClientSecret} placeholder="Leave blank to keep existing" class="text-xs" />
			</div>
			<DialogFooter>
				<Button variant="outline" type="button" onclick={() => { oauthDialogOpen = false; oauthDialogApp = null; }}>Cancel</Button>
				<Button type="submit" disabled={oauthSaving || !oauthClientId.trim()}>
					{#if oauthSaving}<Loader2 size={12} class="animate-spin" />{/if}
					Save
				</Button>
			</DialogFooter>
		</form>
	</DialogContent>
</Dialog>
