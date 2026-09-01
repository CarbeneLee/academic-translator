import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ERROR_COPY } from "./errors";
import { TranslationPanel } from "./TranslationPanel";
import type { CommandError, TranslationResult } from "./schemas";
import type { TranslationViewState } from "./useTranslationController";

const result: TranslationResult = {
  requestId: "09053634-6d49-4ad4-8a29-57b95803085e",
  documentSessionId: "2d074a5a-3085-46c7-a0e7-f153472210e0",
  provider: "deepseek",
  modelId: "deepseek-v4-flash",
  normalizedSource: "A normalized academic source.",
  translation: "一段规范的学术译文。",
  cacheHit: false,
  usage: { inputTokens: 12, outputTokens: 9 },
  diagnostics: [],
};

const noAction = () => undefined;

function renderPanel(
  state: TranslationViewState,
  overrides: Partial<React.ComponentProps<typeof TranslationPanel>> = {},
) {
  return render(
    <TranslationPanel
      state={state}
      provider="deepseek"
      onProviderChange={noAction}
      onRetry={noAction}
      onCancel={noAction}
      onOpenSettings={noAction}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

test("idle panel names the current provider and waits for a manual selection action", () => {
  renderPanel({ status: "idle" });

  expect(screen.getByLabelText("当前翻译服务")).toHaveValue("deepseek");
  expect(screen.getByText("选择 PDF 文本后，手动触发翻译。")).toBeVisible();
  expect(screen.queryByRole("button", { name: "取消翻译" })).not.toBeInTheDocument();
});

test("loading panel exposes progress and exactly one explicit cancel action", async () => {
  const onCancel = vi.fn();
  const user = userEvent.setup();
  renderPanel(
    { status: "loading", requestId: result.requestId },
    { onCancel },
  );

  expect(screen.getByRole("status")).toHaveTextContent("正在翻译");
  await user.click(screen.getByRole("button", { name: "取消翻译" }));
  expect(onCancel).toHaveBeenCalledOnce();
});

test("success shows source, translation, safe metadata, copy, and retry", async () => {
  const onRetry = vi.fn();
  const user = userEvent.setup();
  const writeText = vi
    .spyOn(window.navigator.clipboard, "writeText")
    .mockResolvedValue(undefined);
  renderPanel({ status: "success", result }, { onRetry });

  expect(screen.getByText(result.normalizedSource)).toBeVisible();
  expect(screen.getByText(result.translation)).toBeVisible();
  const modelMetadata = screen.getByText(result.modelId).parentElement;
  expect(modelMetadata).toHaveTextContent("DeepSeek V4 Flash");
  await user.click(screen.getByRole("button", { name: "复制译文" }));
  expect(writeText).toHaveBeenCalledOnce();
  expect(writeText).toHaveBeenCalledWith(result.translation);
  expect(writeText).not.toHaveBeenCalledWith(result.normalizedSource);
  await user.click(screen.getByRole("button", { name: "重试" }));
  expect(onRetry).toHaveBeenCalledOnce();
});

test("provider switch emits only the approved provider choice", async () => {
  const onProviderChange = vi.fn();
  const user = userEvent.setup();
  renderPanel({ status: "idle" }, { onProviderChange });

  await user.selectOptions(screen.getByLabelText("当前翻译服务"), "youdao");

  expect(onProviderChange).toHaveBeenCalledOnce();
  expect(onProviderChange).toHaveBeenCalledWith("youdao");
});

test.each(Object.entries(ERROR_COPY))(
  "renders only localized allowlisted copy for %s",
  (code, expectedCopy) => {
    const error: CommandError = {
      code: code as CommandError["code"],
      retryable: [
        "RATE_LIMITED",
        "NETWORK_UNAVAILABLE",
        "REQUEST_TIMEOUT",
        "PROVIDER_UNAVAILABLE",
        "MALFORMED_RESPONSE",
        "CACHE_UNAVAILABLE",
      ].includes(code),
    };
    renderPanel({ status: "error", requestId: result.requestId, error });

    expect(screen.getByRole("alert")).toHaveTextContent(expectedCopy);
  },
);

test.each(["CREDENTIALS_MISSING", "AUTH_INVALID"] as const)(
  "%s offers a settings action without a retry action",
  async (code) => {
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();
    renderPanel(
      {
        status: "error",
        requestId: result.requestId,
        error: { code, retryable: false },
      },
      { onOpenSettings },
    );

    await user.click(screen.getByRole("button", { name: "打开设置" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
  },
);

test("retryable errors expose one manual retry and nonretryable errors do not", async () => {
  const onRetry = vi.fn();
  const user = userEvent.setup();
  const view = renderPanel(
    {
      status: "error",
      requestId: result.requestId,
      error: { code: "REQUEST_TIMEOUT", retryable: true },
    },
    { onRetry },
  );
  await user.click(screen.getByRole("button", { name: "重试" }));
  expect(onRetry).toHaveBeenCalledOnce();

  view.rerender(
    <TranslationPanel
      state={{
        status: "error",
        requestId: result.requestId,
        error: { code: "SELECTION_TOO_LARGE", retryable: false },
      }}
      provider="deepseek"
      onProviderChange={noAction}
      onRetry={onRetry}
      onCancel={noAction}
      onOpenSettings={noAction}
    />,
  );
  expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
});

test("cache diagnostic is a warning and never replaces a successful translation", () => {
  renderPanel({
    status: "success",
    result: { ...result, cacheHit: true, diagnostics: ["cache_unavailable"] },
  });

  expect(screen.getByText(result.translation)).toBeVisible();
  expect(screen.getByRole("status", { name: "缓存状态" })).toHaveTextContent(
    ERROR_COPY.CACHE_UNAVAILABLE,
  );
  expect(screen.getByText("来自本地缓存")).toBeVisible();
});
