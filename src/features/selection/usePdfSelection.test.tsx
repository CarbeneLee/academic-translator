import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { RefObject } from "react";
import { FloatingTranslateAction } from "./FloatingTranslateAction";
import { usePdfSelection } from "./usePdfSelection";

const sessionId = "document-session-1";

type PdfDom = {
  root: HTMLDivElement;
  layer: HTMLDivElement;
  textNodes: Text[];
};

function buildPdfDom(texts = ["alpha", "beta", "gamma"]): PdfDom {
  const root = document.createElement("div");
  root.dataset.documentSessionId = sessionId;
  const layer = document.createElement("div");
  layer.dataset.pageIndex = "0";
  layer.dataset.documentSessionId = sessionId;
  const textNodes = texts.map((text, textItemIndex) => {
    const span = document.createElement("span");
    span.dataset.pageIndex = "0";
    span.dataset.textItemIndex = String(textItemIndex);
    const textNode = document.createTextNode(text);
    span.append(textNode);
    layer.append(span);
    return textNode;
  });
  root.append(layer);
  document.body.append(root);
  return { root, layer, textNodes };
}

function select(node: Text, start = 0, end = node.length): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("jsdom selection is unavailable");
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function rootRef(root: HTMLElement): RefObject<HTMLElement | null> {
  return { current: root };
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test("normal mouseup replaces while Alt mouseup appends without translating", () => {
  const { root, textNodes } = buildPdfDom();
  const onTranslate = vi.fn();
  const { result } = renderHook(() =>
    usePdfSelection({
      rootRef: rootRef(root),
      documentSessionId: sessionId,
      scale: 1,
      onTranslate,
    }),
  );

  select(textNodes[0]);
  fireEvent.mouseUp(root);
  expect(result.current.fragments.map((fragment) => fragment.text)).toEqual([
    "alpha",
  ]);
  expect(window.getSelection()?.rangeCount).toBe(0);

  select(textNodes[1]);
  fireEvent.mouseUp(root, { altKey: true });
  expect(result.current.fragments.map((fragment) => fragment.text)).toEqual([
    "alpha",
    "beta",
  ]);
  expect(result.current.fragments.map((fragment) => fragment.order)).toEqual([
    0, 1,
  ]);

  select(textNodes[2]);
  fireEvent.mouseUp(root);
  expect(result.current.fragments.map((fragment) => fragment.text)).toEqual([
    "gamma",
  ]);
  expect(onTranslate).not.toHaveBeenCalled();
});

test("selection mutations synchronously publish the owned fragments before any translation", () => {
  const { root, textNodes } = buildPdfDom();
  const onSelectionChange = vi.fn();
  const onSelectionMutation = vi.fn();
  const onTranslate = vi.fn();
  renderHook(() =>
    usePdfSelection({
      rootRef: rootRef(root),
      documentSessionId: sessionId,
      scale: 1,
      onTranslate,
      onSelectionChange,
      onSelectionMutation,
    }),
  );

  select(textNodes[0]);
  fireEvent.mouseUp(root);

  expect(onSelectionMutation).toHaveBeenCalledOnce();
  expect(onSelectionChange).toHaveBeenCalledOnce();
  expect(onSelectionChange.mock.calls[0][0]).toMatchObject([
    { documentSessionId: sessionId, order: 0, text: "alpha" },
  ]);
  expect(onTranslate).not.toHaveBeenCalled();
});

test("Cmd+Enter calls onTranslate once and ignores repeats on macOS", () => {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
  const { root, textNodes } = buildPdfDom();
  const onTranslate = vi.fn();
  const { result } = renderHook(() =>
    usePdfSelection({
      rootRef: rootRef(root),
      documentSessionId: sessionId,
      scale: 1,
      onTranslate,
    }),
  );
  select(textNodes[0]);
  fireEvent.mouseUp(root);

  fireEvent.keyDown(window, { key: "Enter", metaKey: true });
  fireEvent.keyDown(window, { key: "Enter", metaKey: true, repeat: true });
  fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });

  expect(onTranslate).toHaveBeenCalledOnce();
  expect(onTranslate).toHaveBeenCalledWith(result.current.fragments);
});
test("Ctrl+Enter calls onTranslate once on Windows", () => {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
  const { root, textNodes } = buildPdfDom();
  const onTranslate = vi.fn();
  renderHook(() =>
    usePdfSelection({
      rootRef: rootRef(root),
      documentSessionId: sessionId,
      scale: 1,
      onTranslate,
    }),
  );
  select(textNodes[0]);
  fireEvent.mouseUp(root);

  fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
  fireEvent.keyDown(window, { key: "Enter", metaKey: true });

  expect(onTranslate).toHaveBeenCalledOnce();
});

