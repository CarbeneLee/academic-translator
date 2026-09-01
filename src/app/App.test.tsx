import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { ERROR_COPY } from "../features/translation/errors";
import type {
  CommandError,
  TranslationResult,
} from "../features/translation/schemas";
import { App } from "./App";

const { mockInvoke, mockLoadPdfDocument } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockLoadPdfDocument: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../features/pdf-viewer/pdfDocument", () => ({
  loadPdfDocument: mockLoadPdfDocument,
}));
vi.mock("../features/pdf-viewer/PdfPage", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    PdfPage: ({
      pageIndex,
      documentSessionId,
      onTextLayerRendered,
    }: {
      pageIndex: number;
      documentSessionId: string;
      onTextLayerRendered(
        pageIndex: number,
        textLayer: HTMLElement | null,
      ): void;
    }) => {
      const layerRef = useRef<HTMLDivElement>(null);
      useEffect(() => {
        onTextLayerRendered(pageIndex, layerRef.current);
        return () => onTextLayerRendered(pageIndex, null);
      }, [documentSessionId, onTextLayerRendered, pageIndex]);
      return (
        <div
          ref={layerRef}
          className="pdfTextLayer"
          data-page-index={pageIndex}
          data-document-session-id={documentSessionId}
        >
          <span data-page-index={pageIndex} data-text-item-index="0">
            alpha
          </span>
          <span data-page-index={pageIndex} data-text-item-index="1">
            beta
          </span>
        </div>
      );
    },
  };
});

const FIRST_DOCUMENT = {
  documentSessionId: "2d074a5a-3085-46c7-a0e7-f153472210e0",
  fileName: "paper-one.pdf",
  byteLen: 4,
};
const SECOND_DOCUMENT = {
  documentSessionId: "2ae2c436-0ca7-47a9-867a-3ef23d404b16",
  fileName: "paper-two.pdf",
  byteLen: 4,
};
const EMPTY_STATUSES = [
  { kind: "deepseek_api_key", configured: false, maskedHint: null },
  { kind: "youdao_app_id", configured: false, maskedHint: null },
  { kind: "youdao_app_secret", configured: false, maskedHint: null },
];

type Deferred<T> = {
  promise: Promise<T>;
  reject(reason: unknown): void;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => entries.delete(key),
    setItem: (key, value) => entries.set(key, value),
  };
}

function pdfHandle() {
  const page = {
    getViewport: vi.fn(() => ({ width: 612, height: 792 })),
  } as unknown as PDFPageProxy;
  const document = {
    numPages: 1,
    getPage: vi.fn().mockResolvedValue(page),
  } as unknown as PDFDocumentProxy;
  return {
    document,
    destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
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

function resultFor(
  args: StartArguments,
  translation = "集成测试译文",
  overrides: Partial<TranslationResult> = {},
): TranslationResult {
  return {
    requestId: args.request.requestId,
    documentSessionId: args.request.documentSessionId,
    provider: args.request.provider,
    modelId:
      args.request.provider === "deepseek"
        ? "deepseek-v4-flash"
        : "youdao-text",
    normalizedSource: args.request.fragments.map(({ text }) => text).join("\n\n"),
    translation,
    cacheHit: false,
    usage: { inputTokens: 4, outputTokens: 3 },
    diagnostics: [],
    ...overrides,
  };
}

function selectText(text: string): void {
  const textNode = screen.getByText(text).firstChild;
  if (!(textNode instanceof Text)) {
    throw new Error("expected PDF text node");
  }
  const range = document.createRange();
  range.selectNodeContents(textNode);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("selection unavailable");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  const root = document.querySelector<HTMLElement>(".pdfPagesViewport");
  if (!root) {
    throw new Error("expected PDF viewport");
  }
  fireEvent.mouseUp(root);
}

async function openFirstPdf(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "打开 PDF" }));
  expect(await screen.findByText("alpha")).toBeVisible();
}

type ReplacementBoundary = "read" | "load" | "page enumeration" | "failure";

