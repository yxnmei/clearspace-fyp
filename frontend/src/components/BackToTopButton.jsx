import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "../lib/cn";

// A floating "back to top" control for one long, scrolling workspace
// (the Declutter Review view). It is purely presentational: it watches a
// sentinel near the top of the workspace with an IntersectionObserver
// and, once that sentinel has scrolled out of view, offers a fixed
// lower-right button that returns scroll and focus to the top.
//
// A second, optional sentinel placed just before the wizard's
// Back / Continue row lets the button hide itself again near the bottom,
// so it never sits on top of those controls.
//
// Where IntersectionObserver is unavailable (older engines, jsdom
// without a stub) the button simply never appears; nothing else on the
// page depends on it.
export default function BackToTopButton({
  scrollTargetRef,
  topSentinelRef,
  bottomSentinelRef,
  label = "Back to top",
  className,
}) {
  const [pastTop, setPastTop] = useState(false);
  const [nearBottom, setNearBottom] = useState(false);

  useEffect(() => {
    const el = topSentinelRef?.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setPastTop(!entry.isIntersecting),
      { threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [topSentinelRef]);

  useEffect(() => {
    const el = bottomSentinelRef?.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setNearBottom(entry.isIntersecting),
      { threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [bottomSentinelRef]);

  if (!pastTop || nearBottom) return null;

  function handleClick() {
    const target = scrollTargetRef?.current;
    if (!target) return;
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "start",
      });
    }
    if (typeof target.focus === "function") {
      target.focus({ preventScroll: true });
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      className={cn(
        "fixed bottom-6 right-6 z-40 inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-2 text-xs font-semibold text-foreground shadow-elevated transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className
      )}
    >
      <ArrowUp aria-hidden="true" width={14} height={14} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
