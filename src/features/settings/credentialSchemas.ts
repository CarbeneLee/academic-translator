import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

export const CredentialKindSchema = z.enum([
  "deepseek_api_key",
  "youdao_app_id",
  "youdao_app_secret",
]);

export type CredentialKind = z.infer<typeof CredentialKindSchema>;

export const CredentialSummarySchema = z
  .object({
    kind: CredentialKindSchema,
    configured: z.boolean(),
    maskedHint: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.configured !== (summary.maskedHint !== null)) {
      context.addIssue({
        code: "custom",
        message: "INVALID_IPC_RESPONSE",
      });
    }
  });

export type CredentialSummary = z.infer<typeof CredentialSummarySchema>;

const CredentialStatusesSchema = z
  .array(CredentialSummarySchema)
  .length(CredentialKindSchema.options.length)
  .superRefine((summaries, context) => {
    const kinds = new Set(summaries.map((summary) => summary.kind));
    for (const kind of CredentialKindSchema.options) {
      if (!kinds.has(kind)) {
        context.addIssue({
          code: "custom",
          message: "INVALID_IPC_RESPONSE",
        });
      }
    }
  });

function invalidIpcResponse(): Error {
  return new Error("INVALID_IPC_RESPONSE");
}

function parseSummary(value: unknown): CredentialSummary {
  const result = CredentialSummarySchema.safeParse(value);
  if (!result.success) {
    throw invalidIpcResponse();
  }
  return result.data;
}

export async function credentialStatuses(): Promise<CredentialSummary[]> {
  const value = await invoke<unknown>("credential_statuses");
  const result = CredentialStatusesSchema.safeParse(value);
  if (!result.success) {
    throw invalidIpcResponse();
  }
  return result.data;
}

export async function saveCredential(
  kind: CredentialKind,
  value: string,
): Promise<CredentialSummary> {
  const summary = parseSummary(
    await invoke<unknown>("save_credential", { kind, value }),
  );
  if (summary.kind !== kind || !summary.configured) {
    throw invalidIpcResponse();
  }
  return summary;
}

export async function deleteCredential(
  kind: CredentialKind,
): Promise<CredentialSummary> {
  const summary = parseSummary(
    await invoke<unknown>("delete_credential", { kind }),
  );
  if (summary.kind !== kind || summary.configured) {
    throw invalidIpcResponse();
  }
  return summary;
}