async function runAcceptedReplacementBoundary(
  boundaryName: ReplacementBoundary,
) {
  const boundary = deferred<unknown>();
  const staleTranslation = deferred<unknown>();
  const firstHandle = pdfHandle();
  const replacementPage = {
    getViewport: vi.fn(() => ({ width: 612, height: 792 })),
  } as unknown as PDFPageProxy;
  const replacementGetPage = vi
    .fn<(pageNumber: number) => Promise<PDFPageProxy>>()
    .mockImplementation((pageNumber) => {
      if (pageNumber !== 1) {
        throw new Error(`unexpected replacement page ${pageNumber}`);
      }
      if (boundaryName === "page enumeration") {
        return boundary.promise as Promise<PDFPageProxy>;
      }
      return Promise.resolve(replacementPage);
    });
  const replacementDestroy = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const replacementHandle = {
    document: {
      numPages: 1,
      getPage: replacementGetPage,
    } as unknown as PDFDocumentProxy,
    destroy: replacementDestroy,
  };
  const starts: StartArguments[] = [];
  const cancelled: string[] = [];
  const closeCounts = new Map<string, number>();
  let openCalls = 0;
  let readCalls = 0;
  let loadCalls = 0;

  mockLoadPdfDocument.mockImplementation(() => {
    loadCalls += 1;
    if (loadCalls === 1) return Promise.resolve(firstHandle);
    if (loadCalls !== 2) {
      throw new Error(`unexpected PDF.js load ${loadCalls}`);
    }
    if (boundaryName === "load") {
      return boundary.promise as Promise<typeof replacementHandle>;
    }
    return Promise.resolve(replacementHandle);
  });
  mockInvoke.mockImplementation((command: string, args: unknown) => {
    if (command === "open_pdf_document") {
      openCalls += 1;
      if (openCalls === 1) return Promise.resolve(FIRST_DOCUMENT);
      if (openCalls === 2) return Promise.resolve(SECOND_DOCUMENT);
      throw new Error(`unexpected picker call ${openCalls}`);
    }
    if (command === "read_pdf_bytes") {
      readCalls += 1;
      const sessionId = (args as { documentSessionId: string })
        .documentSessionId;
      if (readCalls === 1 && sessionId === FIRST_DOCUMENT.documentSessionId) {
        return Promise.resolve(new ArrayBuffer(4));
      }
      if (
        readCalls === 2 &&
        sessionId === SECOND_DOCUMENT.documentSessionId
      ) {
        if (boundaryName === "read" || boundaryName === "failure") {
          return boundary.promise;
        }
        return Promise.resolve(new ArrayBuffer(4));
      }
      throw new Error(`unexpected read for ${sessionId}`);
    }
    if (command === "close_pdf_document") {
      const sessionId = (args as { documentSessionId: string })
        .documentSessionId;
      if (
        sessionId !== FIRST_DOCUMENT.documentSessionId &&
        sessionId !== SECOND_DOCUMENT.documentSessionId
      ) {
        throw new Error(`unexpected close for ${sessionId}`);
      }
      const nextCount = (closeCounts.get(sessionId) ?? 0) + 1;
      if (nextCount > 1) {
        throw new Error(`duplicate close for ${sessionId}`);
      }
      closeCounts.set(sessionId, nextCount);
      return Promise.resolve(null);
    }
    if (command === "start_translation") {
      if (starts.length > 0) {
        throw new Error("unexpected additional start_translation");
      }
      starts.push(args as StartArguments);
      return staleTranslation.promise;
    }
    if (command === "cancel_translation") {
      const requestId = (args as { requestId: string }).requestId;
      if (cancelled.length > 0 || requestId !== starts[0]?.request.requestId) {
        throw new Error(`unexpected cancellation for ${requestId}`);
      }
      cancelled.push(requestId);
      return Promise.resolve(null);
    }
    throw new Error(`unexpected IPC command: ${command}`);
  });

  const user = userEvent.setup();
  const view = render(<App />);
  let unmounted = false;
  const settleBoundary = () => {
    if (boundaryName === "failure") {
      boundary.reject(new Error("replacement read failed"));
    } else if (boundaryName === "read") {
      boundary.resolve(new ArrayBuffer(4));
    } else if (boundaryName === "load") {
      boundary.resolve(replacementHandle);
    } else {
      boundary.resolve(replacementPage);
    }
  };

  try {
    await openFirstPdf(user);
    selectText("alpha");
    await user.click(screen.getByRole("button", { name: "翻译所选文本" }));
    await waitFor(() => expect(starts).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "打开 PDF" }));
    if (boundaryName === "read" || boundaryName === "failure") {
      await waitFor(() => expect(readCalls).toBe(2));
    } else if (boundaryName === "load") {
      await waitFor(() => expect(loadCalls).toBe(2));
    } else {
      await waitFor(() => expect(replacementGetPage).toHaveBeenCalledOnce());
    }

    expect(cancelled).toEqual([starts[0].request.requestId]);
    expect(closeCounts.get(FIRST_DOCUMENT.documentSessionId)).toBe(1);
    expect(closeCounts.get(SECOND_DOCUMENT.documentSessionId) ?? 0).toBe(0);
    expect(firstHandle.destroy).toHaveBeenCalledOnce();
    expect(replacementDestroy).not.toHaveBeenCalled();
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "翻译所选文本" }),
    ).not.toBeInTheDocument();
    expect(document.querySelector(".pdfWorkspaceSelectionShell")).toBeNull();
    expect(document.querySelector(".selectionHighlight")).toBeNull();
    expect(screen.getByText("打开本地 PDF 开始阅读")).toBeVisible();
    expect(screen.getByText("选择 PDF 文本后，手动触发翻译。")).toBeVisible();

    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(starts).toHaveLength(1);

    await act(async () => {
      staleTranslation.resolve(resultFor(starts[0], "过期替换结果"));
      await staleTranslation.promise;
    });
    expect(screen.queryByText("过期替换结果")).not.toBeInTheDocument();

    if (boundaryName === "failure") {
      settleBoundary();
      await act(async () => {
        await boundary.promise.catch(() => undefined);
      });
      expect(
        await screen.findByRole("status", { name: "阅读状态" }),
      ).toHaveTextContent("无法打开 PDF，请重试。");
      expect(screen.queryByText("alpha")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "翻译所选文本" }),
      ).not.toBeInTheDocument();
    } else {
      view.unmount();
      unmounted = true;
      settleBoundary();
      await act(async () => {
        await boundary.promise;
      });
    }

    await waitFor(() =>
      expect(closeCounts.get(SECOND_DOCUMENT.documentSessionId)).toBe(1),
    );
    expect(firstHandle.destroy).toHaveBeenCalledOnce();
    expect(replacementDestroy).toHaveBeenCalledTimes(
      boundaryName === "load" || boundaryName === "page enumeration" ? 1 : 0,
    );
  } finally {
    if (!unmounted) {
      view.unmount();
    }
    staleTranslation.resolve(
      starts[0]
        ? resultFor(starts[0], "清理阶段的过期结果")
        : (undefined as unknown),
    );
    settleBoundary();
    await Promise.allSettled([staleTranslation.promise, boundary.promise]);
    await waitFor(() =>
      expect(closeCounts.get(SECOND_DOCUMENT.documentSessionId)).toBe(1),
    );
  }
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  Element.prototype.scrollIntoView = vi.fn();
  mockInvoke.mockReset().mockImplementation((command: string) => {
    if (command === "credential_statuses") return Promise.resolve(EMPTY_STATUSES);
    if (command === "cache_stats") {
      return Promise.resolve({ rowCount: 0, databaseBytes: 0 });
    }
    throw new Error(`unexpected IPC command: ${command}`);
  });
  mockLoadPdfDocument.mockReset().mockResolvedValue(pdfHandle());
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

