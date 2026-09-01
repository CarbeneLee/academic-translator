import { invoke } from "@tauri-apps/api/core";
import type { SelectionFragment } from "../selection/types";
import { invalidIpcResponse } from "./errors";
import {
  CacheStatsSchema,
  CommandErrorSchema,
  TranslationResultSchema,
  UnitResponseSchema,
  type CacheStats,
  type CommandError,
  type Provider,
  type TranslationResult,
} from "./schemas";

export type TranslationRequest = {
  requestId: string;
  documentSessionId: string;
  provider: Provider;
  fragments: Array<Pick<SelectionFragment, "id" | "order" | "text">>;
};

function commandError(value: unknown): CommandError {
  const parsed = CommandErrorSchema.safeParse(value);
  return parsed.success ? parsed.data : invalidIpcResponse();
}

export async function startTranslation(
  request: TranslationRequest,
): Promise<TranslationResult> {
  let value: unknown;
  try {
    value = await invoke<unknown>("start_translation", { request });
  } catch (error: unknown) {
    throw commandError(error);
  }
  const parsed = TranslationResultSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidIpcResponse();
  }
  return parsed.data;
}

export async function cancelTranslation(requestId: string): Promise<void> {
  let value: unknown;
  try {
    value = await invoke<unknown>("cancel_translation", { requestId });
  } catch (error: unknown) {
    throw commandError(error);
  }
  if (!UnitResponseSchema.safeParse(value).success) {
    throw invalidIpcResponse();
  }
}

export async function cacheStats(): Promise<CacheStats> {
  let value: unknown;
  try {
    value = await invoke<unknown>("cache_stats");
  } catch (error: unknown) {
    throw commandError(error);
  }
  const parsed = CacheStatsSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidIpcResponse();
  }
  return parsed.data;
}

export async function clearCache(): Promise<void> {
  let value: unknown;
  try {
    value = await invoke<unknown>("clear_cache");
  } catch (error: unknown) {
    throw commandError(error);
  }
  if (!UnitResponseSchema.safeParse(value).success) {
    throw invalidIpcResponse();
  }
}
