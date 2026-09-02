import { render, waitFor } from "@testing-library/react";
import type {
  PDFPageProxy,
  TextContent,
  TextItem,
} from "pdfjs-dist/types/src/display/api";
import { PdfPage, tagTextLayer } from "./PdfPage";

vi.mock("pdfjs-dist", () => ({
  setLayerDimensions: vi.fn(),
  TextLayer: class {
    readonly container: HTMLElement;
    readonly textContentSource: TextContent;

    constructor({
      container,
      textContentSource,
    }: {
      container: HTMLElement;
      textContentSource: TextContent;
    }) {
      this.container = container;
      this.textContentSource = textContentSource;
    }

    render() {
      for (const item of this.textContentSource.items) {
        if (!("str" in item) || item.str.length === 0) {
          continue;
        }
        this.container.append(renderedSpan());
      }
      return Promise.resolve();
    }

    cancel() {}
  },
}));

function textItem(str: string, hasEOL = false): TextItem {
  return {
    str,
    dir: "ltr",
    transform: [1, 0, 0, 1, 0, 0],
    width: str.length,
    height: 12,
    fontName: "sans",
    hasEOL,
  };
}

function renderedSpan(): HTMLSpanElement {
  const span = document.createElement("span");
  span.setAttribute("role", "presentation");
  return span;
}

test("renders PDF canvas and text layer when async stream iteration is unavailable in WKWebView", async () => {
  const chunks: TextContent[] = [
    {
      items: [textItem("alpha")],
      styles: {
        sans: {
          fontFamily: "sans-serif",
          ascent: 0.8,
          descent: -0.2,
          vertical: false,
        },
      },
      lang: "en",
    },
    {
      items: [textItem("beta")],
      styles: {},
      lang: null,
    },
  ];
  let chunkIndex = 0;
  const read = vi.fn(async () => {
    const value = chunks[chunkIndex];
    chunkIndex += 1;
    return value === undefined
      ? { done: true as const, value: undefined }
      : { done: false as const, value };
  });
  const getTextContent = vi.fn().mockRejectedValue(
    new TypeError("ReadableStream is not async iterable"),
  );
  const getImageData = vi.fn();
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({ getImageData } as unknown as CanvasRenderingContext2D);
  const releaseLock = vi.fn();
  const onTextLayerRendered = vi.fn();
  const page = {
    getViewport: () => ({ width: 600, height: 800 }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    getTextContent,
    streamTextContent: () => ({
      getReader: () => ({ read, releaseLock }),
    }),
  } as unknown as PDFPageProxy;

  render(
    <PdfPage
      page={page}
      pageIndex={0}
      scale={1}
      documentSessionId="document-session-1"
      highlightRects={[]}
      onTextLayerRendered={onTextLayerRendered}
    />,
  );

  await waitFor(() => {
    expect(onTextLayerRendered).toHaveBeenCalledWith(0, expect.any(HTMLElement));
  });
  expect(getTextContent).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(3);
  expect(releaseLock).toHaveBeenCalledOnce();
  expect(getImageData).toHaveBeenCalledWith(0, 0, 1, 1);
  const textLayer = onTextLayerRendered.mock.calls[0]?.[1] as HTMLElement;
  expect(textLayer).toHaveAttribute("data-selection-supported", "true");
  expect(textLayer.querySelectorAll('span[role="presentation"]')).toHaveLength(
    2,
  );
  getContext.mockRestore();
});

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

test("records every PDF.js EOL item index including empty leading, middle, and trailing items", () => {
  const textLayer = document.createElement("div");
  textLayer.append(renderedSpan(), renderedSpan());

  tagTextLayer(
    0,
    [
      textItem("", true),
      textItem("multi-"),
      textItem("", true),
      textItem("modal", true),
      textItem("", true),
    ],
    textLayer,
  );

  expect(textLayer.children[0]).toHaveAttribute("data-text-item-index", "1");
  expect(textLayer.children[1]).toHaveAttribute("data-text-item-index", "3");
  expect(textLayer).toHaveAttribute(
    "data-eol-after-item-indices",
    "0,2,3,4",
  );
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
