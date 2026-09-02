import type { HighlightRect } from "./highlightGeometry";

export type FloatingActionPosition = {
  left: number;
  top: number;
};

const ACTION_WIDTH = 72;
const ACTION_HEIGHT = 36;
const ACTION_GAP = 8;
const VIEWPORT_EDGE_GAP = 12;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function intersectsViewport(
  rectangle: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
  viewport: Pick<DOMRect, "left" | "top" | "right" | "bottom">,
): boolean {
  return (
    rectangle.right > viewport.left &&
    rectangle.left < viewport.right &&
    rectangle.bottom > viewport.top &&
    rectangle.top < viewport.bottom
  );
}

export function deriveFloatingActionPosition(
  rectangles: readonly HighlightRect[],
  textLayerByPage: ReadonlyMap<number, HTMLElement>,
  viewport: HTMLElement,
): FloatingActionPosition {
  const viewportRect = viewport.getBoundingClientRect();
  const minimumLeft = viewportRect.left + VIEWPORT_EDGE_GAP;
  const maximumLeft = Math.max(
    minimumLeft,
    viewportRect.right - ACTION_WIDTH - VIEWPORT_EDGE_GAP,
  );
  const minimumTop = viewportRect.top + VIEWPORT_EDGE_GAP;
  const maximumTop = Math.max(
    minimumTop,
    viewportRect.bottom - ACTION_HEIGHT - VIEWPORT_EDGE_GAP,
  );

  for (let index = rectangles.length - 1; index >= 0; index -= 1) {
    const rectangle = rectangles[index];
    const textLayer = textLayerByPage.get(rectangle.pageIndex);
    if (!textLayer) {
      continue;
    }
    const textLayerRect = textLayer.getBoundingClientRect();
    const selectedRect = {
      left: textLayerRect.left + rectangle.x,
      top: textLayerRect.top + rectangle.y,
      right: textLayerRect.left + rectangle.x + rectangle.width,
      bottom: textLayerRect.top + rectangle.y + rectangle.height,
    };
    if (!intersectsViewport(selectedRect, viewportRect)) {
      continue;
    }

    const preferredBelow = selectedRect.bottom + ACTION_GAP;
    const preferredAbove = selectedRect.top - ACTION_HEIGHT - ACTION_GAP;
    const top =
      preferredBelow <= maximumTop ? preferredBelow : preferredAbove;

    return {
      left: clamp(
        selectedRect.right - ACTION_WIDTH,
        minimumLeft,
        maximumLeft,
      ),
      top: clamp(top, minimumTop, maximumTop),
    };
  }

  // Geometry may be briefly unavailable during page virtualization. Keep the
  // explicit trigger reachable until the visible text layer is mounted again.
  return { left: maximumLeft, top: maximumTop };
}
