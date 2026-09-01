import { act, renderHook, waitFor } from "@testing-library/react";
import type { SelectionFragment } from "../selection/types";
import type { TranslationResult } from "./schemas";
import { useTranslationController } from "./useTranslationController";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

const FIRST_DOCUMENT_ID = "2d074a5a-3085-46c7-a0e7-f153472210e0";
const SECOND_DOCUMENT_ID = "2ae2c436-0ca7-47a9-867a-3ef23d404b16";

type Deferred<T> = {
  promise: Promise<T>;
  reject(reason: unknown): void;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fragment(
  text: string,
  order = 0,
  documentSessionId = FIRST_DOCUMENT_ID,
): SelectionFragment {
  return {
    id: `${documentSessionId}:${order + 1}`,
    documentSessionId,
    order,
    text,
    spans: [
      {
        pageIndex: 0,
        start: { textItemIndex: order, offset: 0 },
        end: { textItemIndex: order, offset: text.length },
        text,
      },
    ],
  };
}

type StartArguments = {
  request: {
    requestId: string;
    documentSessionId: string;
    provider: "deepseek" | "youdao";
    fragments: Array<{ id: string; order: number; text: string }>;
  };
};

function startArguments(callIndex = 0): StartArguments {
  const call = mockInvoke.mock.calls.filter(
    ([command]) => command === "start_translation",
  )[callIndex];
  if (!call) {
    throw new Error(`missing start_translation call ${callIndex}`);
  }
  return call[1] as StartArguments;
}

function translationResult(
  request: StartArguments["request"],
  overrides: Partial<TranslationResult> = {},
): TranslationResult {
  return {
    requestId: request.requestId,
    documentSessionId: request.documentSessionId,
    provider: request.provider,
    modelId:
      request.provider === "deepseek" ? "deepseek-v4-flash" : "youdao-text",
    normalizedSource: request.fragments.map(({ text }) => text).join("\n\n"),
    translation: "严格校验后的译文",
    cacheHit: false,
    usage: { inputTokens: 18, outputTokens: 12 },
    diagnostics: [],
    ...overrides,
  };
}

function renderController(
  initial: {
    documentSessionId: string | null;
    provider: "deepseek" | "youdao";
    fragments: SelectionFragment[];
  } = {
    documentSessionId: FIRST_DOCUMENT_ID,
    provider: "deepseek",
    fragments: [fragment("source")],
  },
) {
  return renderHook(
    (props) =>
      useTranslationController({
        documentSessionId: props.documentSessionId,
        provider: props.provider,
        fragments: props.fragments,
      }),
    { initialProps: initial },
  );
}

beforeEach(() => {
  mockInvoke.mockReset().mockImplementation((command: string) => {
    throw new Error(`unexpected IPC command: ${command}`);
  });
});

test("selection alone never invokes translation and same-turn duplicate trigger is ignored", async () => {
  const response = deferred<unknown>();
  mockInvoke.mockImplementation((command: string) => {
    if (command === "start_translation") {
      return response.promise;
    }
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const controller = renderController();

  expect(mockInvoke).not.toHaveBeenCalled();
  act(() => {
    controller.result.current.trigger();
    controller.result.current.trigger();
  });

  await waitFor(() =>
    expect(
      mockInvoke.mock.calls.filter(([command]) => command === "start_translation"),
    ).toHaveLength(1),
  );
  const request = startArguments().request;
  expect(request.requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(request).toEqual({
    requestId: request.requestId,
    documentSessionId: FIRST_DOCUMENT_ID,
    provider: "deepseek",
    fragments: [
      {
        id: `${FIRST_DOCUMENT_ID}:1`,
        order: 0,
        text: "source",
      },
    ],
  });
  expect(JSON.stringify(request)).not.toMatch(
    /spans|pageIndex|fileName|path|context|history/i,
  );

  await act(async () => {
    response.resolve(translationResult(request));
    await response.promise;
  });
  expect(controller.result.current.state.status).toBe("success");
});

test("strictly rejects extra result fields and never retains the raw payload", async () => {
  mockInvoke.mockImplementation(async (command: string, args: unknown) => {
    if (command !== "start_translation") {
      throw new Error(`unexpected IPC command: ${command}`);
    }
    const request = (args as StartArguments).request;
    return {
      ...translationResult(request),
      providerEnvelope: "must-not-survive",
    };
  });
  const controller = renderController();

  act(() => controller.result.current.trigger());

  await waitFor(() => expect(controller.result.current.state.status).toBe("error"));
  expect(controller.result.current.state).toEqual({
    status: "error",
    requestId: startArguments().request.requestId,
    error: { code: "INVALID_IPC_RESPONSE", retryable: false },
  });
  expect(JSON.stringify(controller.result.current.state)).not.toContain(
    "must-not-survive",
  );
});

test("strictly rejects malformed native errors without exposing their fields", async () => {
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === "start_translation") {
      throw {
        code: "AUTH_INVALID",
        retryable: false,
        authorization: "must-not-survive",
      };
    }
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const controller = renderController();

  act(() => controller.result.current.trigger());

  await waitFor(() => expect(controller.result.current.state.status).toBe("error"));
  expect(controller.result.current.state).toEqual({
    status: "error",
    requestId: startArguments().request.requestId,
    error: { code: "INVALID_IPC_RESPONSE", retryable: false },
  });
  expect(JSON.stringify(controller.result.current.state)).not.toContain(
    "must-not-survive",
  );
});

test("late success cannot overwrite a newer selection result", async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  let startCalls = 0;
  mockInvoke.mockImplementation((command: string) => {
    if (command === "start_translation") {
      startCalls += 1;
      if (startCalls === 1) return first.promise;
      if (startCalls === 2) return second.promise;
      throw new Error("unexpected third start_translation call");
    }
    if (command === "cancel_translation") return Promise.resolve(null);
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const controller = renderController();
  act(() => controller.result.current.trigger());
  await waitFor(() => expect(startCalls).toBe(1));

  controller.rerender({
    documentSessionId: FIRST_DOCUMENT_ID,
    provider: "deepseek",
    fragments: [fragment("second")],
  });
  await waitFor(() => expect(controller.result.current.state.status).toBe("idle"));
  act(() => controller.result.current.trigger());
  await waitFor(() => expect(startCalls).toBe(2));

  await act(async () => {
    second.resolve(
      translationResult(startArguments(1).request, { translation: "第二个结果" }),
    );
    await second.promise;
  });
  expect(controller.result.current.state).toMatchObject({
    status: "success",
    result: { translation: "第二个结果" },
  });

  await act(async () => {
    first.resolve(
      translationResult(startArguments(0).request, { translation: "过期结果" }),
    );
    await first.promise;
  });
  expect(controller.result.current.state).toMatchObject({
    status: "success",
    result: { translation: "第二个结果" },
  });
  expect(
    mockInvoke.mock.calls.filter(([command]) => command === "cancel_translation"),
  ).toHaveLength(1);
});

test("late failure cannot replace the result for the newer selection", async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  let startCalls = 0;
  mockInvoke.mockImplementation((command: string) => {
    if (command === "start_translation") {
      startCalls += 1;
      return startCalls === 1 ? first.promise : second.promise;
    }
    if (command === "cancel_translation") return Promise.resolve(null);
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const controller = renderController();
  act(() => controller.result.current.trigger());
  await waitFor(() => expect(startCalls).toBe(1));
  controller.rerender({
    documentSessionId: FIRST_DOCUMENT_ID,
    provider: "deepseek",
    fragments: [fragment("newer")],
  });
  await waitFor(() => expect(controller.result.current.state.status).toBe("idle"));
  act(() => controller.result.current.trigger());
  await waitFor(() => expect(startCalls).toBe(2));

  await act(async () => {
    second.resolve(
      translationResult(startArguments(1).request, { translation: "新结果" }),
    );
    await second.promise;
  });
  await act(async () => {
    first.reject({ code: "AUTH_INVALID", retryable: false });
    await first.promise.catch(() => undefined);
  });
  expect(controller.result.current.state).toMatchObject({
    status: "success",
    result: { translation: "新结果" },
  });
});

test("provider switch cancels active work, preserves fragments, and never auto-triggers", async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  let startCalls = 0;
  mockInvoke.mockImplementation((command: string) => {
    if (command === "start_translation") {
      startCalls += 1;
      if (startCalls === 1) return first.promise;
      if (startCalls === 2) return second.promise;
      throw new Error("unexpected third start_translation call");
    }
    if (command === "cancel_translation") return Promise.resolve(null);
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const selected = [fragment("keep me")];
  const controller = renderController({
    documentSessionId: FIRST_DOCUMENT_ID,
    provider: "deepseek",
    fragments: selected,
  });
  act(() => controller.result.current.trigger());
  await waitFor(() => expect(startArgumentsSafeCount()).toBe(1));
  controller.rerender({
    documentSessionId: FIRST_DOCUMENT_ID,
    provider: "youdao",
    fragments: selected,
  });

  await waitFor(() => expect(controller.result.current.state.status).toBe("idle"));
  expect(startArgumentsSafeCount()).toBe(1);
  act(() => controller.result.current.trigger());
  await waitFor(() => expect(startArgumentsSafeCount()).toBe(2));
  expect(startArguments(1).request).toMatchObject({
    provider: "youdao",
    fragments: [{ id: selected[0].id, order: 0, text: "keep me" }],
  });

  await act(async () => {
    second.resolve(translationResult(startArguments(1).request));
    await second.promise;
    first.resolve(translationResult(startArguments(0).request));
    await first.promise;
  });
});

function startArgumentsSafeCount(): number {
  return mockInvoke.mock.calls.filter(
    ([command]) => command === "start_translation",
  ).length;
}

test("document replacement cancels the active request and returns to idle", async () => {
  const pending = deferred<unknown>();
  mockInvoke.mockImplementation((command: string) => {
    if (command === "start_translation") return pending.promise;
    if (command === "cancel_translation") return Promise.resolve(null);
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const controller = renderController();
  act(() => controller.result.current.trigger());
  await waitFor(() => expect(startArgumentsSafeCount()).toBe(1));
  const request = startArguments().request;

  controller.rerender({
    documentSessionId: SECOND_DOCUMENT_ID,
    provider: "deepseek",
    fragments: [],
  });

  await waitFor(() => expect(controller.result.current.state).toEqual({ status: "idle" }));
  expect(mockInvoke).toHaveBeenCalledWith("cancel_translation", {
    requestId: request.requestId,
  });
  await act(async () => {
    pending.resolve(translationResult(request));
    await pending.promise;
  });
  expect(controller.result.current.state).toEqual({ status: "idle" });
});

test("explicit cancel invalidates ownership before awaiting native cancellation", async () => {
  const pendingStart = deferred<unknown>();
  const pendingCancel = deferred<unknown>();
  mockInvoke.mockImplementation((command: string) => {
    if (command === "start_translation") return pendingStart.promise;
    if (command === "cancel_translation") return pendingCancel.promise;
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const controller = renderController();
  act(() => controller.result.current.trigger());
  await waitFor(() => expect(startArgumentsSafeCount()).toBe(1));
  const request = startArguments().request;

  act(() => controller.result.current.cancel());
  expect(controller.result.current.state).toEqual({
    status: "error",
    requestId: request.requestId,
    error: { code: "REQUEST_CANCELLED", retryable: false },
  });
  await act(async () => {
    pendingStart.resolve(translationResult(request));
    await pendingStart.promise;
  });
  expect(controller.result.current.state).toMatchObject({
    status: "error",
    error: { code: "REQUEST_CANCELLED" },
  });
  await act(async () => {
    pendingCancel.resolve(null);
    await pendingCancel.promise;
  });
  expect(
    mockInvoke.mock.calls.filter(([command]) => command === "cancel_translation"),
  ).toHaveLength(1);
});

test("retry reuses the exact explicit snapshot and creates a fresh UUID", async () => {
  let startCalls = 0;
  mockInvoke.mockImplementation(async (command: string, args: unknown) => {
    if (command !== "start_translation") {
      throw new Error(`unexpected IPC command: ${command}`);
    }
    startCalls += 1;
    if (startCalls === 1) {
      throw { code: "NETWORK_UNAVAILABLE", retryable: true };
    }
    return translationResult((args as StartArguments).request);
  });
  const selected = [fragment("alpha"), fragment("beta", 1)];
  const controller = renderController({
    documentSessionId: FIRST_DOCUMENT_ID,
    provider: "deepseek",
    fragments: selected,
  });
  act(() => controller.result.current.trigger());
  await waitFor(() => expect(controller.result.current.state.status).toBe("error"));

  act(() => controller.result.current.retry());
  await waitFor(() => expect(controller.result.current.state.status).toBe("success"));

  const firstRequest = startArguments(0).request;
  const secondRequest = startArguments(1).request;
  expect(secondRequest.requestId).not.toBe(firstRequest.requestId);
  expect(secondRequest.fragments).toEqual(firstRequest.fragments);
  expect(startCalls).toBe(2);
});

test("accepts a cache hit with a nonfatal cache diagnostic", async () => {
  mockInvoke.mockImplementation(async (command: string, args: unknown) => {
    if (command !== "start_translation") {
      throw new Error(`unexpected IPC command: ${command}`);
    }
    return translationResult((args as StartArguments).request, {
      cacheHit: true,
      diagnostics: ["cache_unavailable"],
    });
  });
  const controller = renderController();

  act(() => controller.result.current.trigger());

  await waitFor(() => expect(controller.result.current.state.status).toBe("success"));
  expect(controller.result.current.state).toMatchObject({
    result: { cacheHit: true, diagnostics: ["cache_unavailable"] },
  });
});

test("selection mutation clears a completed result before the next manual trigger", async () => {
  mockInvoke.mockImplementation(async (command: string, args: unknown) => {
    if (command !== "start_translation") {
      throw new Error(`unexpected IPC command: ${command}`);
    }
    return translationResult((args as StartArguments).request);
  });
  const controller = renderController();
  act(() => controller.result.current.trigger());
  await waitFor(() => expect(controller.result.current.state.status).toBe("success"));

  controller.rerender({
    documentSessionId: FIRST_DOCUMENT_ID,
    provider: "deepseek",
    fragments: [fragment("new selection")],
  });

  await waitFor(() => expect(controller.result.current.state).toEqual({ status: "idle" }));
  expect(startArgumentsSafeCount()).toBe(1);
});

test("mismatched response identity becomes a safe local IPC error", async () => {
  mockInvoke.mockImplementation(async (command: string, args: unknown) => {
    if (command !== "start_translation") {
      throw new Error(`unexpected IPC command: ${command}`);
    }
    return translationResult((args as StartArguments).request, {
      requestId: "f7c2514e-3cac-4dd8-b970-b9330acbd43f",
    });
  });
  const controller = renderController();

  act(() => controller.result.current.trigger());

  await waitFor(() => expect(controller.result.current.state.status).toBe("error"));
  expect(controller.result.current.state).toMatchObject({
    error: { code: "INVALID_IPC_RESPONSE", retryable: false },
  });
});

test("unmount cancels exactly one active request and ignores its late result", async () => {
  const pending = deferred<unknown>();
  mockInvoke.mockImplementation((command: string) => {
    if (command === "start_translation") return pending.promise;
    if (command === "cancel_translation") return Promise.resolve(null);
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const controller = renderController();
  act(() => controller.result.current.trigger());
  await waitFor(() => expect(startArgumentsSafeCount()).toBe(1));
  const request = startArguments().request;

  controller.unmount();

  expect(mockInvoke).toHaveBeenCalledWith("cancel_translation", {
    requestId: request.requestId,
  });
  expect(
    mockInvoke.mock.calls.filter(([command]) => command === "cancel_translation"),
  ).toHaveLength(1);
  await act(async () => {
    pending.resolve(translationResult(request));
    await pending.promise;
  });
});
