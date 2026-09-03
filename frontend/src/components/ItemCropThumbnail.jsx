import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "../lib/cn";

// A tiny preview of one detected item, derived entirely in the browser
// from the ALREADY-loaded room image plus the item's normalized bounding
// box. It creates no per-item object URL, makes no network request of its
// own beyond letting the browser reuse the cached room image, and relies
// on no backend crop endpoint: it points a CSS background-image at the
// same source URL and scales/offsets it so the box region covers the
// square thumbnail.
//
// The crop is a COVER crop: the source image is scaled uniformly (never
// stretched on one axis), just far enough that the box region fills the
// square, then centred on the box. Preserving proportions needs the
// source image's aspect ratio, which the component measures once per URL
// (shared cache below) and passes to computeCropStyle. Every stored
// measurement is tagged with the exact URL it belongs to, and the
// rendered crop uses a measured ratio ONLY when that measurement is for
// the current `imageUrl`; otherwise it falls back to a square (still a
// uniform, proportion-preserving scale) until the current image is
// measured. So a URL change, a failed probe, or a late callback from a
// previous URL can never leave a stale ratio in effect.
//
// Decorative by default: the row it sits in already names the item, so
// the thumbnail is aria-hidden. Pass a non-empty `alt` to expose it to
// assistive tech instead. It is never a control.

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : NaN);

// Pure crop maths, exported so the source/destination calculation is
// testable with plain values. Returns the CSS background-size /
// background-position that scale the source image uniformly so the
// normalized box region covers the square container, or null when the
// box cannot be used.
//
// imageAspectRatio is the source image's naturalWidth / naturalHeight.
// It defaults to 1 (unknown, treated as square); any value keeps the
// scale uniform, so the box region is never distorted.
export function computeCropStyle(box, imageAspectRatio = 1) {
  if (!box) return null;
  const x1 = clamp01(box.x1);
  const y1 = clamp01(box.y1);
  const x2 = clamp01(box.x2);
  const y2 = clamp01(box.y2);
  if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) return null;

  const boxWidth = x2 - x1;
  const boxHeight = y2 - y1;
  if (boxWidth <= 0 || boxHeight <= 0) return null;

  const ratio =
    Number.isFinite(imageAspectRatio) && imageAspectRatio > 0 ? imageAspectRatio : 1;

  // background-size as fractions of the container. Keeping sizeX / sizeY
  // equal to the image's aspect ratio means the image is scaled, not
  // stretched. `cover` is the smaller of the box's rendered dimensions
  // at unit vertical scale; dividing by it makes that dimension exactly
  // fill the square and the other one overflow (and get clipped).
  const cover = Math.min(boxWidth * ratio, boxHeight);
  const sizeY = 1 / cover;
  const sizeX = ratio * sizeY;

  const centreX = (x1 + x2) / 2;
  const centreY = (y1 + y2) / 2;

  // CSS background-position %: aligns the p% point of the image with the
  // p% point of the container. Solving for "box centre at container
  // centre" gives (0.5 - centre*size) / (1 - size); clamp into [0,1] so
  // the container never shows past the image edge.
  const positionFor = (centre, size) => {
    if (Math.abs(1 - size) < 1e-6) return 0;
    const p = (0.5 - centre * size) / (1 - size);
    return Math.min(1, Math.max(0, p));
  };

  return {
    backgroundSize: `${(sizeX * 100).toFixed(4)}% ${(sizeY * 100).toFixed(4)}%`,
    backgroundPosition: `${(positionFor(centreX, sizeX) * 100).toFixed(4)}% ${(
      positionFor(centreY, sizeY) * 100
    ).toFixed(4)}%`,
  };
}

// URL -> measured aspect ratio, so a review list with many rows measures
// the one shared room image at most once.
const aspectRatioCache = new Map();

// Returns the aspect ratio to use for `imageUrl` right now: a measured
// value only when the stored measurement is tagged with this exact URL,
// otherwise null (the caller then treats the image as square until its
// own probe resolves).
function useImageAspectRatio(imageUrl) {
  // { url, ratio } | null. `ratio` is null once a URL has been probed
  // but produced no usable measurement (e.g. the probe errored).
  const [measured, setMeasured] = useState(() =>
    imageUrl && aspectRatioCache.has(imageUrl)
      ? { url: imageUrl, ratio: aspectRatioCache.get(imageUrl) }
      : null
  );

  useEffect(() => {
    if (!imageUrl) {
      setMeasured(null);
      return undefined;
    }
    if (aspectRatioCache.has(imageUrl)) {
      setMeasured({ url: imageUrl, ratio: aspectRatioCache.get(imageUrl) });
      return undefined;
    }

    let cancelled = false;
    const probe = new Image();
    const finish = (ratio) => {
      if (cancelled) return;
      if (ratio && Number.isFinite(ratio) && ratio > 0) {
        aspectRatioCache.set(imageUrl, ratio);
        setMeasured({ url: imageUrl, ratio });
      } else {
        // Probe produced nothing usable: keep this URL on the square
        // fallback, never on a previous URL's ratio.
        setMeasured({ url: imageUrl, ratio: null });
      }
    };
    probe.onload = () => {
      finish(probe.naturalHeight > 0 ? probe.naturalWidth / probe.naturalHeight : null);
    };
    probe.onerror = () => {
      // Safe: no error surfaced, nothing thrown, no stale ratio kept.
      finish(null);
    };
    probe.src = imageUrl;

    return () => {
      cancelled = true;
      probe.onload = null;
      probe.onerror = null;
    };
  }, [imageUrl]);

  // Only honour a measurement that belongs to the URL being rendered.
  return measured && measured.url === imageUrl ? measured.ratio : null;
}

export default function ItemCropThumbnail({ imageUrl, box, alt, className }) {
  const aspectRatio = useImageAspectRatio(imageUrl);
  const crop = imageUrl ? computeCropStyle(box, aspectRatio ?? 1) : null;
  const a11y = alt ? { role: "img", "aria-label": alt } : { "aria-hidden": "true" };

  if (!crop) {
    return (
      <span
        {...a11y}
        data-testid="item-crop-fallback"
        className={cn(
          "flex h-12 w-12 shrink-0 items-center justify-center rounded-control border border-border bg-surface-muted text-muted-foreground",
          className
        )}
      >
        <ImageOff aria-hidden="true" width={16} height={16} />
      </span>
    );
  }

  return (
    <span
      {...a11y}
      data-testid="item-crop-thumbnail"
      className={cn(
        "block h-12 w-12 shrink-0 overflow-hidden rounded-control border border-border bg-surface-muted",
        className
      )}
      style={{
        backgroundImage: `url("${imageUrl}")`,
        backgroundRepeat: "no-repeat",
        backgroundSize: crop.backgroundSize,
        backgroundPosition: crop.backgroundPosition,
      }}
    />
  );
}
