import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// Compose conditional class names (clsx) and then resolve Tailwind conflicts
// so the last utility wins (twMerge). Used by every owned UI primitive to let
// callers override individual classes via a `className` prop without fighting
// specificity.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
