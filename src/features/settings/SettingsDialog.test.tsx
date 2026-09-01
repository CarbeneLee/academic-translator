import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { CredentialSummary } from "./credentialSchemas";
import { PREFERENCES_STORAGE_KEY } from "./preferences";
import { SettingsDialog } from "./SettingsDialog";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

const emptyStatuses: CredentialSummary[] = [
  { kind: "deepseek_api_key", configured: false, maskedHint: null },
  { kind: "youdao_app_id", configured: false, maskedHint: null },
  { kind: "youdao_app_secret", configured: false, maskedHint: null },
];

const configuredDeepseekStatuses: CredentialSummary[] = [
  {
    kind: "deepseek_api_key",
    configured: true,
    maskedHint: "sk-••••••••A9f2",
  },
  { kind: "youdao_app_id", configured: false, maskedHint: null },
  { kind: "youdao_app_secret", configured: false, maskedHint: null },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function DialogHarness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        reopen
      </button>
      <SettingsDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

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
  mockInvoke.mockReset();
  installMemoryStorage();
  window.localStorage.clear();
});

function expectStatusesThen(
  handler: (command: string, argumentsValue: unknown) => unknown,
) {
  mockInvoke.mockImplementation(
    async (command: string, argumentsValue: unknown) => {
      if (command === "credential_statuses") {
        return emptyStatuses;
      }
      return handler(command, argumentsValue);
    },
  );
}

