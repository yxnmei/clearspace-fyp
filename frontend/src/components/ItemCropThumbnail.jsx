import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "../lib/cn";

// CSS cover crop from the shared room image, with no object URL or crop API.
// Aspect-ratio measurements are tagged by URL; only the current URL's ratio
// is used, preventing stale values after URL changes, failures or late probes.
// The thumbnail is decorative unless alt is supplied.

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : NaN);

// Return a uniform cover crop, or null for an unusable box.
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

  // Preserve the source aspect ratio while the smaller box axis fills.
  const cover = Math.min(boxWidth * ratio, boxHeight);
  const sizeY = 1 / cover;
  const sizeX = ratio * sizeY;

  const centreX = (x1 + x2) / 2;
  const centreY = (y1 + y2) / 2;

  // Centre the box and clamp so the crop never shows beyond the image.
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

// Shared URL-to-ratio cache avoids repeated probes.
const aspectRatioCache = new Map();

function useImageAspectRatio(imageUrl) {
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
        // Keep this URL on the square fallback, never a previous ratio.
        setMeasured({ url: imageUrl, ratio: null });
      }
    };
    probe.onload = () => {
      finish(probe.naturalHeight > 0 ? probe.naturalWidth / probe.naturalHeight : null);
    };
    probe.onerror = () => {
      finish(null);
    };
    probe.src = imageUrl;

    return () => {
      cancelled = true;
      probe.onload = null;
      probe.onerror = null;
    };
  }, [imageUrl]);

  // This URL check is the stale-ratio guard.
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
