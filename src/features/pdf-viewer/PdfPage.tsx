import { useEffect, useRef, useState } from "react";
import {
  setLayerDimensions,
  TextLayer,
  type PDFPageProxy,
} from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { SelectionHighlights } from "../selection/SelectionHighlights";
import type { HighlightRect } from "../selection/highlightGeometry";
import "pdfjs-dist/web/pdf_viewer.css";

const UNSUPPORTED_TEXT_MESSAGE = "此页面没有可用的文本层，无法选择文本。";

function renderedTextSpans(textLayer: HTMLElement): HTMLSpanElement[] {
  return Array.from(
    textLayer.querySelectorAll<HTMLSpanElement>('span[role="presentation"]'),
  );
}

export function tagTextLayer(
  pageIndex: number,
  textItems: readonly TextItem[],
  textLayer: HTMLElement,
  documentSessionId?: string,
): void {
  textLayer.dataset.pageIndex = String(pageIndex);
  if (documentSessionId) {
    textLayer.dataset.documentSessionId = documentSessionId;
  } else {
    delete textLayer.dataset.documentSessionId;
  }
  const indexedItems = textItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.str.length > 0);
  const spans = renderedTextSpans(textLayer);

  for (const span of spans) {
    delete span.dataset.pageIndex;
    delete span.dataset.textItemIndex;
  }

  if (indexedItems.length === 0 || indexedItems.length !== spans.length) {
    textLayer.dataset.selectionSupported = "false";
    textLayer.dispatchEvent(
      new CustomEvent("textlayerrendered", { bubbles: true }),
    );
    return;
  }

  textLayer.dataset.selectionSupported = "true";
  indexedItems.forEach(({ index }, renderedIndex) => {
    const span = spans[renderedIndex];
    span.dataset.pageIndex = String(pageIndex);
    span.dataset.textItemIndex = String(index);
  });
  textLayer.dispatchEvent(
    new CustomEvent("textlayerrendered", { bubbles: true }),
  );
}

type PdfPageProps = {
  page: PDFPageProxy;
  pageIndex: number;
  scale: number;
  documentSessionId: string;
  highlightRects: readonly HighlightRect[];
  onTextLayerRendered(pageIndex: number, textLayer: HTMLElement | null): void;
};

export function PdfPage({
  page,
  pageIndex,
  scale,
  documentSessionId,
  highlightRects,
  onTextLayerRendered,
}: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [selectionSupported, setSelectionSupported] = useState<boolean | null>(
    null,
  );
  const [renderFailed, setRenderFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textLayerElement = textLayerRef.current;
    if (!canvas || !textLayerElement) {
      return;
    }

    let disposed = false;
    let canvasTask: ReturnType<PDFPageProxy["render"]> | undefined;
    let textLayerTask: TextLayer | undefined;

    setSelectionSupported(null);
    setRenderFailed(false);
    textLayerElement.replaceChildren();
    delete textLayerElement.dataset.selectionSupported;

    const renderPage = async () => {
      const viewport = page.getViewport({ scale });
      const outputScale = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
      canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setLayerDimensions(textLayerElement, viewport);

      canvasTask = page.render({
        canvas,
        viewport,
        transform:
          outputScale === 1
            ? undefined
            : [outputScale, 0, 0, outputScale, 0, 0],
      });
      const textContent = await page.getTextContent();
      if (disposed) {
        return;
      }

      textLayerTask = new TextLayer({
        container: textLayerElement,
        textContentSource: textContent,
        viewport,
      });
      await Promise.all([canvasTask.promise, textLayerTask.render()]);
      if (disposed) {
        return;
      }

      const textItems = textContent.items.filter(
        (item): item is TextItem => "str" in item,
      );
      tagTextLayer(
        pageIndex,
        textItems,
        textLayerElement,
        documentSessionId,
      );
      onTextLayerRendered(pageIndex, textLayerElement);
      setSelectionSupported(
        textLayerElement.dataset.selectionSupported === "true",
      );
    };

    void renderPage().catch(() => {
      if (!disposed) {
        setRenderFailed(true);
        setSelectionSupported(false);
      }
    });

    return () => {
      disposed = true;
      onTextLayerRendered(pageIndex, null);
      canvasTask?.cancel();
      textLayerTask?.cancel();
    };
  }, [documentSessionId, onTextLayerRendered, page, pageIndex, scale]);

  return (
    <div className="pdfPageSurface" aria-label={`第 ${pageIndex + 1} 页`}>
      <canvas ref={canvasRef} className="pdfPageCanvas" />
      <SelectionHighlights
        pageIndex={pageIndex}
        rectangles={highlightRects}
      />
      <div ref={textLayerRef} className="textLayer pdfTextLayer" />
      {selectionSupported === false && (
        <p className="pdfPageNotice" role="status">
          {renderFailed ? "此页面渲染失败。" : UNSUPPORTED_TEXT_MESSAGE}
        </p>
      )}
    </div>
  );
}
