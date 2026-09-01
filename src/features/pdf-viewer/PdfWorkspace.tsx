import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  closePdfDocument,
  openPdfDocument,
  readPdfBytes,
  type DocumentDescriptor,
} from "../../shared/ipc/document";
import { FloatingTranslateAction } from "../selection/FloatingTranslateAction";
import type { SelectionFragment } from "../selection/types";
import { usePdfSelection } from "../selection/usePdfSelection";
import { loadPdfDocument, type PdfDocumentHandle } from "./pdfDocument";
import { PdfPage } from "./PdfPage";

const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const SCALE_STEP = 0.25;
const OVERSCAN_PAGES = 2;

type PageRecord = {
  page: PDFPageProxy;
  width: number;
  height: number;
};

type OwnedDocument = {
  descriptor: DocumentDescriptor;
  handle: PdfDocumentHandle | null;
  handleDestroyPromise: Promise<void> | null;
  released: boolean;
  sessionClosePromise: Promise<void> | null;
};

type OpenOperation = {
  generation: number;
  resources: OwnedDocument | null;
};

function ownDocument(descriptor: DocumentDescriptor): OwnedDocument {
  return {
    descriptor,
    handle: null,
    handleDestroyPromise: null,
    released: false,
    sessionClosePromise: null,
  };
}

function closeOwnedSession(resources: OwnedDocument): Promise<void> {
  resources.sessionClosePromise ??= closePdfDocument(
    resources.descriptor.documentSessionId,
  ).catch(() => undefined);
  return resources.sessionClosePromise;
}

function destroyOwnedHandle(resources: OwnedDocument): Promise<void> {
  if (!resources.handle) {
    return Promise.resolve();
  }
  resources.handleDestroyPromise ??= resources.handle
    .destroy()
    .catch(() => undefined);
  return resources.handleDestroyPromise;
}

async function releaseDocument(resources: OwnedDocument): Promise<void> {
  resources.released = true;
  await Promise.all([
    closeOwnedSession(resources),
    destroyOwnedHandle(resources),
  ]);
}

async function attachHandle(
  resources: OwnedDocument,
  handle: PdfDocumentHandle,
): Promise<void> {
  resources.handle = handle;
  if (resources.released) {
    await destroyOwnedHandle(resources);
  }
}

function pagesAround(pageIndex: number, pageCount: number): Set<number> {
  const pages = new Set<number>();
  const start = Math.max(0, pageIndex - OVERSCAN_PAGES);
  const end = Math.min(pageCount - 1, pageIndex + OVERSCAN_PAGES);
  for (let index = start; index <= end; index += 1) {
    pages.add(index);
  }
  return pages;
}

