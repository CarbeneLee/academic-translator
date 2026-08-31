import type { SelectionFragment, TextPosition } from "./types";

export type HighlightRect = {
  fragmentId: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type DomPosition = {
  node: Text;
  offset: number;
};

function taggedTextItem(
  textLayer: HTMLElement,
  pageIndex: number,
  textItemIndex: number,
): HTMLElement | null {
  return Array.from(
    textLayer.querySelectorAll<HTMLElement>(
      "[data-page-index][data-text-item-index]",
    ),
  ).find(
    (element) =>
      Number(element.dataset.pageIndex) === pageIndex &&
      Number(element.dataset.textItemIndex) === textItemIndex,
  ) ?? null;
}

function resolveTextOffset(
  element: HTMLElement,
  position: TextPosition,
): DomPosition | null {
  let remaining = position.offset;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode() as Text | null;
  while (textNode) {
    if (remaining <= textNode.length) {
      return { node: textNode, offset: remaining };
    }
    remaining -= textNode.length;
    textNode = walker.nextNode() as Text | null;
  }
  return null;
}

export function deriveHighlightRects(
  fragments: readonly SelectionFragment[],
  textLayerByPage: ReadonlyMap<number, HTMLElement>,
): HighlightRect[] {
  const rectangles: HighlightRect[] = [];

  for (const fragment of fragments) {
    for (const span of fragment.spans) {
      const textLayer = textLayerByPage.get(span.pageIndex);
      if (!textLayer) {
        continue;
      }
      const startItem = taggedTextItem(
        textLayer,
        span.pageIndex,
        span.start.textItemIndex,
      );
      const endItem = taggedTextItem(
        textLayer,
        span.pageIndex,
        span.end.textItemIndex,
      );
      if (!startItem || !endItem) {
        continue;
      }
      const start = resolveTextOffset(startItem, span.start);
      const end = resolveTextOffset(endItem, span.end);
      if (!start || !end) {
        continue;
      }

      const range = document.createRange();
      try {
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        const pageRect = textLayer.getBoundingClientRect();
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width <= 0 || rect.height <= 0) {
            continue;
          }
          rectangles.push({
            fragmentId: fragment.id,
            pageIndex: span.pageIndex,
            x: rect.left - pageRect.left,
            y: rect.top - pageRect.top,
            width: rect.width,
            height: rect.height,
          });
        }
      } catch {
        continue;
      } finally {
        range.detach();
      }
    }
  }

  return rectangles;
}
