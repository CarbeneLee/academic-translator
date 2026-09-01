import { z } from "zod";

export const ProviderSchema = z.enum(["deepseek", "youdao"]);
export const DiagnosticCodeSchema = z.enum(["cache_unavailable"]);

export const TranslationResultSchema = z
  .object({
    requestId: z.string().uuid(),
    documentSessionId: z.string().uuid(),
    provider: ProviderSchema,
    modelId: z.string().min(1),
    normalizedSource: z.string().min(1).max(12_000),
    translation: z.string().min(1).max(12_000),
    cacheHit: z.boolean(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().nullable(),
        outputTokens: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    diagnostics: z.array(DiagnosticCodeSchema),
  })
  .strict();

export const CommandErrorSchema = z
  .object({
    code: z.enum([
      "CREDENTIALS_MISSING",
      "AUTH_INVALID",
      "SELECTION_EMPTY",
      "SELECTION_TOO_LARGE",
      "RATE_LIMITED",
      "NETWORK_UNAVAILABLE",
      "REQUEST_TIMEOUT",
      "REQUEST_CANCELLED",
      "PROVIDER_UNAVAILABLE",
      "MALFORMED_RESPONSE",
      "CACHE_UNAVAILABLE",
      "INVALID_IPC_RESPONSE",
    ]),
    retryable: z.boolean(),
  })
  .strict();

export const CacheStatsSchema = z
  .object({
    rowCount: z.number().int().nonnegative(),
    databaseBytes: z.number().int().nonnegative(),
  })
  .strict();

export const UnitResponseSchema = z.null();

export type Provider = z.infer<typeof ProviderSchema>;
export type TranslationResult = z.infer<typeof TranslationResultSchema>;
export type CommandError = z.infer<typeof CommandErrorSchema>;
export type CacheStats = z.infer<typeof CacheStatsSchema>;
