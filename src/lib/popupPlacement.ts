// Placement for a small popup anchored under a trigger: always inside the viewport.
// The popup is rendered with position: fixed (in a portal), so no overflow container clips it.

export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Placement {
  left: number;
  top: number;
  width: number;
}

const MARGIN = 8;
const GAP = 4;

/**
 * Width is the preferred width, shrunk to fit the viewport minus margins. Horizontally the popup
 * aligns to the trigger's left edge, then is clamped into [margin, viewport - margin - width].
 * Vertically it opens below the trigger, or above when there is no room below and more above.
 */
export function placePopup(anchor: AnchorRect, popupHeight: number, viewport: { width: number; height: number }, preferredWidth = 224): Placement {
  const width = Math.max(0, Math.min(preferredWidth, viewport.width - 2 * MARGIN));
  const left = Math.max(MARGIN, Math.min(anchor.left, viewport.width - MARGIN - width));
  const below = anchor.bottom + GAP;
  const fitsBelow = below + popupHeight <= viewport.height - MARGIN;
  const above = anchor.top - GAP - popupHeight;
  const top = fitsBelow || above < MARGIN ? below : above;
  return { left, top, width };
}