test("renders the approved shell regions and functional PDF controls", async () => {
  const user = userEvent.setup();
  render(<App />);

  expect(screen.getByRole("toolbar", { name: "论文阅读工具" })).toBeVisible();
  expect(screen.getByLabelText("PDF 工具栏")).toBeVisible();
  expect(screen.getByRole("main", { name: "PDF 阅读区" })).toBeVisible();
  expect(screen.getByRole("complementary", { name: "翻译面板" })).toBeVisible();
  expect(screen.getByRole("status", { name: "阅读状态" })).toBeVisible();
  expect(screen.getByRole("button", { name: "收起翻译面板" })).toBeVisible();
  expect(screen.getByRole("button", { name: "打开 PDF" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "设置" }));
  expect(screen.getByRole("dialog", { name: "设置" })).toBeVisible();
  expect(screen.queryByText(/聊天|笔记|OCR/)).not.toBeInTheDocument();
});

test("selection stays local until floating action, then success supports cache warning and safe copy", async () => {
  const starts: StartArguments[] = [];
  mockInvoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === "open_pdf_document") return FIRST_DOCUMENT;
    if (command === "read_pdf_bytes") return new ArrayBuffer(4);
    if (command === "close_pdf_document") return null;
    if (command === "start_translation") {
      if (starts.length > 0) throw new Error("unexpected duplicate start_translation");
      const startArgs = args as StartArguments;
      starts.push(startArgs);
      return resultFor(startArgs, "集成测试译文", {
        cacheHit: true,
        diagnostics: ["cache_unavailable"],
      });
    }
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const user = userEvent.setup();
  const writeText = vi
    .spyOn(window.navigator.clipboard, "writeText")
    .mockResolvedValue(undefined);
  const view = render(<App />);
  await openFirstPdf(user);

  selectText("alpha");
  expect(starts).toEqual([]);
  await user.click(screen.getByRole("button", { name: "翻译所选文本" }));

  expect(await screen.findByText("集成测试译文")).toBeVisible();
  expect(starts[0].request).toMatchObject({
    documentSessionId: FIRST_DOCUMENT.documentSessionId,
    provider: "deepseek",
    fragments: [{ order: 0, text: "alpha" }],
  });
  expect(JSON.stringify(starts)).not.toMatch(/spans|pageIndex|path|context/i);
  expect(screen.getByText("来自本地缓存")).toBeVisible();
  expect(screen.getByRole("status", { name: "缓存状态" })).toHaveTextContent(
    ERROR_COPY.CACHE_UNAVAILABLE,
  );
  await user.click(screen.getByRole("button", { name: "复制译文" }));
  expect(writeText).toHaveBeenCalledOnce();
  expect(writeText).toHaveBeenCalledWith("集成测试译文");
  view.unmount();
});

