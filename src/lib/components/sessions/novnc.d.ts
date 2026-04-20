// Minimal ambient declaration so `import RFB from '@novnc/novnc/lib/rfb.js'`
// type-checks. The upstream package is ES-modules JS with no d.ts; we only
// use a handful of members, so a narrow shim is safer than `declare module`
// with `any`.
declare module '@novnc/novnc/lib/rfb.js' {
	export default class RFB {
		constructor(target: HTMLElement, url: string, options?: Record<string, unknown>);
		viewOnly: boolean;
		scaleViewport: boolean;
		resizeSession: boolean;
		disconnect(): void;
		addEventListener(type: 'connect', handler: () => void): void;
		addEventListener(type: 'disconnect', handler: (e: CustomEvent<{ clean: boolean }>) => void): void;
		addEventListener(type: 'securityfailure', handler: (e: CustomEvent<unknown>) => void): void;
	}
}
