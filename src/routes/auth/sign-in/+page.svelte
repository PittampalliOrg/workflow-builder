<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Separator } from '$lib/components/ui/separator';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Loader2, CircleAlert, Workflow, Boxes, Bot, ShieldCheck } from '@lucide/svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let email = $state('');
	let password = $state('');
	let error = $state<string | null>(page.url.searchParams.get('error') ? 'Social login failed. Please try again.' : null);
	let isLoading = $state(false);
	const githubAvailable = $derived(
		data.socialAuth.providers.some((entry) => entry.provider === 'github' && entry.available)
	);
	const googleAvailable = $derived(
		data.socialAuth.providers.some((entry) => entry.provider === 'google' && entry.available)
	);
	const socialAuthAvailable = $derived(githubAvailable || googleAvailable);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		error = null;
		isLoading = true;

		try {
			const res = await fetch('/api/v1/auth/sign-in', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, password })
			});

			if (!res.ok) {
				const data = await res.json().catch(() => ({ message: 'Sign in failed' }));
				error = data.message || `Error ${res.status}`;
				return;
			}

			goto('/dashboard');
		} catch {
			error = 'Unable to connect to auth service';
		} finally {
			isLoading = false;
		}
	}

	function signInWithGitHub() {
		window.location.href = '/api/v1/auth/social/github';
	}

	function signInWithGoogle() {
		window.location.href = '/api/v1/auth/social/google';
	}

	const features = [
		{ icon: Boxes, label: 'Visual canvas', detail: 'Compose pipelines by dragging nodes, not writing glue code.' },
		{ icon: Bot, label: 'AI agents', detail: 'Hand off steps to managed agents that run on their own.' },
		{ icon: ShieldCheck, label: 'GitOps native', detail: 'Promote across environments with auditable, reviewable change.' }
	];
</script>