test("Escape cancels an active request before it may clear selection", () => {
  const { root, textNodes } = buildPdfDom();
  const onCancelActiveRequest = vi.fn();
  const { result, rerender } = renderHook(
    ({ isRequestActive }) =>
      usePdfSelection({
        rootRef: rootRef(root),
        documentSessionId: sessionId,
        scale: 1,
        onTranslate: vi.fn(),
        isRequestActive,
        onCancelActiveRequest,
      }),
    { initialProps: { isRequestActive: true } },
  );
  select(textNodes[0]);
  fireEvent.mouseUp(root);

  fireEvent.keyDown(window, { key: "Escape" });
  expect(onCancelActiveRequest).toHaveBeenCalledOnce();
  expect(result.current.fragments).toHaveLength(1);

  rerender({ isRequestActive: false });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(result.current.fragments).toEqual([]);
});

test("document close clears stored fragments and visible highlights", () => {
  const { root, layer, textNodes } = buildPdfDom();
  const originalCreateRange = document.createRange.bind(document);
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = originalCreateRange();
    Object.defineProperty(range, "getClientRects", {
      value: () => [
        {
          left: 4,
          top: 6,
          width: 20,
          height: 10,
          right: 24,
          bottom: 16,
          x: 4,
          y: 6,
          toJSON: () => undefined,
        },
      ],
    });
    return range;
  });
  const { result, rerender } = renderHook(
    ({ documentSessionId }) =>
      usePdfSelection({
        rootRef: rootRef(root),
        documentSessionId,
        scale: 1,
        onTranslate: vi.fn(),
      }),
    { initialProps: { documentSessionId: sessionId as string | null } },
  );
  act(() => result.current.registerTextLayer(0, layer));
  select(textNodes[0]);
  fireEvent.mouseUp(root);
  expect(result.current.highlightRects).toHaveLength(1);

  rerender({ documentSessionId: null });

  expect(result.current.fragments).toEqual([]);
  expect(result.current.highlightRects).toEqual([]);
});

test("highlight geometry recomputes after zoom and text-layer remount", () => {
  const { root, layer, textNodes } = buildPdfDom();
  const originalCreateRange = document.createRange.bind(document);
  let clientLeft = 10;
  const getClientRects = vi.fn(() => [
    {
      left: clientLeft,
      top: 20,
      width: 30,
      height: 10,
      right: clientLeft + 30,
      bottom: 30,
      x: clientLeft,
      y: 20,
      toJSON: () => undefined,
    },
  ]);
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = originalCreateRange();
    Object.defineProperty(range, "getClientRects", { value: getClientRects });
    return range;
  });
  const { result, rerender } = renderHook(
    ({ scale }) =>
      usePdfSelection({
        rootRef: rootRef(root),
        documentSessionId: sessionId,
        scale,
        onTranslate: vi.fn(),
      }),
    { initialProps: { scale: 1 } },
  );
  act(() => result.current.registerTextLayer(0, layer));
  select(textNodes[0]);
  fireEvent.mouseUp(root);
  const callsAfterCapture = getClientRects.mock.calls.length;

  clientLeft = 15;
  rerender({ scale: 2 });
  expect(getClientRects.mock.calls.length).toBeGreaterThan(callsAfterCapture);
  expect(result.current.highlightRects[0].x).toBe(15);

  const remountedLayer = layer.cloneNode(true) as HTMLDivElement;
  root.replaceChild(remountedLayer, layer);
  clientLeft = 25;
  act(() => {
    result.current.registerTextLayer(0, null);
    result.current.registerTextLayer(0, remountedLayer);
  });
  expect(result.current.highlightRects[0].x).toBe(25);
  expect(result.current.fragments[0].text).toBe("alpha");
});

test("floating action forwards only the application-owned fragments", () => {
  const { root, textNodes } = buildPdfDom();
  const onTranslate = vi.fn();
  const { result } = renderHook(() =>
    usePdfSelection({
      rootRef: rootRef(root),
      documentSessionId: sessionId,
      scale: 1,
      onTranslate,
    }),
  );
  select(textNodes[0]);
  fireEvent.mouseUp(root);
  const view = render(
    <FloatingTranslateAction
      fragments={result.current.fragments}
      onTranslate={onTranslate}
    />,
  );

  fireEvent.click(view.getByRole("button", { name: "翻译所选文本" }));

  expect(onTranslate).toHaveBeenCalledOnce();
  expect(onTranslate).toHaveBeenCalledWith(result.current.fragments);
});

test("floating action remains visible but disabled while translation is active", () => {
  const selected = [
    {
      id: `${sessionId}:1`,
      documentSessionId: sessionId,
      order: 0,
      text: "alpha",
      spans: [],
    },
  ];

  render(
    <FloatingTranslateAction
      fragments={selected}
      onTranslate={vi.fn()}
      disabled
    />,
  );

  expect(
    screen.getByRole("button", { name: "翻译所选文本" }),
  ).toBeDisabled();
});
