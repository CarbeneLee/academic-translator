import { invoke } from "@tauri-apps/api/core";
import { getDocument } from "pdfjs-dist";
import {
  closePdfDocument,
  openPdfDocument,
  readPdfBytes,
} from "../../shared/ipc/document";
import { loadPdfDocument } from "./pdfDocument";

const { mockInvoke, getDocumentMock, loadingTaskDestroyMock, pdfDocument } =
  vi.hoisted(() => ({
    mockInvoke: vi.fn(),
    getDocumentMock: vi.fn(),
    loadingTaskDestroyMock: vi.fn(),
    pdfDocument: { numPages: 1 },
  }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("pdfjs-dist", () => ({
  getDocument: getDocumentMock,
  GlobalWorkerOptions: { workerSrc: "" },
}));

beforeEach(() => {
  mockInvoke.mockReset();
  getDocumentMock.mockReset();
  loadingTaskDestroyMock.mockReset();
  loadingTaskDestroyMock.mockResolvedValue(undefined);
  getDocumentMock.mockReturnValue({
    promise: Promise.resolve(pdfDocument),
    destroy: loadingTaskDestroyMock,
  });
});

test("rejects a malformed document descriptor from IPC", async () => {
  mockInvoke.mockResolvedValue({
    documentSessionId: "not-a-uuid",
    fileName: "a.pdf",
  });

  await expect(openPdfDocument()).rejects.toThrow("INVALID_IPC_RESPONSE");
});

test("reads PDF bytes through binary IPC scoped to the document session", async () => {
  const buffer = new Uint8Array([37, 80, 68, 70]).buffer;
  mockInvoke.mockResolvedValue(buffer);

  const bytes = await readPdfBytes("2d074a5a-3085-46c7-a0e7-f153472210e0");

  expect(invoke).toHaveBeenCalledWith("read_pdf_bytes", {
    documentSessionId: "2d074a5a-3085-46c7-a0e7-f153472210e0",
  });
  expect(bytes).toEqual(new Uint8Array([37, 80, 68, 70]));
});

test("closes only the requested document session", async () => {
  mockInvoke.mockResolvedValue(undefined);

  await closePdfDocument("2d074a5a-3085-46c7-a0e7-f153472210e0");

  expect(invoke).toHaveBeenCalledWith("close_pdf_document", {
    documentSessionId: "2d074a5a-3085-46c7-a0e7-f153472210e0",
  });
});

test("loads PDF.js v6 from local bytes with worker fetching disabled", async () => {
  const handle = await loadPdfDocument(new Uint8Array([37, 80, 68, 70]));

  expect(getDocument).toHaveBeenCalledWith({
    data: expect.any(Uint8Array),
    useWorkerFetch: false,
  });
  expect(handle.document).toBe(pdfDocument);
});

test("destroys the originating PDF.js loading task through the document handle", async () => {
  const handle = await loadPdfDocument(new Uint8Array([37, 80, 68, 70]));

  await handle.destroy();

  expect(loadingTaskDestroyMock).toHaveBeenCalledOnce();
});

test("destroys the PDF.js loading task when document loading fails", async () => {
  getDocumentMock.mockReturnValue({
    promise: Promise.reject(new Error("malformed")),
    destroy: loadingTaskDestroyMock,
  });

  await expect(
    loadPdfDocument(new Uint8Array([37, 80, 68, 70])),
  ).rejects.toThrow("malformed");
  expect(loadingTaskDestroyMock).toHaveBeenCalledOnce();
});
