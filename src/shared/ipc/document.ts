import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

export type DocumentDescriptor = {
  documentSessionId: string;
  fileName: string;
  byteLen: number;
};

export const DocumentDescriptorSchema = z
  .object({
    documentSessionId: z.string().uuid(),
    fileName: z.string().min(1),
    byteLen: z.number().int().nonnegative(),
  })
  .strict();

function invalidIpcResponse(): Error {
  return new Error("INVALID_IPC_RESPONSE");
}

export async function openPdfDocument(): Promise<DocumentDescriptor | null> {
  const value = await invoke<unknown>("open_pdf_document");
  if (value === null) {
    return null;
  }

  const result = DocumentDescriptorSchema.safeParse(value);
  if (!result.success) {
    throw invalidIpcResponse();
  }
  return result.data;
}

export async function readPdfBytes(
  documentSessionId: string,
): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_pdf_bytes", {
    documentSessionId,
  });
  if (!(buffer instanceof ArrayBuffer)) {
    throw invalidIpcResponse();
  }
  return new Uint8Array(buffer);
}

export async function closePdfDocument(
  documentSessionId: string,
): Promise<void> {
  await invoke<void>("close_pdf_document", { documentSessionId });
}
