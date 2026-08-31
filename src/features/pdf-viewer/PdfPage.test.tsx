import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { tagTextLayer } from "./PdfPage";

vi.mock("pdfjs-dist", () => ({
  TextLayer: class {},
}));

function textItem(str: string): TextItem {
  return {
    str,
    dir: "ltr",
    transform: [1, 0, 0, 1, 0, 0],
    width: str.length,
    height: 12,
    fontName: "sans",
    hasEOL: false,
  };
}

function renderedSpan(): HTMLSpanElement {
  const span = document.createElement("span");
  span.setAttribute("role", "presentation");
  return span;
}

test("tags rendered text spans with stable page and source-item indices", () => {
  const textLayer = document.createElement("div");
  textLayer.append(renderedSpan(), renderedSpan());

  tagTextLayer(3, [textItem("alpha"), textItem("beta")], textLayer);

  expect(textLayer.dataset.selectionSupported).toBe("true");
  expect(textLayer.children[0]).toHaveAttribute("data-page-index", "3");
  expect(textLayer.children[0]).toHaveAttribute("data-text-item-index", "0");
  expect(textLayer.children[1]).toHaveAttribute("data-text-item-index", "1");
});

test("preserves original text-item indices when empty items render no span", () => {
  const textLayer = document.createElement("div");
  textLayer.append(renderedSpan(), renderedSpan());

  tagTextLayer(
    0,
    [textItem("alpha"), textItem(""), textItem("beta")],
    textLayer,
  );

  expect(textLayer.children[0]).toHaveAttribute("data-text-item-index", "0");
  expect(textLayer.children[1]).toHaveAttribute("data-text-item-index", "2");
});

test("marks selection unsupported instead of assigning unstable anchors", () => {
  const textLayer = document.createElement("div");
  textLayer.append(renderedSpan());

  tagTextLayer(1, [textItem("alpha"), textItem("beta")], textLayer);

  expect(textLayer.dataset.selectionSupported).toBe("false");
  expect(textLayer.querySelector("[data-text-item-index]")).toBeNull();
});

test("tags a rendered text layer with its document session and announces rerenders", () => {
  const textLayer = document.createElement("div");
  textLayer.append(renderedSpan());
  const rendered = vi.fn();
  textLayer.addEventListener("textlayerrendered", rendered);

  tagTextLayer(
    2,
    [textItem("stable anchor")],
    textLayer,
    "document-session-1",
  );

  expect(textLayer).toHaveAttribute("data-page-index", "2");
  expect(textLayer).toHaveAttribute(
    "data-document-session-id",
    "document-session-1",
  );
  expect(rendered).toHaveBeenCalledOnce();
});
