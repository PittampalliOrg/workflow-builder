import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { Snippet } from 'svelte';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

// Type utilities for shadcn-svelte components
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Primitive<T> = T extends Record<string, any> ? T : never;

export type WithElementRef<T, E extends HTMLElement = HTMLElement> = T & {
	ref?: E | null;
};

export type WithoutChild<T> = Omit<Primitive<T>, 'child'>;

export type WithoutChildren<T> = Omit<Primitive<T>, 'children'>;

export type WithoutChildrenOrChild<T> = Omit<Primitive<T>, 'children' | 'child'>;
