import { cn } from "../lib/cn";
import clearspaceLogo from "../assets/clearspace-logo.svg";

// ClearSpace brand mark + wordmark. The visible text is always present in the
// DOM (so the mark always has an accessible name "ClearSpace"); pass
// showWordmark={false} to hide it visually while keeping it for assistive
// tech. The logo image is decorative because the adjacent wordmark already
// provides the accessible name.
export default function Brand({ className, showWordmark = true, iconSize = 36, ...props }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-foreground", className)} {...props}>
      <img
        src={clearspaceLogo}
        alt=""
        aria-hidden="true"
        width={iconSize}
        height={iconSize}
        className="shrink-0"
      />
      <span className={cn("text-lg font-semibold tracking-tight", !showWordmark && "sr-only")}>
        ClearSpace
      </span>
    </span>
  );
}
