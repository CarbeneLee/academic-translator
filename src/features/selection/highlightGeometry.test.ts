import { deriveHighlightRects } from "./highlightGeometry";
import type { SelectionFragment } from "./types";

function fragment(): SelectionFragment {
  return {
    id: "fragment-1",
    documentSessionId: "document-session-1",
    order: 0,
    text: "pha beta\nvirtualized",
    spans: [
      {
        pageIndex: 0,
        start: { textItemIndex: 4, offset: 2 },
        end: { textItemIndex: 5, offset: 4 },
        text: "pha beta",
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

test("returns no current rectangles for a virtualized-away page", () => {
  const stored = fragment();

  expect(deriveHighlightRects([stored], new Map())).toEqual([]);
  expect(stored.text).toBe("pha beta\nvirtualized");
});
