import { z } from "zod";

export const PREFERENCES_STORAGE_KEY = "academic-translator.preferences.v1";

export const ProviderIdSchema = z.enum(["deepseek", "youdao"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

const PreferencesSchema = z
  .object({
    defaultProvider: ProviderIdSchema,
  })
  .strict();

export type Preferences = z.infer<typeof PreferencesSchema>;

const DEFAULT_PREFERENCES: Preferences = { defaultProvider: "deepseek" };

export function loadPreferences(
  storage: Storage = window.localStorage,
): Preferences {
  try {
    const stored = storage.getItem(PREFERENCES_STORAGE_KEY);
    if (stored === null) {
      return DEFAULT_PREFERENCES;
    }
    const result = PreferencesSchema.safeParse(JSON.parse(stored));
    return result.success ? result.data : DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function saveDefaultProvider(
  provider: ProviderId,
  storage: Storage = window.localStorage,
): void {
  const preferences = PreferencesSchema.parse({ defaultProvider: provider });
  storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
}
