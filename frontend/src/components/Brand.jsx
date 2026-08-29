import { Sprout } from "lucide-react";
import { cn } from "../lib/cn";

// ClearSpace brand mark + wordmark. The visible text is always present in the
// DOM (so the mark always has an accessible name "ClearSpace"); pass
// showWordmark={false} to hide it visually while keeping it for assistive
// tech. The leaf glyph is decorative and hidden from the accessibility tree.
export default function Brand({ className, showWordmark = true, iconSize = 20, ...props }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-foreground", className)} {...props}>
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-control bg-primary text-primary-foreground">
        <Sprout aria-hidden="true" width={iconSize} height={iconSize} />
      </span>
      <span className={cn("text-lg font-semibold tracking-tight", !showWordmark && "sr-only")}>
        ClearSpace
      </span>
    </span>
  );
}