test("platform shortcut is a single manual trigger", async () => {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
  let startCalls = 0;
  mockInvoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === "open_pdf_document") return FIRST_DOCUMENT;
    if (command === "read_pdf_bytes") return new ArrayBuffer(4);
    if (command === "close_pdf_document") return null;
    if (command === "start_translation") {
      startCalls += 1;
      if (startCalls > 1) throw new Error("unexpected duplicate start_translation");
      return resultFor(args as StartArguments);
    }
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const user = userEvent.setup();
  const view = render(<App />);
  await openFirstPdf(user);
  selectText("alpha");

  fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
  fireEvent.keyDown(window, { key: "Enter", ctrlKey: true, repeat: true });

  expect(await screen.findByText("集成测试译文")).toBeVisible();
  expect(startCalls).toBe(1);
  view.unmount();
});

test.each([
  [
    "macOS",
    "MacIntel",
    [
      { key: "Enter", metaKey: true, altKey: true },
      { key: "Enter", metaKey: true, shiftKey: true },
      { key: "Enter", metaKey: true, altKey: true, shiftKey: true },
      { key: "Enter", ctrlKey: true },
      { key: "Enter", metaKey: true, ctrlKey: true },
      { key: "Enter", metaKey: true, repeat: true },
    ],
  ],
  [
    "Windows",
    "Win32",
    [
      { key: "Enter", ctrlKey: true, altKey: true },
      { key: "Enter", ctrlKey: true, shiftKey: true },
      { key: "Enter", ctrlKey: true, altKey: true, shiftKey: true },
      { key: "Enter", metaKey: true },
      { key: "Enter", ctrlKey: true, metaKey: true },
      { key: "Enter", ctrlKey: true, repeat: true },
    ],
  ],
] as const)(
  "%s rejects every extra or wrong shortcut modifier before IPC",
  async (_platformLabel, platform, invalidEvents) => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
    let startCalls = 0;
    mockInvoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === "open_pdf_document") return FIRST_DOCUMENT;
      if (command === "read_pdf_bytes") return new ArrayBuffer(4);
      if (command === "close_pdf_document") return null;
      if (command === "start_translation") {
        startCalls += 1;
        if (startCalls > 1) {
          throw new Error("unexpected repeated start_translation");
        }
        return resultFor(args as StartArguments);
      }
      throw new Error(`unexpected IPC command: ${command}`);
    });
    const user = userEvent.setup();
    const view = render(<App />);

    try {
      await openFirstPdf(user);
      selectText("alpha");
      for (const eventInit of invalidEvents) {
        fireEvent.keyDown(window, eventInit);
      }
      await act(async () => {
        await Promise.resolve();
      });

      expect(startCalls).toBe(0);
      expect(screen.getByRole("button", { name: "翻译所选文本" })).toBeEnabled();
      expect(screen.getByText("选择 PDF 文本后，手动触发翻译。")).toBeVisible();
    } finally {
      view.unmount();
    }
  },
);

