"use client";

let originalTitle = "";
let flashInterval: ReturnType<typeof setInterval> | null = null;
let isFlashing = false;

export function startFlashing(message: string): void {
  if (typeof document === "undefined") return;
  if (isFlashing) stopFlashing();
  originalTitle = document.title;
  isFlashing = true;
  let showMessage = true;
  flashInterval = setInterval(() => {
    document.title = showMessage ? message : originalTitle;
    showMessage = !showMessage;
  }, 800);

  // Auto-stop when tab becomes visible
  const onVisibility = () => {
    if (!document.hidden) {
      stopFlashing();
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
}

export function stopFlashing(): void {
  if (!isFlashing) return;
  if (flashInterval) {
    clearInterval(flashInterval);
    flashInterval = null;
  }
  if (typeof document !== "undefined" && originalTitle) {
    document.title = originalTitle;
  }
  isFlashing = false;
}
