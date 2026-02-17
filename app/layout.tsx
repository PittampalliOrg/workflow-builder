import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { ReactFlowProvider } from "@xyflow/react";
import { Provider } from "jotai";
import { cookies } from "next/headers";
import { type ReactNode, Suspense } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { AuthProvider } from "@/components/auth/provider";
import { GitHubStarsLoader } from "@/components/github-stars-loader";
import { GitHubStarsProvider } from "@/components/github-stars-provider";
import { GlobalModals } from "@/components/global-modals";
import { OverlayProvider } from "@/components/overlays/overlay-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { PersistentCanvas } from "@/components/workflow/persistent-canvas";
import { getSessionFromCookie } from "@/lib/auth-helpers";
import { mono, sans } from "@/lib/fonts";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
	title: "AI Workflow Builder - Visual Workflow Automation",
	description:
		"Build powerful AI-driven workflow automations with a visual, node-based editor. Built with Next.js and React Flow.",
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	maximumScale: 1,
	userScalable: false,
	viewportFit: "cover",
};

type RootLayoutProps = {
	children: ReactNode;
};

// Sidebar wrapper that fetches session and includes the canvas
async function SidebarWrapper({ children }: { children: ReactNode }) {
	const session = await getSessionFromCookie();

	const cookieStore = await cookies();
	const isCollapsed = cookieStore.get("sidebar_state")?.value !== "true";

	return (
		<SidebarProvider defaultOpen={!isCollapsed}>
			<AppSidebar
				user={session?.user as Parameters<typeof AppSidebar>[0]["user"]}
			/>
			<SidebarInset className="relative bg-transparent">
				<ReactFlowProvider>
					{/* Canvas renders behind everything in the content area */}
					<PersistentCanvas />
					{/* Page content overlays the canvas */}
					<div className="pointer-events-none relative z-10 min-h-0 flex-1">
						{children}
					</div>
				</ReactFlowProvider>
			</SidebarInset>
		</SidebarProvider>
	);
}

const RootLayout = ({ children }: RootLayoutProps) => (
	<html lang="en" suppressHydrationWarning>
		<head>
			<script
				// biome-ignore lint/security/noDangerouslySetInnerHtml: required to expose selected env vars to the client at runtime
				dangerouslySetInnerHTML={{
					__html: `window.ENV=${JSON.stringify({
						NEXT_PUBLIC_AUTH_PROVIDERS: process.env.NEXT_PUBLIC_AUTH_PROVIDERS,
						NEXT_PUBLIC_GITHUB_CLIENT_ID:
							process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID,
						NEXT_PUBLIC_GOOGLE_CLIENT_ID:
							process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
					})}`,
				}}
			/>
		</head>
		<body className={cn(sans.variable, mono.variable, "antialiased")}>
			<ThemeProvider
				attribute="class"
				defaultTheme="system"
				disableTransitionOnChange
				enableSystem
			>
				<Provider>
					<AuthProvider>
						<OverlayProvider>
							<Suspense
								fallback={
									<GitHubStarsProvider stars={null}>
										<SidebarProvider>
											<SidebarInset className="relative bg-transparent">
												<ReactFlowProvider>
													<PersistentCanvas />
													<div className="pointer-events-none relative z-10 min-h-0 flex-1">
														{children}
													</div>
												</ReactFlowProvider>
											</SidebarInset>
										</SidebarProvider>
									</GitHubStarsProvider>
								}
							>
								<GitHubStarsLoader>
									<SidebarWrapper>{children}</SidebarWrapper>
								</GitHubStarsLoader>
							</Suspense>
							<Toaster />
							<GlobalModals />
						</OverlayProvider>
					</AuthProvider>
				</Provider>
			</ThemeProvider>
			<Analytics />
			<SpeedInsights />
		</body>
	</html>
);

export default RootLayout;
