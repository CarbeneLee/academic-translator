import {
  PREFERENCES_STORAGE_KEY,
  loadPreferences,
  saveDefaultProvider,
} from "./preferences";

function installMemoryStorage(): void {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => entries.delete(key),
    setItem: (key, value) => entries.set(key, value),
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

beforeEach(() => {
  installMemoryStorage();
  window.localStorage.clear();
});

test("persists and reloads only the validated default provider", () => {
  saveDefaultProvider("youdao");

  expect(window.localStorage).toHaveLength(1);
  expect(window.localStorage.getItem(PREFERENCES_STORAGE_KEY)).toBe(
    '{"defaultProvider":"youdao"}',
  );
  expect(loadPreferences()).toEqual({ defaultProvider: "youdao" });
});

test.each([
  ["corrupt JSON", "{"],
  ["unknown provider", '{"defaultProvider":"other"}'],
  ["unknown field", '{"defaultProvider":"deepseek","secret":"no"}'],
  ["wrong shape", '"deepseek"'],
])("falls back safely for %s", (_caseName, storedValue) => {
  window.localStorage.setItem(PREFERENCES_STORAGE_KEY, storedValue);

  expect(loadPreferences()).toEqual({ defaultProvider: "deepseek" });
});