<div class="grid min-h-screen w-full lg:grid-cols-[1.05fr_1fr]">
	<!-- Brand panel -->
	<aside
		class="brand-panel relative hidden flex-col justify-between overflow-hidden p-12 text-neutral-200 lg:flex"
	>
		<!-- decorative layers -->
		<div class="pointer-events-none absolute inset-0 brand-grid"></div>
		<div class="pointer-events-none absolute -top-32 -left-24 size-[34rem] rounded-full brand-glow"></div>
		<div class="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent"></div>

		<!-- logo lockup -->
		<div class="relative flex items-center gap-3">
			<div class="grid size-10 place-items-center rounded-xl bg-white/10 ring-1 ring-white/15 backdrop-blur">
				<Workflow class="size-5 text-white" />
			</div>
			<span class="text-sm font-medium tracking-wide text-neutral-300">Workflow Builder</span>
		</div>

		<!-- headline + features -->
		<div class="relative max-w-md space-y-10">
			<div class="space-y-5">
				<div class="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-neutral-300">
					<span class="size-1.5 rounded-full bg-[#ff3e00] shadow-[0_0_8px_2px_rgba(255,62,0,0.6)]"></span>
					Visual workflow automation
				</div>
				<h1 class="text-5xl font-semibold leading-[1.05] tracking-tight text-white">
					Build, run, and ship
					<span class="brand-accent">automated workflows.</span>
				</h1>
				<p class="text-base leading-relaxed text-neutral-400">
					Design AI-powered pipelines on a visual canvas and promote them across every
					environment — all from one place.
				</p>
			</div>

			<ul class="space-y-4">
				{#each features as f (f.label)}
					<li class="flex items-start gap-3">
						<div class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-white/5 ring-1 ring-white/10">
							<f.icon class="size-4 text-neutral-200" />
						</div>
						<div class="space-y-0.5">
							<p class="text-sm font-medium text-neutral-100">{f.label}</p>
							<p class="text-xs leading-relaxed text-neutral-400">{f.detail}</p>
						</div>
					</li>
				{/each}
			</ul>
		</div>

		<!-- footer -->
		<p class="relative text-xs text-neutral-500">
			&copy; {new Date().getFullYear()} Workflow Builder · Crafted for platform teams
		</p>
	</aside>

	<!-- Form panel -->
	<main class="flex items-center justify-center bg-background px-6 py-12">
		<div class="w-full max-w-sm space-y-8">
			<!-- compact brand mark (mobile + as crown for the form) -->
			<div class="space-y-6">
				<div class="flex items-center gap-2.5 lg:hidden">
					<div class="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">
						<Workflow class="size-5" />
					</div>
					<span class="text-base font-semibold tracking-tight">Workflow Builder</span>
				</div>

				<div class="space-y-1.5">
					<h2 class="text-3xl font-semibold tracking-tight">Sign in</h2>
					<p class="text-sm text-muted-foreground">
						Welcome back. Sign in to your workspace to continue.
					</p>
				</div>
			</div>

			{#if error}
				<Alert variant="destructive">
					<CircleAlert class="size-4" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			{/if}

			{#if socialAuthAvailable}
			<div class="flex flex-col gap-2">
				{#if githubAvailable}
				<Button variant="outline" class="h-11 w-full text-sm font-medium" onclick={signInWithGitHub}>
					<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" class="shrink-0">
						<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
					</svg>
					Continue with GitHub
				</Button>
				{/if}
				{#if googleAvailable}
				<Button variant="outline" class="h-11 w-full text-sm font-medium" onclick={signInWithGoogle}>
					<svg viewBox="0 0 24 24" width="16" height="16" class="shrink-0">
						<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
						<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
						<path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
						<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
					</svg>
					Continue with Google
				</Button>
				{/if}
			</div>

			<div class="relative">
				<div class="absolute inset-0 flex items-center">
					<Separator />
				</div>
				<div class="relative flex justify-center text-xs uppercase">
					<span class="bg-background px-2 text-muted-foreground">Or continue with email</span>
				</div>
			</div>
			{/if}

			<!-- Email/password form -->
			<form onsubmit={handleSubmit} class="space-y-4">
				<div class="space-y-1.5">
					<Label for="email">Email</Label>
					<Input
						id="email"
						type="email"
						bind:value={email}
						required
						placeholder="you@example.com"
					/>
				</div>
				<div class="space-y-1.5">
					<Label for="password">Password</Label>
					<Input
						id="password"
						type="password"
						bind:value={password}
						required
						placeholder="Password"
					/>
				</div>
				<Button
					class="h-11 w-full text-sm font-semibold shadow-sm transition-transform active:translate-y-px"
					type="submit"
					disabled={isLoading || !email || !password}
				>
					{#if isLoading}
						<Loader2 size={14} class="animate-spin" />
						Signing in...
					{:else}
						Sign in
					{/if}
				</Button>
			</form>

			<p class="text-center text-xs text-muted-foreground">
				Protected workspace. Authorized users only.
			</p>
		</div>
	</main>
</div>

<style>
	.brand-panel {
		background:
			radial-gradient(120% 120% at 80% 0%, #1c1c1f 0%, #0a0a0b 55%, #050506 100%);
	}

	.brand-grid {
		background-image:
			linear-gradient(to right, rgba(255, 255, 255, 0.04) 1px, transparent 1px),
			linear-gradient(to bottom, rgba(255, 255, 255, 0.04) 1px, transparent 1px);
		background-size: 44px 44px;
		mask-image: radial-gradient(120% 90% at 50% 0%, #000 30%, transparent 80%);
		-webkit-mask-image: radial-gradient(120% 90% at 50% 0%, #000 30%, transparent 80%);
	}

	.brand-glow {
		background: radial-gradient(circle, rgba(255, 62, 0, 0.22) 0%, transparent 70%);
		filter: blur(20px);
	}

	.brand-accent {
		background: linear-gradient(100deg, #ff8a4c 0%, #ff3e00 60%, #ff7a3c 100%);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
</style>
