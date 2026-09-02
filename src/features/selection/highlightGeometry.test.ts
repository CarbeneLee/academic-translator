import { deriveHighlightRects } from "./highlightGeometry";
import type { SelectionFragment } from "./types";

function fragment(): SelectionFragment {
  return {
    id: "fragment-1",
    documentSessionId: "document-session-1",
    order: 0,
    text: "pha\nvirtualized",
    spans: [
      {
        pageIndex: 0,
        start: { textItemIndex: 4, offset: 2 },
        end: { textItemIndex: 4, offset: 5 },
        text: "pha",
      },
      {
        pageIndex: 3,
        start: { textItemIndex: 0, offset: 0 },
        end: { textItemIndex: 0, offset: 11 },
        text: "virtualized",
      },
    ],
  };
}

function taggedLayer(): HTMLElement {
  const layer = document.createElement("div");
  layer.dataset.pageIndex = "0";
  Object.defineProperty(layer, "getBoundingClientRect", {
    value: () => ({
      x: 100,
      y: 200,
      left: 100,
      top: 200,
      right: 700,
      bottom: 1000,
      width: 600,
      height: 800,
      toJSON: () => undefined,
    }),
  });

  for (const [index, text] of [
    [4, "alpha "],
    [5, "beta gamma"],
  ] as const) {
    const span = document.createElement("span");
    span.dataset.pageIndex = "0";
    span.dataset.textItemIndex = String(index);
    span.append(document.createTextNode(text));
    layer.append(span);
  }
  document.body.append(layer);
  return layer;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

test("derives page-local rectangles from stored anchors without mutating fragments", () => {
  const layer = taggedLayer();
  const originalCreateRange = document.createRange.bind(document);
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = originalCreateRange();
    Object.defineProperty(range, "getClientRects", {
      value: () => [
        {
          x: 112,
          y: 225,
          left: 112,
          top: 225,
          right: 162,
          bottom: 237,
          width: 50,
          height: 12,
          toJSON: () => undefined,
        },
      ],
    });
    return range;
  });
  const stored = fragment();

  expect(deriveHighlightRects([stored], new Map([[0, layer]]))).toEqual([
    {
      fragmentId: "fragment-1",
      pageIndex: 0,
      x: 12,
      y: 25,
      width: 50,
      height: 12,
    },
  ]);
  expect(stored.spans).toHaveLength(2);
  expect(stored.spans[1].pageIndex).toBe(3);
});

test("derives each text item's geometry without accepting a cross-column range box", () => {
  const layer = taggedLayer();
  const originalCreateRange = document.createRange.bind(document);
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = originalCreateRange();
    Object.defineProperty(range, "getClientRects", {
      value: () => {
        const startItem = range.startContainer.parentElement?.closest<HTMLElement>(
          "[data-text-item-index]",
        );
        const endItem = range.endContainer.parentElement?.closest<HTMLElement>(
          "[data-text-item-index]",
        );
        if (!startItem || !endItem) {
          return [];
        }
        if (startItem !== endItem) {
          return [
            {
              left: 112,
              top: 225,
              right: 612,
              bottom: 257,
              width: 500,
              height: 32,
            },
          ];
        }
        const textItemIndex = Number(startItem.dataset.textItemIndex);
        const top = textItemIndex === 4 ? 225 : 245;
        return [
          {
            left: 112,
            top,
            right: 162,
            bottom: top + 12,
            width: 50,
            height: 12,
          },
        ];
      },
    });
    return range;
  });
  const stored: SelectionFragment = {
    id: "fragment-two-column",
    documentSessionId: "document-session-1",
    order: 0,
    text: "pha beta",
    spans: [
      {
        pageIndex: 0,
        start: { textItemIndex: 4, offset: 2 },
        end: { textItemIndex: 5, offset: 4 },
        text: "pha beta",
      },
    ],
  };

  expect(deriveHighlightRects([stored], new Map([[0, layer]]))).toEqual([
    {
      fragmentId: "fragment-two-column",
      pageIndex: 0,
      x: 12,
      y: 25,
      width: 50,
      height: 12,
    },
    {
      fragmentId: "fragment-two-column",
      pageIndex: 0,
      x: 12,
      y: 45,
      width: 50,
      height: 12,
    },
  ]);
});

test("returns no current rectangles for a virtualized-away page", () => {
  const stored = fragment();

  expect(deriveHighlightRects([stored], new Map())).toEqual([]);
  expect(stored.text).toBe("pha\nvirtualized");
});