export function usePdfWorkspaceController({
  onDocumentSessionChange,
}: {
  onDocumentSessionChange?(documentSessionId: string | null): void;
} = {}) {
  const [descriptor, setDescriptor] = useState<DocumentDescriptor | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PageRecord[]>([]);
  const [scale, setScale] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [navigationRequest, setNavigationRequest] = useState({
    pageNumber: 1,
    sequence: 0,
  });
  const [isOpening, setIsOpening] = useState(false);
  const [status, setStatus] = useState("准备就绪");
  const activeDocumentRef = useRef<OwnedDocument | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const pendingOpenRef = useRef<OpenOperation | null>(null);
  const onDocumentSessionChangeRef = useRef(onDocumentSessionChange);
  onDocumentSessionChangeRef.current = onDocumentSessionChange;

  const isCurrentOperation = useCallback((operation: OpenOperation) => {
    return (
      mountedRef.current &&
      generationRef.current === operation.generation &&
      pendingOpenRef.current === operation
    );
  }, []);

  const close = useCallback(async () => {
    generationRef.current += 1;
    const pending = pendingOpenRef.current;
    pendingOpenRef.current = null;
    const active = activeDocumentRef.current;
    activeDocumentRef.current = null;
    if (active) {
      onDocumentSessionChangeRef.current?.(null);
    }
    setDescriptor(null);
    setPdfDocument(null);
    setPages([]);
    setScale(1);
    setCurrentPage(1);
    setIsOpening(false);
    setStatus("准备就绪");
    await Promise.all([
      pending?.resources
        ? releaseDocument(pending.resources)
        : Promise.resolve(),
      active ? releaseDocument(active) : Promise.resolve(),
    ]);
  }, []);

  const open = useCallback(async () => {
    if (!mountedRef.current || pendingOpenRef.current) {
      return;
    }
    const operation: OpenOperation = {
      generation: generationRef.current + 1,
      resources: null,
    };
    generationRef.current = operation.generation;
    pendingOpenRef.current = operation;
    setIsOpening(true);
    setStatus("正在打开 PDF…");

    try {
      const nextDescriptor = await openPdfDocument();
      if (!nextDescriptor) {
        if (isCurrentOperation(operation)) {
          pendingOpenRef.current = null;
          setStatus(activeDocumentRef.current ? "PDF 已打开" : "准备就绪");
        }
        return;
      }
      const resources = ownDocument(nextDescriptor);
      operation.resources = resources;
      if (!isCurrentOperation(operation)) {
        await releaseDocument(resources);
        return;
      }

      const previous = activeDocumentRef.current;
      if (previous) {
        activeDocumentRef.current = null;
        onDocumentSessionChangeRef.current?.(null);
        setDescriptor(null);
        setPdfDocument(null);
        setPages([]);
        setScale(1);
        setCurrentPage(1);
        void releaseDocument(previous);
      }

      const bytes = await readPdfBytes(nextDescriptor.documentSessionId);
      if (!isCurrentOperation(operation)) {
        await releaseDocument(resources);
        return;
      }

      const nextHandle = await loadPdfDocument(bytes);
      await attachHandle(resources, nextHandle);
      if (!isCurrentOperation(operation)) {
        await releaseDocument(resources);
        return;
      }

      const nextPdfDocument = nextHandle.document;
      const nextPages = await Promise.all(
        Array.from({ length: nextPdfDocument.numPages }, async (_, index) => {
          const page = await nextPdfDocument.getPage(index + 1);
          const viewport = page.getViewport({ scale: 1 });
          return { page, width: viewport.width, height: viewport.height };
        }),
      );
      if (!isCurrentOperation(operation)) {
        await releaseDocument(resources);
        return;
      }

      activeDocumentRef.current = resources;
      pendingOpenRef.current = null;
      onDocumentSessionChangeRef.current?.(
        nextDescriptor.documentSessionId,
      );
      setDescriptor(nextDescriptor);
      setPdfDocument(nextPdfDocument);
      setPages(nextPages);
      setScale(1);
      setCurrentPage(1);
      setNavigationRequest((request) => ({
        pageNumber: 1,
        sequence: request.sequence + 1,
      }));
      setStatus(`${nextDescriptor.fileName} · ${nextPdfDocument.numPages} 页`);
    } catch {
      const wasCurrent = isCurrentOperation(operation);
      if (pendingOpenRef.current === operation) {
        pendingOpenRef.current = null;
      }
      if (operation.resources) {
        await releaseDocument(operation.resources);
      }
      if (wasCurrent) {
        setStatus("无法打开 PDF，请重试。");
      }
    } finally {
      if (
        mountedRef.current &&
        generationRef.current === operation.generation
      ) {
        if (pendingOpenRef.current === operation) {
          pendingOpenRef.current = null;
        }
        setIsOpening(false);
      }
    }
  }, [isCurrentOperation]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      const pending = pendingOpenRef.current;
      pendingOpenRef.current = null;
      const active = activeDocumentRef.current;
      activeDocumentRef.current = null;
      void Promise.all([
        pending?.resources
          ? releaseDocument(pending.resources)
          : Promise.resolve(),
        active ? releaseDocument(active) : Promise.resolve(),
      ]);
    };
  }, []);

  const navigateToPage = useCallback((pageNumber: number) => {
    setNavigationRequest((request) => ({
      pageNumber,
      sequence: request.sequence + 1,
    }));
  }, []);

  return {
    descriptor,
    pdfDocument,
    pages,
    scale,
    setScale,
    currentPage,
    setCurrentPage,
    navigationRequest,
    navigateToPage,
    isOpening,
    status,
    open,
    close,
  };
}

export type PdfWorkspaceController = ReturnType<
  typeof usePdfWorkspaceController
>;

export function PdfDocumentToolbar({
  controller,
}: {
  controller: PdfWorkspaceController;
}) {
  const hasDocument = controller.pdfDocument !== null;

  return (
    <>
      <button
        type="button"
        aria-label="打开 PDF"
        onClick={() => void controller.open()}
        disabled={controller.isOpening}
      >
        打开 PDF
      </button>
      {hasDocument && (
        <>
          <span className="documentName" title={controller.descriptor?.fileName}>
            {controller.descriptor?.fileName}
          </span>
          <label className="pageNavigation">
            <span className="visuallyHidden">页码</span>
            <input
              aria-label="页码"
              type="number"
              min={1}
              max={controller.pages.length}
              value={controller.currentPage}
              onChange={(event) => {
                controller.navigateToPage(Number(event.currentTarget.value));
              }}
            />
            <span>/ {controller.pages.length}</span>
          </label>
          <button
            type="button"
            aria-label="缩小"
            disabled={controller.scale <= MIN_SCALE}
            onClick={() =>
              controller.setScale((value) =>
                Math.max(MIN_SCALE, value - SCALE_STEP),
              )
            }
          >
            −
          </button>
          <button
            type="button"
            aria-label="重置缩放"
            onClick={() => controller.setScale(1)}
          >
            {Math.round(controller.scale * 100)}%
          </button>
          <button
            type="button"
            aria-label="放大"
            disabled={controller.scale >= MAX_SCALE}
            onClick={() =>
              controller.setScale((value) =>
                Math.min(MAX_SCALE, value + SCALE_STEP),
              )
            }
          >
            +
          </button>
          <button
            type="button"
            aria-label="关闭 PDF"
            onClick={() => void controller.close()}
          >
            关闭
          </button>
        </>
      )}
    </>
  );
}

