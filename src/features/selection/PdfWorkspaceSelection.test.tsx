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
