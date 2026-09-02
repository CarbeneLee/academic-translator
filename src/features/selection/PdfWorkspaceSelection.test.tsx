import { fireEvent, render, screen } from "@testing-library/react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  PdfWorkspace,
  type PdfWorkspaceController,
} from "../pdf-viewer/PdfWorkspace";

vi.mock("../pdf-viewer/PdfPage", async () => {
  const { useEffect, useRef } = await import("react");

  return {
    PdfPage: ({
      pageIndex,
      documentSessionId,
      onTextLayerRendered,
    }: {
      pageIndex: number;
      documentSessionId: string;
      onTextLayerRendered(
        pageIndex: number,
        textLayer: HTMLElement | null,
      ): void;
    }) => {
      const layerRef = useRef<HTMLDivElement>(null);
      useEffect(() => {
        onTextLayerRendered(pageIndex, layerRef.current);
        return () => onTextLayerRendered(pageIndex, null);
      }, [documentSessionId, onTextLayerRendered, pageIndex]);

      return (
        <div>
          <div
            ref={layerRef}
            className="pdfTextLayer"
            data-page-index={pageIndex}
            data-document-session-id={documentSessionId}
          >
            <span data-page-index={pageIndex} data-text-item-index="0">
              alpha
            </span>
            <span data-page-index={pageIndex} data-text-item-index="1">
              beta
            </span>
          </div>
        </div>
      );
    },
  };
});

const documentSessionId = "document-session-1";

function controller(
  overrides: Partial<PdfWorkspaceController> = {},
): PdfWorkspaceController {
  return {
    descriptor: {
      documentSessionId,
      fileName: "paper.pdf",
      byteLen: 12,
    },
    pdfDocument: { numPages: 1 } as PDFDocumentProxy,
    pages: [
      {
        page: {} as PDFPageProxy,
        width: 612,
        height: 792,
      },
    ],
    scale: 1,
    setScale: vi.fn(),
    currentPage: 1,
    setCurrentPage: vi.fn(),
    navigationRequest: { pageNumber: 1, sequence: 0 },
    navigateToPage: vi.fn(),
    isOpening: false,
    status: "paper.pdf · 1 页",
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function selectText(text: string): void {
  const textNode = screen.getByText(text).firstChild;
  if (!(textNode instanceof Text)) {
    throw new Error("expected a text node");
  }
  const range = document.createRange();
  range.selectNodeContents(textNode);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("jsdom selection is unavailable");
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function domRect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => undefined,
  } as DOMRect;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

test("workspace mouse capture stays local until the explicit floating action", () => {
  const onTranslate = vi.fn();
  const view = render(
    <PdfWorkspace controller={controller()} onTranslate={onTranslate} />,
  );
  const pdfRoot = view.container.querySelector<HTMLElement>(
    ".pdfPagesViewport",
  );
  if (!pdfRoot) {
    throw new Error("expected PDF root");
  }

  selectText("alpha");
  fireEvent.mouseUp(pdfRoot);

  expect(onTranslate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "翻译所选文本" }));
  expect(onTranslate).toHaveBeenCalledOnce();
  expect(onTranslate.mock.calls[0][0]).toMatchObject([
    {
      documentSessionId,
      order: 0,
      text: "alpha",
      spans: [
        {
          pageIndex: 0,
          start: { textItemIndex: 0, offset: 0 },
          end: { textItemIndex: 0, offset: 5 },
          text: "alpha",
        },
      ],
    },
  ]);
});

test("workspace anchors the floating action beside the selection and repositions it on scroll and zoom", () => {
  const originalCreateRange = document.createRange.bind(document);
  let selectedRect = domRect(240, 160, 40, 20);
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = originalCreateRange();
    Object.defineProperty(range, "getClientRects", {
      value: () => [selectedRect],
    });
    return range;
  });

  const onTranslate = vi.fn();
  const view = render(
    <PdfWorkspace
      controller={controller({ descriptor: null, pdfDocument: null, pages: [] })}
      onTranslate={onTranslate}
    />,
  );
  view.rerender(
    <PdfWorkspace controller={controller()} onTranslate={onTranslate} />,
  );
  const pdfRoot = view.container.querySelector<HTMLElement>(
    ".pdfPagesViewport",
  );
  const textLayer = view.container.querySelector<HTMLElement>(".pdfTextLayer");
  if (!pdfRoot || !textLayer) {
    throw new Error("expected PDF viewport and text layer");
  }

  vi.spyOn(pdfRoot, "getBoundingClientRect").mockReturnValue(
    domRect(100, 50, 800, 600),
  );
  let textLayerRect = domRect(200, 100, 612, 792);
  vi.spyOn(textLayer, "getBoundingClientRect").mockImplementation(
    () => textLayerRect,
  );

  selectText("alpha");
  fireEvent.mouseUp(pdfRoot);

  const action = screen.getByRole("button", { name: "翻译所选文本" });
  expect(action).toHaveStyle({ left: "208px", top: "188px" });

  textLayerRect = domRect(200, 40, 612, 792);
  fireEvent.scroll(pdfRoot);

  expect(action).toHaveStyle({ left: "208px", top: "128px" });

  textLayerRect = domRect(200, -20, 612, 792);
  fireEvent.scroll(window);

  expect(action).toHaveStyle({ left: "208px", top: "68px" });

  selectedRect = domRect(260, 220, 40, 20);
  view.rerender(
    <PdfWorkspace
      controller={controller({ scale: 2 })}
      onTranslate={onTranslate}
    />,
  );

  expect(action).toHaveStyle({ left: "228px", top: "248px" });
});

test("workspace keeps Alt captures discrete and clears them on document close", () => {
  const onTranslate = vi.fn();
  const view = render(
    <PdfWorkspace controller={controller()} onTranslate={onTranslate} />,
  );
  const pdfRoot = view.container.querySelector<HTMLElement>(
    ".pdfPagesViewport",
  );
  if (!pdfRoot) {
    throw new Error("expected PDF root");
  }

  selectText("alpha");
  fireEvent.mouseUp(pdfRoot);
  selectText("beta");
  fireEvent.mouseUp(pdfRoot, { altKey: true });
  fireEvent.click(screen.getByRole("button", { name: "翻译所选文本" }));
  expect(
    onTranslate.mock.calls[0][0].map(
      (fragment: { text: string }) => fragment.text,
    ),
  ).toEqual(["alpha", "beta"]);

  view.rerender(
    <PdfWorkspace
      controller={
        controller({ descriptor: null, pdfDocument: null, pages: [] })
      }
      onTranslate={onTranslate}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "翻译所选文本" }),
  ).not.toBeInTheDocument();
});

test("workspace forwards selection lifecycle and disables only the active manual trigger", () => {
  const onTranslate = vi.fn();
  const onSelectionChange = vi.fn();
  const onSelectionMutation = vi.fn();
  const view = render(
    <PdfWorkspace
      controller={controller()}
      onTranslate={onTranslate}
      onSelectionChange={onSelectionChange}
      onSelectionMutation={onSelectionMutation}
      isRequestActive
    />,
  );
  const pdfRoot = view.container.querySelector<HTMLElement>(
    ".pdfPagesViewport",
  );
  if (!pdfRoot) {
    throw new Error("expected PDF root");
  }

  selectText("alpha");
  fireEvent.mouseUp(pdfRoot);

  expect(onSelectionMutation).toHaveBeenCalledOnce();
  expect(onSelectionChange).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ text: "alpha" })]),
  );
  expect(
    screen.getByRole("button", { name: "翻译所选文本" }),
  ).toBeDisabled();
  expect(onTranslate).not.toHaveBeenCalled();
});