test(
  "keeps a same-kind save pending across close and reopen without starting a newer native write",
  async () => {
    const firstSave = deferred<CredentialSummary>();
    let deepseekWrites = 0;
    mockInvoke.mockImplementation(
      async (command: string, argumentsValue: unknown) => {
        if (command === "credential_statuses") {
          return emptyStatuses;
        }
        if (command === "save_credential") {
          const argumentsRecord = argumentsValue as Record<string, unknown>;
          if (argumentsRecord.kind !== "deepseek_api_key") {
            throw new Error(
              `unexpected credential kind: ${String(argumentsRecord.kind)}`,
            );
          }
          deepseekWrites += 1;
          if (deepseekWrites === 1) {
            return firstSave.promise;
          }
          return {
            kind: "deepseek_api_key",
            configured: true,
            maskedHint: "sk-••••••••B2c3",
          };
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
    render(<DialogHarness />);

    fireEvent.change(await screen.findByLabelText("DeepSeek API Key"), {
      target: { value: "sk-first-secret-A9f2" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "保存 DeepSeek Key" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
    fireEvent.click(screen.getByRole("button", { name: "reopen" }));

    const reopenedInput = await screen.findByLabelText("DeepSeek API Key");
    fireEvent.change(reopenedInput, {
      target: { value: "sk-newer-secret-B2c3" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "保存 DeepSeek Key" }),
    );
    expect(deepseekWrites).toBe(1);
    expect(reopenedInput).toBeDisabled();

    await act(async () => {
      firstSave.resolve({
        kind: "deepseek_api_key",
        configured: true,
        maskedHint: "sk-••••••••A9f2",
      });
    });
    expect(await screen.findByText("sk-••••••••A9f2")).toBeVisible();
    expect(screen.queryByText("sk-••••••••B2c3")).not.toBeInTheDocument();
    expect(reopenedInput).toHaveValue("");
    expect(reopenedInput).toBeEnabled();
  },
  10_000,
);

test("tracks alternating-provider operations independently without losing the first pending guard", async () => {
  const deepseekSave = deferred<CredentialSummary>();
  const youdaoSave = deferred<CredentialSummary>();
  let deepseekWrites = 0;
  mockInvoke.mockImplementation(
    async (command: string, argumentsValue: unknown) => {
      if (command === "credential_statuses") {
        return emptyStatuses;
      }
      if (command === "save_credential") {
        const argumentsRecord = argumentsValue as Record<string, unknown>;
        if (argumentsRecord.kind === "deepseek_api_key") {
          deepseekWrites += 1;
          return deepseekWrites === 1
            ? deepseekSave.promise
            : {
                kind: "deepseek_api_key",
                configured: true,
                maskedHint: "sk-••••••••B2c3",
              };
        }
        if (argumentsRecord.kind === "youdao_app_secret") {
          return youdaoSave.promise;
        }
      }
      throw new Error(`unexpected command: ${command}`);
    },
  );
  const user = userEvent.setup();
  render(<SettingsDialog open onClose={() => undefined} />);

  const deepseekInput = await screen.findByLabelText("DeepSeek API Key");
  const youdaoInput = screen.getByLabelText("Youdao App Secret");
  await user.type(deepseekInput, "sk-first-secret-A9f2");
  await user.type(youdaoInput, "youdao-secret-91C7");
  await user.click(screen.getByRole("button", { name: "保存 DeepSeek Key" }));
  await user.click(
    screen.getByRole("button", { name: "保存 Youdao App Secret" }),
  );

  await act(async () => {
    youdaoSave.resolve({
      kind: "youdao_app_secret",
      configured: true,
      maskedHint: "••••••••91C7",
    });
  });
  expect(await screen.findByText("••••••••91C7")).toBeVisible();

  const deepseekSaveButton = screen.getByRole("button", {
    name: "保存 DeepSeek Key",
  });
  expect(deepseekInput).toBeDisabled();
  expect(deepseekSaveButton).toBeDisabled();
  await user.click(deepseekSaveButton);
  expect(deepseekWrites).toBe(1);

  await act(async () => {
    deepseekSave.resolve({
      kind: "deepseek_api_key",
      configured: true,
      maskedHint: "sk-••••••••A9f2",
    });
  });
  expect(await screen.findByText("sk-••••••••A9f2")).toBeVisible();
  expect(deepseekInput).toBeEnabled();
});

test("does not let a stale status response overwrite a newer save summary", async () => {
  const staleStatuses = deferred<CredentialSummary[]>();
  mockInvoke.mockImplementation(
    async (command: string, argumentsValue: unknown) => {
      if (command === "credential_statuses") {
        return staleStatuses.promise;
      }
      if (command === "save_credential") {
        const argumentsRecord = argumentsValue as Record<string, unknown>;
        if (argumentsRecord.kind === "deepseek_api_key") {
          return {
            kind: "deepseek_api_key",
            configured: true,
            maskedHint: "sk-••••••••A9f2",
          };
        }
      }
      throw new Error(`unexpected command: ${command}`);
    },
  );
  const user = userEvent.setup();
  render(<SettingsDialog open onClose={() => undefined} />);

  await user.type(
    screen.getByLabelText("DeepSeek API Key"),
    "sk-first-secret-A9f2",
  );
  await user.click(screen.getByRole("button", { name: "保存 DeepSeek Key" }));
  expect(await screen.findByText("sk-••••••••A9f2")).toBeVisible();

  await act(async () => {
    staleStatuses.resolve(emptyStatuses);
  });
  expect(screen.getByText("sk-••••••••A9f2")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "替换 DeepSeek Key" }),
  ).toBeVisible();
});

test("does not show a stale status error after a newer save succeeds", async () => {
  const staleStatuses = deferred<CredentialSummary[]>();
  mockInvoke.mockImplementation(
    async (command: string, argumentsValue: unknown) => {
      if (command === "credential_statuses") {
        return staleStatuses.promise;
      }
      if (
        command === "save_credential" &&
        JSON.stringify(argumentsValue) ===
          JSON.stringify({
            kind: "deepseek_api_key",
            value: "sk-first-secret-A9f2",
          })
      ) {
        return {
          kind: "deepseek_api_key",
          configured: true,
          maskedHint: "sk-••••••••A9f2",
        };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  );
  render(<SettingsDialog open onClose={() => undefined} />);

  fireEvent.change(screen.getByLabelText("DeepSeek API Key"), {
    target: { value: "sk-first-secret-A9f2" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "保存 DeepSeek Key" }),
  );
  expect(await screen.findByText("sk-••••••••A9f2")).toBeVisible();

  await act(async () => {
    staleStatuses.reject(new Error("stale status failure"));
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText("sk-••••••••A9f2")).toBeVisible();
});

test("does not let a stale status response overwrite a newer delete summary", async () => {
  const staleStatuses = deferred<CredentialSummary[]>();
  let statusCalls = 0;
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === "credential_statuses") {
      statusCalls += 1;
      return statusCalls === 1
        ? configuredDeepseekStatuses
        : staleStatuses.promise;
    }
    if (command === "delete_credential") {
      return {
        kind: "deepseek_api_key",
        configured: false,
        maskedHint: null,
      };
    }
    throw new Error(`unexpected command: ${command}`);
  });
  const user = userEvent.setup();
  render(<DialogHarness />);

  expect(await screen.findByText("sk-••••••••A9f2")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "关闭设置" }));
  await user.click(screen.getByRole("button", { name: "reopen" }));
  await waitFor(() => expect(statusCalls).toBe(2));
  await user.click(
    screen.getByRole("button", { name: "删除 DeepSeek Key" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "删除 DeepSeek Key" }),
    ).not.toBeInTheDocument(),
  );

  await act(async () => {
    staleStatuses.resolve(configuredDeepseekStatuses);
  });
  expect(
    screen.queryByRole("button", { name: "删除 DeepSeek Key" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("sk-••••••••A9f2")).not.toBeInTheDocument();
});

test("does not show a stale status error after a newer delete succeeds", async () => {
  const staleStatuses = deferred<CredentialSummary[]>();
  let statusCalls = 0;
  mockInvoke.mockImplementation(
    async (command: string, argumentsValue: unknown) => {
      if (command === "credential_statuses") {
        statusCalls += 1;
        if (statusCalls === 1) {
          return configuredDeepseekStatuses;
        }
        if (statusCalls === 2) {
          return staleStatuses.promise;
        }
        throw new Error("unexpected credential_statuses call");
      }
      if (
        command === "delete_credential" &&
        JSON.stringify(argumentsValue) ===
          JSON.stringify({ kind: "deepseek_api_key" })
      ) {
        return {
          kind: "deepseek_api_key",
          configured: false,
          maskedHint: null,
        };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  );
  render(<DialogHarness />);

  expect(await screen.findByText("sk-••••••••A9f2")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
  fireEvent.click(screen.getByRole("button", { name: "reopen" }));
  await waitFor(() => expect(statusCalls).toBe(2));
  fireEvent.click(
    screen.getByRole("button", { name: "删除 DeepSeek Key" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "删除 DeepSeek Key" }),
    ).not.toBeInTheDocument(),
  );

  await act(async () => {
    staleStatuses.reject(new Error("stale status failure"));
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "删除 DeepSeek Key" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("sk-••••••••A9f2")).not.toBeInTheDocument();
});

test("blocks edits while a same-kind save is pending so newer input cannot be silently cleared", async () => {
  const saveResult = deferred<CredentialSummary>();
  expectStatusesThen((command) => {
    if (command === "save_credential") {
      return saveResult.promise;
    }
    throw new Error(`unexpected command: ${command}`);
  });
  const user = userEvent.setup();
  render(<SettingsDialog open onClose={() => undefined} />);

  const input = await screen.findByLabelText("DeepSeek API Key");
  await user.type(input, "sk-first-secret-A9f2");
  await user.click(screen.getByRole("button", { name: "保存 DeepSeek Key" }));
  await user.type(input, "-newer-input");

  expect(input).toBeDisabled();
  expect(input).toHaveValue("sk-first-secret-A9f2");
  await act(async () => {
    saveResult.resolve({
      kind: "deepseek_api_key",
      configured: true,
      maskedHint: "sk-••••••••A9f2",
    });
  });
  expect(await screen.findByText("sk-••••••••A9f2")).toBeVisible();
  expect(input).toHaveValue("");
  expect(input).toBeEnabled();
});

test("clears the DeepSeek secret input after save and never renders the full credential", async () => {
  expectStatusesThen((command, argumentsValue) => {
    if (
      command === "save_credential" &&
      JSON.stringify(argumentsValue) ===
        JSON.stringify({
          kind: "deepseek_api_key",
          value: "sk-example-secret-A9f2",
        })
    ) {
      return {
        kind: "deepseek_api_key",
        configured: true,
        maskedHint: "sk-••••••••A9f2",
      };
    }
    throw new Error(`unexpected command: ${command}`);
  });
  const user = userEvent.setup();
  render(<SettingsDialog open onClose={() => undefined} />);

  const input = await screen.findByLabelText("DeepSeek API Key");
  await user.type(input, "sk-example-secret-A9f2");
  await user.click(screen.getByRole("button", { name: "保存 DeepSeek Key" }));

  expect(input).toHaveValue("");
  expect(screen.getByText("sk-••••••••A9f2")).toBeVisible();
  expect(screen.queryByText("sk-example-secret-A9f2")).not.toBeInTheDocument();
});

test("saves, replaces, and deletes Youdao App ID and App Secret independently", async () => {
  let step = 0;
  expectStatusesThen((command, argumentsValue) => {
    const expected = [
      {
        command: "save_credential",
        argumentsValue: {
          kind: "youdao_app_id",
          value: "youdao-app-id-72B4",
        },
        result: {
          kind: "youdao_app_id",
          configured: true,
          maskedHint: "••••••••72B4",
        },
      },
      {
        command: "save_credential",
        argumentsValue: {
          kind: "youdao_app_secret",
          value: "youdao-secret-91C7",
        },
        result: {
          kind: "youdao_app_secret",
          configured: true,
          maskedHint: "••••••••91C7",
        },
      },
      {
        command: "save_credential",
        argumentsValue: {
          kind: "youdao_app_id",
          value: "youdao-replacement-55D8",
        },
        result: {
          kind: "youdao_app_id",
          configured: true,
          maskedHint: "••••••••55D8",
        },
      },
      {
        command: "delete_credential",
        argumentsValue: { kind: "youdao_app_secret" },
        result: {
          kind: "youdao_app_secret",
          configured: false,
          maskedHint: null,
        },
      },
    ];
    const current = expected[step];
    if (
      current &&
      command === current.command &&
      JSON.stringify(argumentsValue) === JSON.stringify(current.argumentsValue)
    ) {
      step += 1;
      return current.result;
    }
    throw new Error(`unexpected command at step ${step}: ${command}`);
  });
  const user = userEvent.setup();
  render(<SettingsDialog open onClose={() => undefined} />);

  const appIdInput = await screen.findByLabelText("Youdao App ID");
  const appSecretInput = screen.getByLabelText("Youdao App Secret");
  await user.type(appIdInput, "youdao-app-id-72B4");
  await user.click(screen.getByRole("button", { name: "保存 Youdao App ID" }));
  await user.type(appSecretInput, "youdao-secret-91C7");
  await user.click(
    screen.getByRole("button", { name: "保存 Youdao App Secret" }),
  );
  await user.type(appIdInput, "youdao-replacement-55D8");
  await user.click(screen.getByRole("button", { name: "替换 Youdao App ID" }));

  expect(screen.getByText("••••••••55D8")).toBeVisible();
  expect(screen.getByText("••••••••91C7")).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "删除 Youdao App Secret" }),
  );
  expect(
    screen.queryByRole("button", { name: "删除 Youdao App Secret" }),
  ).not.toBeInTheDocument();
  expect(step).toBe(4);
});

test("preserves the input after a real save failure for correction", async () => {
  expectStatusesThen((command) => {
    if (command === "save_credential") {
      throw new Error("CREDENTIAL_STORE_UNAVAILABLE");
    }
    throw new Error(`unexpected command: ${command}`);
  });
  const user = userEvent.setup();
  render(<SettingsDialog open onClose={() => undefined} />);

  const input = await screen.findByLabelText("DeepSeek API Key");
  await user.type(input, "sk-correction-needed-A9f2");
  await user.click(screen.getByRole("button", { name: "保存 DeepSeek Key" }));

  expect(input).toHaveValue("sk-correction-needed-A9f2");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "保存失败，请检查后重试。",
  );
  expect(screen.queryByText("sk-correction-needed-A9f2")).not.toBeInTheDocument();
});

test("clears plaintext state when closing and after unmounting", async () => {
  mockInvoke.mockResolvedValue(emptyStatuses);
  const user = userEvent.setup();

  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          reopen
        </button>
        <SettingsDialog open={open} onClose={() => setOpen(false)} />
      </>
    );
  }

  const view = render(<Harness />);
  await user.type(
    await screen.findByLabelText("DeepSeek API Key"),
    "sk-close-me-A9f2",
  );
  await user.click(screen.getByRole("button", { name: "关闭设置" }));
  await user.click(screen.getByRole("button", { name: "reopen" }));
  expect(await screen.findByLabelText("DeepSeek API Key")).toHaveValue("");

  await user.type(
    screen.getByLabelText("Youdao App Secret"),
    "youdao-unmount-91C7",
  );
  view.unmount();
  expect(screen.queryByDisplayValue("youdao-unmount-91C7")).not.toBeInTheDocument();
});