export function PdfWorkspace({
  controller,
  onTranslate,
  onSelectionChange,
  onSelectionMutation,
  isRequestActive = false,
  onCancelActiveRequest,
}: {
  controller: PdfWorkspaceController;
  onTranslate(fragments: SelectionFragment[]): void;
  onSelectionChange?(fragments: SelectionFragment[]): void;
  onSelectionMutation?(): void;
  isRequestActive?: boolean;
  onCancelActiveRequest?(): void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const placeholdersRef = useRef(new Map<number, HTMLDivElement>());
  const visiblePagesRef = useRef(new Set<number>());
  const [mountedPages, setMountedPages] = useState<Set<number>>(new Set());
  const selection = usePdfSelection({
    rootRef: viewportRef,
    documentSessionId: controller.descriptor?.documentSessionId ?? null,
    scale: controller.scale,
    onTranslate,
    onSelectionChange,
    onSelectionMutation,
    isRequestActive,
    onCancelActiveRequest,
  });

  useEffect(() => {
    if (controller.pages.length === 0) {
      visiblePagesRef.current.clear();
      setMountedPages(new Set());
      return;
    }

    setMountedPages(pagesAround(0, controller.pages.length));
    if (typeof IntersectionObserver === "undefined") {
      setMountedPages(new Set(controller.pages.map((_, index) => index)));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageIndex = Number(
            (entry.target as HTMLElement).dataset.pageIndex,
          );
          if (entry.isIntersecting) {
            visiblePagesRef.current.add(pageIndex);
          } else {
            visiblePagesRef.current.delete(pageIndex);
          }
        }

        const nextMounted = new Set<number>();
        const visible = Array.from(visiblePagesRef.current).sort((a, b) => a - b);
        for (const pageIndex of visible) {
          for (const overscanPage of pagesAround(
            pageIndex,
            controller.pages.length,
          )) {
            nextMounted.add(overscanPage);
          }
        }
        if (visible.length > 0) {
          controller.setCurrentPage(visible[0] + 1);
          setMountedPages(nextMounted);
        }
      },
      { root: viewportRef.current, threshold: 0.01 },
    );

    for (const placeholder of placeholdersRef.current.values()) {
      observer.observe(placeholder);
    }
    return () => observer.disconnect();
  }, [controller.pages, controller.setCurrentPage]);

  useEffect(() => {
    if (controller.pages.length === 0) {
      return;
    }
    const pageNumber = Math.min(
      controller.pages.length,
      Math.max(1, Math.trunc(controller.navigationRequest.pageNumber) || 1),
    );
    controller.setCurrentPage(pageNumber);
    setMountedPages(pagesAround(pageNumber - 1, controller.pages.length));
    placeholdersRef.current.get(pageNumber - 1)?.scrollIntoView({
      block: "start",
    });
  }, [
    controller.navigationRequest,
    controller.pages.length,
    controller.setCurrentPage,
  ]);

  if (!controller.pdfDocument || !controller.descriptor) {
    return (
      <div className="emptyDocumentState">
        <p>打开本地 PDF 开始阅读</p>
      </div>
    );
  }

  const descriptor = controller.descriptor;

  return (
    <div className="pdfWorkspaceSelectionShell">
      <div
        ref={viewportRef}
        className="pdfPagesViewport"
        data-document-session-id={descriptor.documentSessionId}
      >
        <div className="pdfPages">
          {controller.pages.map((pageRecord, pageIndex) => (
            <div
              key={pageIndex}
              ref={(element) => {
                if (element) {
                  placeholdersRef.current.set(pageIndex, element);
                } else {
                  placeholdersRef.current.delete(pageIndex);
                }
              }}
              className="pdfPagePlaceholder"
              data-page-index={pageIndex}
              style={{
                width: pageRecord.width * controller.scale,
                height: pageRecord.height * controller.scale,
              }}
            >
              {mountedPages.has(pageIndex) && (
                <PdfPage
                  page={pageRecord.page}
                  pageIndex={pageIndex}
                  scale={controller.scale}
                  documentSessionId={descriptor.documentSessionId}
                  highlightRects={selection.highlightRects}
                  onTextLayerRendered={selection.registerTextLayer}
                />
              )}
            </div>
          ))}
        </div>
      </div>
      <FloatingTranslateAction
        fragments={selection.fragments}
        onTranslate={onTranslate}
        disabled={isRequestActive}
      />
    </div>
  );
}
