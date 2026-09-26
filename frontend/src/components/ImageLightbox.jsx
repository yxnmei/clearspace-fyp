import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/cn";

// Portalled image dialog with focus trapping, restored opener focus, step
// zoom, scroll panning and optional aligned overlays. It renders the supplied
// URL without fetching or re-encoding it.
const ZOOM_LEVELS = [1, 2, 3];
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function ImageLightbox({
  open,
  onClose,
  src,
  alt,
  title,
  description,
  overlays = null,
  initialShowOverlays = true,
}) {
  const [zoomIndex, setZoomIndex] = useState(0);
  const [showOverlays, setShowOverlays] = useState(initialShowOverlays);
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const openerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    openerRef.current = typeof document !== "undefined" ? document.activeElement : null;
    setZoomIndex(0);
    setShowOverlays(initialShowOverlays);
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener && typeof opener.focus === "function") opener.focus();
    };
    // initialShowOverlays is read only at the moment of opening, on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const zoom = ZOOM_LEVELS[zoomIndex];
  const canZoomIn = zoomIndex < ZOOM_LEVELS.length - 1;
  const canZoomOut = zoomIndex > 0;
  const hasOverlays = Array.isArray(overlays) && overlays.length > 0;

  function zoomIn() {
    if (canZoomIn) setZoomIndex((index) => Math.min(index + 1, ZOOM_LEVELS.length - 1));
  }

  function zoomOut() {
    if (canZoomOut) setZoomIndex((index) => Math.max(index - 1, 0));
  }

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomIn();
      return;
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomOut();
      return;
    }
    if (event.key === "Tab" && dialogRef.current) {
      const focusable = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function handleBackdropClick(event) {
    if (event.target === event.currentTarget) onClose();
  }

  const toolbarButton =
    "border-background/40 bg-transparent text-background hover:bg-background/10 hover:text-background";

  const node = (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="image-lightbox-title"
      aria-describedby={description ? "image-lightbox-description" : undefined}
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-[100] flex flex-col bg-foreground/95 text-background"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h2 id="image-lightbox-title" className="text-base font-semibold">
            {title}
          </h2>
          {description ? (
            <p id="image-lightbox-description" className="text-xs text-background/80">
              {description}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasOverlays ? (
            <label className="mr-2 flex cursor-pointer items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={showOverlays}
                onChange={(event) => setShowOverlays(event.target.checked)}
                className="h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              Show boxes
            </label>
          ) : null}
          <div className="flex items-center gap-2" role="group" aria-label="Zoom">
            <Button type="button" variant="outline" size="sm" onClick={zoomOut} disabled={!canZoomOut} className={toolbarButton}>
              <ZoomOut aria-hidden="true" width={14} height={14} />
              Zoom out
            </Button>
            <span aria-live="polite" className="min-w-8 text-center text-sm tabular-nums">
              {zoom}x
            </span>
            <Button type="button" variant="outline" size="sm" onClick={zoomIn} disabled={!canZoomIn} className={toolbarButton}>
              <ZoomIn aria-hidden="true" width={14} height={14} />
              Zoom in
            </Button>
          </div>
          <Button ref={closeRef} type="button" variant="outline" size="sm" onClick={onClose} className={toolbarButton}>
            <X aria-hidden="true" width={14} height={14} />
            Close
          </Button>
        </div>
      </div>

      {/* The image-sized wrapper keeps percentage overlays aligned while zooming. */}
      <div
        data-testid="lightbox-backdrop"
        onClick={handleBackdropClick}
        className="flex flex-1 items-start justify-center overflow-auto px-4 pb-4 sm:px-6"
      >
        <div
          className={cn("relative inline-block shrink-0", zoom === 1 && "max-w-full")}
          style={zoom > 1 ? { width: `${zoom * 100}%` } : undefined}
        >
          <img
            src={src}
            alt={alt}
            data-zoom={zoom}
            className={cn("block h-auto w-full", zoom === 1 && "max-h-[calc(100vh-6rem)] max-w-full object-contain")}
          />
          {hasOverlays && showOverlays ? (
            <div aria-hidden="true" className="pointer-events-none absolute inset-0">
              {overlays.map((overlay) => (
                <span
                  key={overlay.id}
                  data-testid="lightbox-overlay"
                  className={cn("absolute rounded-sm border-2", overlay.className)}
                  style={{
                    left: `${overlay.box.x1 * 100}%`,
                    top: `${overlay.box.y1 * 100}%`,
                    width: `${(overlay.box.x2 - overlay.box.x1) * 100}%`,
                    height: `${(overlay.box.y2 - overlay.box.y1) * 100}%`,
                  }}
                >
                  {overlay.label ? (
                    <span className="absolute -left-0.5 -top-0.5 rounded bg-foreground px-1 text-[10px] font-semibold leading-tight text-background">
                      {overlay.label}
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
