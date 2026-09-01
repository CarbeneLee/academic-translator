import { invoke } from "@tauri-apps/api/core";
import {
  CredentialSummarySchema,
  credentialStatuses,
  deleteCredential,
  saveCredential,
} from "./credentialSchemas";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

beforeEach(() => {
  mockInvoke.mockReset();
});

test("strictly rejects missing, malformed, and extra credential summary fields", () => {
  const valid = {
    kind: "deepseek_api_key",
    configured: true,
    maskedHint: "sk-••••••••A9f2",
  };

  expect(CredentialSummarySchema.parse(valid)).toEqual(valid);
  expect(() =>
    CredentialSummarySchema.parse({ ...valid, plaintext: "must-not-pass" }),
  ).toThrow();
  expect(() =>
    CredentialSummarySchema.parse({ ...valid, kind: "unknown_provider" }),
  ).toThrow();
  expect(() =>
    CredentialSummarySchema.parse({ ...valid, maskedHint: null, configured: true }),
  ).toThrow("INVALID_IPC_RESPONSE");
});

test("validates every status item and rejects an extra-field IPC response", async () => {
  mockInvoke.mockResolvedValue([
    {
      kind: "deepseek_api_key",
      configured: false,
      maskedHint: null,
      secret: "must-not-pass",
    },
  ]);

  await expect(credentialStatuses()).rejects.toThrow("INVALID_IPC_RESPONSE");
});

test("sends plaintext only as the one-way save input and returns a validated summary", async () => {
  mockInvoke.mockResolvedValue({
    kind: "youdao_app_secret",
    configured: true,
    maskedHint: "••••••••91C7",
  });

  const summary = await saveCredential(
    "youdao_app_secret",
    "youdao-example-secret-91C7",
  );

  expect(invoke).toHaveBeenCalledWith("save_credential", {
    kind: "youdao_app_secret",
    value: "youdao-example-secret-91C7",
  });
  expect(summary).toEqual({
    kind: "youdao_app_secret",
    configured: true,
    maskedHint: "••••••••91C7",
  });
  expect(JSON.stringify(summary)).not.toContain("example-secret");
});

test("rejects a mismatched save response and validates delete summaries", async () => {
  mockInvoke.mockResolvedValueOnce({
    kind: "deepseek_api_key",
    configured: true,
    maskedHint: "sk-••••••••A9f2",
  });
  await expect(
    saveCredential("youdao_app_id", "youdao-app-id-72B4"),
  ).rejects.toThrow("INVALID_IPC_RESPONSE");

  mockInvoke.mockResolvedValueOnce({
    kind: "youdao_app_id",
    configured: false,
    maskedHint: null,
  });
  await expect(deleteCredential("youdao_app_id")).resolves.toEqual({
    kind: "youdao_app_id",
    configured: false,
    maskedHint: null,
  });
  expect(invoke).toHaveBeenLastCalledWith("delete_credential", {
    kind: "youdao_app_id",
  });
});
