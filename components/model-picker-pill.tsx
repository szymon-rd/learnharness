"use client";

import type { ComponentProps } from "react";

/** The core and controlled plugin pickers share the very same trigger renderer. */
export function ModelPickerPill({ children, className, ...props }: ComponentProps<"button">) {
	return <button type="button" {...props}
		className={`flex items-center gap-1.5 rounded-full border bg-card/85 px-2.5 py-1 font-ui text-xs shadow-lg backdrop-blur transition-colors hover:border-border hover:bg-muted max-sm:py-2 ${className ?? ""}`}>
		{/* Phone: a long model id truncates instead of wrapping the pill. */}
		<span className="text-card-foreground max-sm:max-w-[6.5rem] max-sm:truncate">{children}</span>
		<span aria-hidden className="text-xs text-muted-foreground">▾</span>
	</button>;
}
