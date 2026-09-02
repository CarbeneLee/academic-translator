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

function taggedTextItems(
  textLayer: HTMLElement,
  pageIndex: number,
): HTMLElement[] {
  return Array.from(
    textLayer.querySelectorAll<HTMLElement>(
      "[data-page-index][data-text-item-index]",
    ),
  ).filter(
    (element) =>
      Number(element.dataset.pageIndex) === pageIndex,
  );
}

function resolveTextOffset(
  element: HTMLElement,
  offset: TextPosition["offset"],
): DomPosition | null {
  let remaining = offset;
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
      const textItems = taggedTextItems(textLayer, span.pageIndex);
      const startItemPosition = textItems.findIndex(
        (element) =>
          Number(element.dataset.textItemIndex) === span.start.textItemIndex,
      );
      const endItemPosition = textItems.findIndex(
        (element) =>
          Number(element.dataset.textItemIndex) === span.end.textItemIndex,
      );
      if (
        startItemPosition < 0 ||
        endItemPosition < startItemPosition
      ) {
        continue;
      }
      const pageRect = textLayer.getBoundingClientRect();

      for (
        let itemPosition = startItemPosition;
        itemPosition <= endItemPosition;
        itemPosition += 1
      ) {
        const textItem = textItems[itemPosition];
        const startOffset =
          itemPosition === startItemPosition ? span.start.offset : 0;
        const endOffset =
          itemPosition === endItemPosition
            ? span.end.offset
            : (textItem.textContent?.length ?? 0);
        if (endOffset <= startOffset) {
          continue;
        }
        const start = resolveTextOffset(textItem, startOffset);
        const end = resolveTextOffset(textItem, endOffset);
        if (!start || !end) {
          continue;
        }

        const range = document.createRange();
        try {
          range.setStart(start.node, start.offset);
          range.setEnd(end.node, end.offset);
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
  }

  return rectangles;
}
