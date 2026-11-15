/** Class names joined, falsy parts dropped (the host's cn without tailwind-merge). */
export function cn(...parts: (string | false | null | undefined)[]): string {
	return parts.filter(Boolean).join(" ");
}
