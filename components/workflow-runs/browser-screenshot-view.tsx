"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const POLL_INTERVAL_MS = 2000;

export function BrowserScreenshotView({ podIp }: { podIp: string }) {
	const [imageUrl, setImageUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
	const [polling, setPolling] = useState(true);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const fetchScreenshot = useCallback(async () => {
		try {
			const res = await fetch(`/api/sandbox-aio/${podIp}/v1/browser/screenshot`);
			if (!res.ok) {
				if (res.status === 404) {
					setError("Browser not started yet");
					return;
				}
				throw new Error(`Screenshot request failed: ${res.status}`);
			}
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			setImageUrl((prev) => {
				if (prev) URL.revokeObjectURL(prev);
				return url;
			});
			setLastUpdated(new Date());
			setError(null);
		} catch (err: any) {
			setError(err.message || "Failed to fetch screenshot");
		}
	}, [podIp]);

	useEffect(() => {
		fetchScreenshot();

		if (polling) {
			intervalRef.current = setInterval(fetchScreenshot, POLL_INTERVAL_MS);
		}

		return () => {
			if (intervalRef.current) {
				clearInterval(intervalRef.current);
			}
		};
	}, [fetchScreenshot, polling]);

	// Cleanup blob URL on unmount
	useEffect(() => {
		return () => {
			if (imageUrl) URL.revokeObjectURL(imageUrl);
		};
	}, [imageUrl]);

	return (
		<Card className="h-full overflow-hidden border-0 rounded-none">
			<CardContent className="h-full p-4 flex flex-col gap-2">
				<div className="flex items-center justify-between">
					<div className="text-xs text-muted-foreground">
						{lastUpdated
							? `Last updated: ${lastUpdated.toLocaleTimeString()}`
							: "Loading..."}
					</div>
					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => setPolling(!polling)}
						>
							{polling ? "Pause" : "Resume"}
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={fetchScreenshot}
						>
							Refresh
						</Button>
					</div>
				</div>
				<div className="flex-1 overflow-auto flex items-center justify-center bg-muted/30 rounded">
					{error && !imageUrl ? (
						<div className="text-sm text-muted-foreground">{error}</div>
					) : imageUrl ? (
						<img
							src={imageUrl}
							alt="Browser screenshot"
							className="max-w-full max-h-full object-contain"
						/>
					) : (
						<div className="text-sm text-muted-foreground">Loading screenshot...</div>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