test("uses protected inputs with no reveal control and persists the provider preference", async () => {
  mockInvoke.mockResolvedValue(emptyStatuses);
  const user = userEvent.setup();
  render(<SettingsDialog open onClose={() => undefined} />);

  for (const label of [
    "DeepSeek API Key",
    "Youdao App ID",
    "Youdao App Secret",
  ]) {
    const input = await screen.findByLabelText(label);
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
  }
  expect(
    screen.queryByRole("button", { name: /显示|查看|Reveal/i }),
  ).not.toBeInTheDocument();

  await user.selectOptions(screen.getByLabelText("默认翻译服务"), "youdao");
  expect(window.localStorage.getItem(PREFERENCES_STORAGE_KEY)).toBe(
    '{"defaultProvider":"youdao"}',
  );
});

test("rejects malformed status IPC data without rendering it", async () => {
  mockInvoke.mockResolvedValue([
    {
      kind: "deepseek_api_key",
      configured: true,
      maskedHint: "sk-••••••••A9f2",
      plaintext: "must-not-render",
    },
  ]);
  render(<SettingsDialog open onClose={() => undefined} />);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "无法读取凭据状态。",
  );
  expect(screen.queryByText("must-not-render")).not.toBeInTheDocument();
  await waitFor(() => expect(mockInvoke).toHaveBeenCalledOnce());
});
