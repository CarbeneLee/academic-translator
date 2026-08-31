import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import workerSource from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerSource;

export type PdfDocumentHandle = {
  document: PDFDocumentProxy;
  destroy(): Promise<void>;
};

export async function loadPdfDocument(
  bytes: Uint8Array,
): Promise<PdfDocumentHandle> {
  const loadingTask = getDocument({
    data: bytes,
    useWorkerFetch: false,
  });
  try {
    const document = await loadingTask.promise;
    return {
      document,
      destroy: () => loadingTask.destroy(),
    };
  } catch (error) {
    await loadingTask.destroy().catch(() => undefined);
    throw error;
  }
}