test("provider switch cancels active work, keeps fragments, and requires a new manual trigger", async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  const starts: StartArguments[] = [];
  const cancelled: string[] = [];
  mockInvoke.mockImplementation((command: string, args: unknown) => {
    if (command === "open_pdf_document") return Promise.resolve(FIRST_DOCUMENT);
    if (command === "read_pdf_bytes") return Promise.resolve(new ArrayBuffer(4));
    if (command === "close_pdf_document") return Promise.resolve(null);
    if (command === "start_translation") {
      starts.push(args as StartArguments);
      if (starts.length === 1) return first.promise;
      if (starts.length === 2) return second.promise;
      throw new Error("unexpected third start_translation");
    }
    if (command === "cancel_translation") {
      cancelled.push((args as { requestId: string }).requestId);
      return Promise.resolve(null);
    }
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const user = userEvent.setup();
  const view = render(<App />);
  await openFirstPdf(user);
  selectText("alpha");
  await user.click(screen.getByRole("button", { name: "翻译所选文本" }));
  await waitFor(() => expect(starts).toHaveLength(1));

  await user.selectOptions(screen.getByLabelText("当前翻译服务"), "youdao");
  await waitFor(() => expect(cancelled).toEqual([starts[0].request.requestId]));
  expect(starts).toHaveLength(1);
  expect(screen.getByRole("button", { name: "翻译所选文本" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "翻译所选文本" }));
  await waitFor(() => expect(starts).toHaveLength(2));
  expect(starts[1].request).toMatchObject({
    provider: "youdao",
    fragments: [{ text: "alpha" }],
  });

  await act(async () => {
    second.resolve(resultFor(starts[1], "有道新结果"));
    await second.promise;
    first.resolve(resultFor(starts[0], "过期结果"));
    await first.promise;
  });
  expect(screen.getByText("有道新结果")).toBeVisible();
  expect(screen.queryByText("过期结果")).not.toBeInTheDocument();
  expect(window.localStorage.getItem("academic-translator.preferences.v1")).toBe(
    '{"defaultProvider":"youdao"}',
  );
  view.unmount();
});

test("collapsing the panel preserves active ownership and publishes the result after expand", async () => {
  const pending = deferred<unknown>();
  let startArgs: StartArguments | null = null;
  mockInvoke.mockImplementation((command: string, args: unknown) => {
    if (command === "open_pdf_document") return Promise.resolve(FIRST_DOCUMENT);
    if (command === "read_pdf_bytes") return Promise.resolve(new ArrayBuffer(4));
    if (command === "close_pdf_document") return Promise.resolve(null);
    if (command === "start_translation") {
      if (startArgs) throw new Error("unexpected duplicate start_translation");
      startArgs = args as StartArguments;
      return pending.promise;
    }
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const user = userEvent.setup();
  const view = render(<App />);
  await openFirstPdf(user);
  selectText("alpha");
  await user.click(screen.getByRole("button", { name: "翻译所选文本" }));
  await waitFor(() => expect(startArgs).not.toBeNull());
  await user.click(screen.getByRole("button", { name: "收起翻译面板" }));

  await act(async () => {
    pending.resolve(resultFor(startArgs!, "折叠后完成"));
    await pending.promise;
  });
  await user.click(screen.getByRole("button", { name: "展开翻译面板" }));
  expect(screen.getByText("折叠后完成")).toBeVisible();
  view.unmount();
});

test("cancelled picker preserves active selection while accepted replacement clears and cancels it", async () => {
  const pending = deferred<unknown>();
  const opens = [FIRST_DOCUMENT, null, SECOND_DOCUMENT];
  let openIndex = 0;
  let startArgs: StartArguments | null = null;
  const cancelled: string[] = [];
  mockInvoke.mockImplementation((command: string, args: unknown) => {
    if (command === "open_pdf_document") {
      const next = opens[openIndex];
      openIndex += 1;
      if (openIndex > opens.length) throw new Error("unexpected extra picker");
      return Promise.resolve(next);
    }
    if (command === "read_pdf_bytes") return Promise.resolve(new ArrayBuffer(4));
    if (command === "close_pdf_document") return Promise.resolve(null);
    if (command === "start_translation") {
      if (startArgs) throw new Error("unexpected duplicate start_translation");
      startArgs = args as StartArguments;
      return pending.promise;
    }
    if (command === "cancel_translation") {
      cancelled.push((args as { requestId: string }).requestId);
      return Promise.resolve(null);
    }
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const user = userEvent.setup();
  const view = render(<App />);
  await openFirstPdf(user);
  selectText("alpha");
  await user.click(screen.getByRole("button", { name: "翻译所选文本" }));
  await waitFor(() => expect(startArgs).not.toBeNull());

  await user.click(screen.getByRole("button", { name: "打开 PDF" }));
  expect(cancelled).toEqual([]);
  expect(screen.getByRole("button", { name: "翻译所选文本" })).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "打开 PDF" }));
  expect(await screen.findByText("paper-two.pdf")).toBeVisible();
  await waitFor(() =>
    expect(cancelled).toEqual([startArgs!.request.requestId]),
  );
  expect(
    screen.queryByRole("button", { name: "翻译所选文本" }),
  ).not.toBeInTheDocument();

  await act(async () => {
    pending.resolve(resultFor(startArgs!, "不应显示的旧结果"));
    await pending.promise;
  });
  expect(screen.queryByText("不应显示的旧结果")).not.toBeInTheDocument();
  expect(screen.getByText("选择 PDF 文本后，手动触发翻译。")).toBeVisible();
  view.unmount();
});

test.each<ReplacementBoundary>([
  "read",
  "load",
  "page enumeration",
  "failure",
])(
  "accepted replacement invalidates document A before deferred %s settles",
  async (boundaryName) => {
    await runAcceptedReplacementBoundary(boundaryName);
  },
);

const DOMAIN_ERROR_CASES = [
  ["AUTH_INVALID", false],
  ["RATE_LIMITED", true],
  ["PROVIDER_UNAVAILABLE", true],
  ["REQUEST_TIMEOUT", true],
  ["MALFORMED_RESPONSE", true],
] as const satisfies ReadonlyArray<readonly [CommandError["code"], boolean]>;

test.each(DOMAIN_ERROR_CASES)(
  "strict native %s reaches only its localized full-app error state",
  async (code, retryable) => {
    let startCalls = 0;
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "open_pdf_document") return FIRST_DOCUMENT;
      if (command === "read_pdf_bytes") return new ArrayBuffer(4);
      if (command === "close_pdf_document") return null;
      if (command === "start_translation") {
        startCalls += 1;
        if (startCalls > 1) {
          throw new Error("unexpected duplicate start_translation");
        }
        throw { code, retryable };
      }
      throw new Error(`unexpected IPC command: ${command}`);
    });
    const user = userEvent.setup();
    const view = render(<App />);
    await openFirstPdf(user);
    selectText("alpha");

    await user.click(screen.getByRole("button", { name: "翻译所选文本" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(ERROR_COPY[code]);
    expect(startCalls).toBe(1);
    expect(screen.queryByText(/stack|authorization|provider envelope/i)).not.toBeInTheDocument();
    if (code === "AUTH_INVALID") {
      expect(screen.getByRole("button", { name: "打开设置" })).toBeVisible();
    }
    view.unmount();
  },
);

test("full-app manual retry reuses the selection with a fresh request UUID", async () => {
  const starts: StartArguments[] = [];
  mockInvoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === "open_pdf_document") return FIRST_DOCUMENT;
    if (command === "read_pdf_bytes") return new ArrayBuffer(4);
    if (command === "close_pdf_document") return null;
    if (command === "start_translation") {
      starts.push(args as StartArguments);
      if (starts.length === 1) {
        throw { code: "RATE_LIMITED", retryable: true };
      }
      if (starts.length === 2) {
        return resultFor(starts[1], "重试后的译文");
      }
      throw new Error("unexpected third start_translation");
    }
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const user = userEvent.setup();
  const view = render(<App />);
  await openFirstPdf(user);
  selectText("alpha");
  await user.click(screen.getByRole("button", { name: "翻译所选文本" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    ERROR_COPY.RATE_LIMITED,
  );

  await user.click(screen.getByRole("button", { name: "重试" }));

  expect(await screen.findByText("重试后的译文")).toBeVisible();
  expect(starts).toHaveLength(2);
  expect(starts[1].request.requestId).not.toBe(starts[0].request.requestId);
  expect(starts[1].request.fragments).toEqual(starts[0].request.fragments);
  view.unmount();
});

test("full-app Cancel invalidates ownership before the late result settles", async () => {
  const pending = deferred<unknown>();
  let startArgs: StartArguments | null = null;
  const cancelled: string[] = [];
  mockInvoke.mockImplementation((command: string, args: unknown) => {
    if (command === "open_pdf_document") return Promise.resolve(FIRST_DOCUMENT);
    if (command === "read_pdf_bytes") return Promise.resolve(new ArrayBuffer(4));
    if (command === "close_pdf_document") return Promise.resolve(null);
    if (command === "start_translation") {
      if (startArgs) throw new Error("unexpected duplicate start_translation");
      startArgs = args as StartArguments;
      return pending.promise;
    }
    if (command === "cancel_translation") {
      cancelled.push((args as { requestId: string }).requestId);
      if (cancelled.length > 1) throw new Error("unexpected duplicate cancellation");
      return Promise.resolve(null);
    }
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const user = userEvent.setup();
  const view = render(<App />);
  await openFirstPdf(user);
  selectText("alpha");
  await user.click(screen.getByRole("button", { name: "翻译所选文本" }));
  await waitFor(() => expect(startArgs).not.toBeNull());

  await user.click(screen.getByRole("button", { name: "取消翻译" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    ERROR_COPY.REQUEST_CANCELLED,
  );
  expect(cancelled).toEqual([startArgs!.request.requestId]);
  await act(async () => {
    pending.resolve(resultFor(startArgs!, "取消后到达的结果"));
    await pending.promise;
  });
  expect(screen.queryByText("取消后到达的结果")).not.toBeInTheDocument();
  view.unmount();
});

test("closing the PDF clears selection and cancels exactly one active request", async () => {
  const pending = deferred<unknown>();
  let startArgs: StartArguments | null = null;
  const cancelled: string[] = [];
  let closeCalls = 0;
  mockInvoke.mockImplementation((command: string, args: unknown) => {
    if (command === "open_pdf_document") return Promise.resolve(FIRST_DOCUMENT);
    if (command === "read_pdf_bytes") return Promise.resolve(new ArrayBuffer(4));
    if (command === "close_pdf_document") {
      closeCalls += 1;
      if (closeCalls > 1) throw new Error("unexpected duplicate close_pdf_document");
      return Promise.resolve(null);
    }
    if (command === "start_translation") {
      if (startArgs) throw new Error("unexpected duplicate start_translation");
      startArgs = args as StartArguments;
      return pending.promise;
    }
    if (command === "cancel_translation") {
      cancelled.push((args as { requestId: string }).requestId);
      if (cancelled.length > 1) throw new Error("unexpected duplicate cancellation");
      return Promise.resolve(null);
    }
    throw new Error(`unexpected IPC command: ${command}`);
  });
  const user = userEvent.setup();
  const view = render(<App />);
  await openFirstPdf(user);
  selectText("alpha");
  await user.click(screen.getByRole("button", { name: "翻译所选文本" }));
  await waitFor(() => expect(startArgs).not.toBeNull());

  await user.click(screen.getByRole("button", { name: "关闭 PDF" }));

  await waitFor(() =>
    expect(cancelled).toEqual([startArgs!.request.requestId]),
  );
  expect(closeCalls).toBe(1);
  expect(screen.queryByRole("button", { name: "翻译所选文本" })).not.toBeInTheDocument();
  await act(async () => {
    pending.resolve(resultFor(startArgs!, "关闭后到达的结果"));
    await pending.promise;
  });
  expect(screen.queryByText("关闭后到达的结果")).not.toBeInTheDocument();
  expect(screen.getByText("选择 PDF 文本后，手动触发翻译。")).toBeVisible();
  view.unmount();
});
