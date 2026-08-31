import { act, renderHook, waitFor } from "@testing-library/react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { DocumentDescriptor } from "../../shared/ipc/document";
import type { PdfDocumentHandle } from "./pdfDocument";
import { usePdfWorkspaceController } from "./PdfWorkspace";

const { closeMock, loadMock, openMock, readMock } = vi.hoisted(() => ({
  closeMock: vi.fn(),
  loadMock: vi.fn(),
  openMock: vi.fn(),
  readMock: vi.fn(),
}));

vi.mock("../../shared/ipc/document", () => ({
  closePdfDocument: closeMock,
  openPdfDocument: openMock,
  readPdfBytes: readMock,
}));

vi.mock("./pdfDocument", () => ({
  loadPdfDocument: loadMock,
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function withinDeadline<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("bounded lifecycle test timed out")),
      1_000,
    );
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

const descriptor: DocumentDescriptor = {
  documentSessionId: "2d074a5a-3085-46c7-a0e7-f153472210e0",
  fileName: "paper.pdf",
  byteLen: 4,
};
const bytes = new Uint8Array([37, 80, 68, 70]);

type CancellationPhase = "read" | "load" | "page enumeration";
type CancellationAction = "close" | "unmount";

async function runCancellationScenario(
  phase: CancellationPhase,
  action: CancellationAction,
) {
  const readDeferred = deferred<Uint8Array>();
  const loadDeferred = deferred<PdfDocumentHandle>();
  const pageDeferred = deferred<PDFPageProxy>();
  const destroy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const getPage = vi.fn<(pageNumber: number) => Promise<PDFPageProxy>>(() => {
    throw new Error("UNEXPECTED_GET_PAGE");
  });
  const pdfDocument = {
    numPages: 1,
    getPage,
  } as unknown as PDFDocumentProxy;
  const handle: PdfDocumentHandle = { document: pdfDocument, destroy };
  const page = {
    getViewport: vi.fn(() => ({ width: 612, height: 792 })),
  } as unknown as PDFPageProxy;

  openMock.mockResolvedValue(descriptor);
  closeMock.mockResolvedValue(undefined);
  readMock.mockImplementation(() => {
    if (phase === "read") {
      return readDeferred.promise;
    }
    return Promise.resolve(bytes);
  });
  loadMock.mockImplementation(() => {
    if (phase === "read") {
      throw new Error("UNEXPECTED_LOAD");
    }
    if (phase === "load") {
      return loadDeferred.promise;
    }
    return Promise.resolve(handle);
  });
  if (phase === "page enumeration") {
    getPage.mockImplementation((pageNumber) => {
      if (pageNumber !== 1) {
        throw new Error(`UNEXPECTED_PAGE_${pageNumber}`);
      }
      return pageDeferred.promise;
    });
  }

  const { result, unmount } = renderHook(() => usePdfWorkspaceController());
  let opening!: Promise<void>;
  act(() => {
    opening = result.current.open();
  });

  if (phase === "read") {
    await waitFor(() => expect(readMock).toHaveBeenCalledOnce());
  } else if (phase === "load") {
    await waitFor(() => expect(loadMock).toHaveBeenCalledOnce());
  } else {
    await waitFor(() => expect(getPage).toHaveBeenCalledOnce());
  }

  if (action === "close") {
    await act(async () => {
      await result.current.close();
    });
  } else {
    unmount();
  }

  if (phase === "read") {
    readDeferred.resolve(bytes);
  } else if (phase === "load") {
    loadDeferred.resolve(handle);
  } else {
    pageDeferred.resolve(page);
  }

  await act(async () => {
    await withinDeadline(opening);
  });

  expect(closeMock).toHaveBeenCalledTimes(1);
  expect(closeMock).toHaveBeenCalledWith(descriptor.documentSessionId);
  expect(loadMock).toHaveBeenCalledTimes(phase === "read" ? 0 : 1);
  expect(getPage).toHaveBeenCalledTimes(phase === "page enumeration" ? 1 : 0);
  expect(destroy).toHaveBeenCalledTimes(phase === "read" ? 0 : 1);

  if (action === "close") {
    expect(result.current.descriptor).toBeNull();
    expect(result.current.pdfDocument).toBeNull();
    expect(result.current.pages).toEqual([]);
    expect(result.current.status).toBe("准备就绪");
    expect(result.current.isOpening).toBe(false);
    unmount();
  }
}

beforeEach(() => {
  closeMock.mockReset().mockImplementation(() => {
    throw new Error("UNEXPECTED_CLOSE");
  });
  loadMock.mockReset().mockImplementation(() => {
    throw new Error("UNEXPECTED_LOAD");
  });
  openMock.mockReset().mockImplementation(() => {
    throw new Error("UNEXPECTED_OPEN");
  });
  readMock.mockReset().mockImplementation(() => {
    throw new Error("UNEXPECTED_READ");
  });
});

describe.each<CancellationAction>(["close", "unmount"])(
  "%s invalidates an in-flight open",
  (action) => {
    test.each<CancellationPhase>(["read", "load", "page enumeration"])(
      "during %s without stale installation or duplicate disposal",
      async (phase) => {
        await runCancellationScenario(phase, action);
      },
    );
  },
);
