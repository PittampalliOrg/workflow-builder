"use client";

let permissionGranted = false;

export function isPermissionGranted(): boolean {
  if (typeof window === "undefined") return false;
  return Notification.permission === "granted";
}

export async function requestPermission(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (Notification.permission === "granted") {
    permissionGranted = true;
    return true;
  }
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  permissionGranted = result === "granted";
  return permissionGranted;
}

export function showNotification(
  title: string,
  body: string,
  options?: {
    tag?: string;
    requireInteraction?: boolean;
    onClick?: () => void;
  }
): void {
  if (!isPermissionGranted()) return;
  const notification = new Notification(title, {
    body,
    tag: options?.tag,
    requireInteraction: options?.requireInteraction ?? false,
    icon: "/favicon.ico",
  });
  if (options?.onClick) {
    notification.onclick = () => {
      window.focus();
      options.onClick?.();
      notification.close();
    };
  }
}
