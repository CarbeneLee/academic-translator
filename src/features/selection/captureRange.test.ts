import {
  captureRange,
  type UnsupportedSelectionError,
} from "./captureRange";

const sessionId = "document-session-1";

type TaggedSpan = {
  pageIndex: number;
  textItemIndex: number;
  text: string;
  documentSessionId?: string;
  eolAfterItemIndices?: readonly number[];
};

function buildPdfRoot(items: readonly TaggedSpan[]): {
  root: HTMLDivElement;
  textNodes: Text[];
} {
  const root = document.createElement("div");
  root.dataset.documentSessionId = sessionId;
  const pages = new Map<number, HTMLDivElement>();
  const textNodes: Text[] = [];

  for (const item of items) {
    let textLayer = pages.get(item.pageIndex);
    if (!textLayer) {
      textLayer = document.createElement("div");
      textLayer.className = "pdfTextLayer";
      textLayer.dataset.pageIndex = String(item.pageIndex);
      textLayer.dataset.documentSessionId =
        item.documentSessionId ?? sessionId;
      textLayer.dataset.eolAfterItemIndices =
        item.eolAfterItemIndices?.join(",") ?? "";
      root.append(textLayer);
      pages.set(item.pageIndex, textLayer);
    }

    const span = document.createElement("span");
    span.dataset.pageIndex = String(item.pageIndex);
    span.dataset.textItemIndex = String(item.textItemIndex);
    const textNode = document.createTextNode(item.text);
    span.append(textNode);
    textLayer.append(span);
    textNodes.push(textNode);
  }

  document.body.append(root);
  return { root, textNodes };
}

function options(root: HTMLElement) {
  return {
    documentSessionId: sessionId,
    fragmentId: "fragment-1",
    order: 0,
    root,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

test("captures one page with UTF-16 offsets and stable text-item anchors", () => {
  const { root, textNodes } = buildPdfRoot([
    { pageIndex: 0, textItemIndex: 4, text: "alpha " },
    { pageIndex: 0, textItemIndex: 5, text: "beta gamma" },
  ]);
  const range = document.createRange();
  range.setStart(textNodes[0], 2);
  range.setEnd(textNodes[1], 4);

  expect(captureRange(range, options(root))).toEqual({
    id: "fragment-1",
    documentSessionId: sessionId,
    order: 0,
    text: "pha beta",
    spans: [
      {
        pageIndex: 0,
        start: { textItemIndex: 4, offset: 2 },
        end: { textItemIndex: 5, offset: 4 },
        text: "pha beta",
      },
    ],
  });
});

test("splits a cross-page range into ordered page-local spans", () => {
  const { root, textNodes } = buildPdfRoot([
    { pageIndex: 0, textItemIndex: 7, text: "the end of " },
    { pageIndex: 0, textItemIndex: 8, text: "page one" },
    { pageIndex: 1, textItemIndex: 0, text: "start of " },
    { pageIndex: 1, textItemIndex: 1, text: "page two and beyond" },
  ]);
  const range = document.createRange();
  range.setStart(textNodes[0], 4);
  range.setEnd(textNodes[3], 8);

  expect(captureRange(range, options(root))).toEqual({
    id: "fragment-1",
    documentSessionId: sessionId,
    order: 0,
    text: "end of page one\nstart of page two",
    spans: [
      {
        pageIndex: 0,
        start: { textItemIndex: 7, offset: 4 },
        end: { textItemIndex: 8, offset: 8 },
        text: "end of page one",
      },
      {
        pageIndex: 1,
        start: { textItemIndex: 0, offset: 0 },
        end: { textItemIndex: 1, offset: 8 },
        text: "start of page two",
      },
    ],
  });
});

test("uses UTF-16 code-unit offsets without rewriting surrogate pairs", () => {
  const { root, textNodes } = buildPdfRoot([
    { pageIndex: 0, textItemIndex: 2, text: "A𝐀B" },
  ]);
  const range = document.createRange();
  range.setStart(textNodes[0], 1);
  range.setEnd(textNodes[0], 3);

  const result = captureRange(range, options(root));

  expect(result).toMatchObject({
    text: "𝐀",
    spans: [
      {
        start: { textItemIndex: 2, offset: 1 },
        end: { textItemIndex: 2, offset: 3 },
        text: "𝐀",
      },
    ],
  });
});

test("normalizes marked-content element boundaries around BR nodes to selected tagged text", () => {
  const root = document.createElement("div");
  root.dataset.documentSessionId = sessionId;
  const layer = document.createElement("div");
  layer.dataset.pageIndex = "0";
  layer.dataset.documentSessionId = sessionId;
  layer.dataset.eolAfterItemIndices = "0";
  const markedContent = document.createElement("span");
  markedContent.className = "markedContent";
  const first = document.createElement("span");
  first.dataset.pageIndex = "0";
  first.dataset.textItemIndex = "0";
  first.textContent = "multi-";
  const second = document.createElement("span");
  second.dataset.pageIndex = "0";
  second.dataset.textItemIndex = "1";
  second.textContent = "modal";
  markedContent.append(first, document.createElement("br"), second);
  layer.append(markedContent);
  root.append(layer);
  document.body.append(root);
  const range = document.createRange();
  range.setStart(markedContent, 0);
  range.setEnd(markedContent, markedContent.childNodes.length);

  expect(captureRange(range, options(root))).toMatchObject({
    text: "multi-\nmodal",
    spans: [
      {
        pageIndex: 0,
        start: { textItemIndex: 0, offset: 0 },
        end: { textItemIndex: 1, offset: 5 },
        text: "multi-\nmodal",
      },
    ],
  });
});

test("accepts child-offset boundaries directly on tagged spans", () => {
  const { root } = buildPdfRoot([
    { pageIndex: 0, textItemIndex: 4, text: "alpha" },
    { pageIndex: 0, textItemIndex: 5, text: "beta" },
  ]);
  const spans = root.querySelectorAll<HTMLElement>(
    "[data-text-item-index]",
  );
  const range = document.createRange();
  range.setStart(spans[0], 0);
  range.setEnd(spans[1], spans[1].childNodes.length);

  expect(captureRange(range, options(root))).toMatchObject({
    text: "alphabeta",
    spans: [
      {
        start: { textItemIndex: 4, offset: 0 },
        end: { textItemIndex: 5, offset: 4 },
        text: "alphabeta",
      },
    ],
  });
});

test("resolves text-layer boundaries directionally across BR siblings", () => {
  const root = document.createElement("div");
  root.dataset.documentSessionId = sessionId;
  const layer = document.createElement("div");
  layer.dataset.pageIndex = "0";
  layer.dataset.documentSessionId = sessionId;
  const first = document.createElement("span");
  first.dataset.pageIndex = "0";
  first.dataset.textItemIndex = "0";
  first.textContent = "alpha";
  const lineBreak = document.createElement("br");
  const second = document.createElement("span");
  second.dataset.pageIndex = "0";
  second.dataset.textItemIndex = "1";
  second.textContent = "beta";
  layer.append(first, lineBreak, second);
  root.append(layer);
  document.body.append(root);

  const afterBreak = document.createRange();
  afterBreak.setStart(layer, 2);
  afterBreak.setEnd(layer, layer.childNodes.length);
  expect(captureRange(afterBreak, options(root))).toMatchObject({
    text: "beta",
    spans: [
      {
        start: { textItemIndex: 1, offset: 0 },
        end: { textItemIndex: 1, offset: 4 },
      },
    ],
  });

  const beforeBreak = document.createRange();
  beforeBreak.setStart(layer, 0);
  beforeBreak.setEnd(layer, 1);
  expect(captureRange(beforeBreak, options(root))).toMatchObject({
    text: "alpha",
    spans: [
      {
        start: { textItemIndex: 0, offset: 0 },
        end: { textItemIndex: 0, offset: 5 },
      },
    ],
  });
});

test("does not snap end-of-layer boundaries onto unselected text", () => {
  const { root } = buildPdfRoot([
    { pageIndex: 0, textItemIndex: 0, text: "page zero" },
    { pageIndex: 1, textItemIndex: 0, text: "page one" },
  ]);
  const layers = root.querySelectorAll<HTMLElement>(".pdfTextLayer");

  const startAfterPageZero = document.createRange();
  startAfterPageZero.setStart(layers[0], layers[0].childNodes.length);
  startAfterPageZero.setEnd(layers[1], layers[1].childNodes.length);
  expect(captureRange(startAfterPageZero, options(root))).toMatchObject({
    text: "page one",
    spans: [{ pageIndex: 1, text: "page one" }],
  });

  const endBeforePageOne = document.createRange();
  endBeforePageOne.setStart(layers[0], 0);
  endBeforePageOne.setEnd(layers[1], 0);
  expect(captureRange(endBeforePageOne, options(root))).toMatchObject({
    text: "page zero",
    spans: [{ pageIndex: 0, text: "page zero" }],
  });
});

test("rejects an element range that selects only an untagged BR", () => {
  const { root } = buildPdfRoot([
    { pageIndex: 0, textItemIndex: 0, text: "alpha" },
  ]);
  const layer = root.querySelector<HTMLElement>(".pdfTextLayer");
  if (!layer) {
    throw new Error("expected text layer");
  }
  const lineBreak = document.createElement("br");
  layer.prepend(lineBreak);
  const range = document.createRange();
  range.setStart(layer, 0);
  range.setEnd(layer, 1);

  expect(captureRange(range, options(root))).toEqual({
    type: "unsupported-selection",
    reason: "empty-selection",
  });
});

test("preserves EOL only when selected text crosses the PDF.js boundary", () => {
  const { root, textNodes } = buildPdfRoot([
    {
      pageIndex: 0,
      textItemIndex: 0,
      text: "multi-",
      eolAfterItemIndices: [0],
    },
    { pageIndex: 0, textItemIndex: 1, text: "modal" },
  ]);
  const crossed = document.createRange();
  crossed.setStart(textNodes[0], 2);
  crossed.setEnd(textNodes[1], 3);
  expect(captureRange(crossed, options(root))).toMatchObject({
    text: "lti-\nmod",
    spans: [
      {
        start: { textItemIndex: 0, offset: 2 },
        end: { textItemIndex: 1, offset: 3 },
        text: "lti-\nmod",
      },
    ],
  });

  const leftOnly = document.createRange();
  leftOnly.selectNodeContents(textNodes[0]);
  expect(captureRange(leftOnly, options(root))).toMatchObject({
    text: "multi-",
    spans: [{ text: "multi-" }],
  });

  const rightOnly = document.createRange();
  rightOnly.selectNodeContents(textNodes[1]);
  expect(captureRange(rightOnly, options(root))).toMatchObject({
    text: "modal",
    spans: [{ text: "modal" }],
  });
});

test("preserves a newline from an empty EOL item between selected spans", () => {
  const { root, textNodes } = buildPdfRoot([
    {
      pageIndex: 0,
      textItemIndex: 0,
      text: "multi-",
      eolAfterItemIndices: [1],
    },
    { pageIndex: 0, textItemIndex: 2, text: "modal" },
  ]);
  const range = document.createRange();
  range.setStart(textNodes[0], 0);
  range.setEnd(textNodes[1], textNodes[1].length);

  expect(captureRange(range, options(root))).toMatchObject({
    text: "multi-\nmodal",
    spans: [
      {
        start: { textItemIndex: 0, offset: 0 },
        end: { textItemIndex: 2, offset: 5 },
        text: "multi-\nmodal",
      },
    ],
  });
});

test.each([
  { reason: "outside-pdf-root" as const },
  { reason: "untagged-text" as const },
])(
  "returns $reason for an invalid endpoint",
  ({ reason }) => {
    const { root, textNodes } = buildPdfRoot([
      { pageIndex: 0, textItemIndex: 0, text: "selected" },
    ]);
    const invalidContainer = document.createElement("div");
    const invalidText = document.createTextNode("invalid");
    invalidContainer.append(invalidText);
    if (reason === "outside-pdf-root") {
      document.body.append(invalidContainer);
    } else {
      root.append(invalidContainer);
    }
    const range = document.createRange();
    range.setStart(textNodes[0], 0);
    range.setEnd(invalidText, invalidText.length);

    expect(captureRange(range, options(root))).toEqual<UnsupportedSelectionError>(
      {
        type: "unsupported-selection",
        reason,
      },
    );
  },
);

test("rejects endpoints tagged with different document sessions", () => {
  const { root, textNodes } = buildPdfRoot([
    { pageIndex: 0, textItemIndex: 0, text: "current " },
    {
      pageIndex: 1,
      textItemIndex: 0,
      text: "stale",
      documentSessionId: "document-session-2",
    },
  ]);
  const range = document.createRange();
  range.setStart(textNodes[0], 0);
  range.setEnd(textNodes[1], textNodes[1].length);

  expect(captureRange(range, options(root))).toEqual({
    type: "unsupported-selection",
    reason: "mixed-document-session",
  });
});

test("rejects a stale middle text layer between current-session endpoints", () => {
  const { root, textNodes } = buildPdfRoot([
    { pageIndex: 0, textItemIndex: 0, text: "current start" },
    {
      pageIndex: 1,
      textItemIndex: 0,
      text: "stale middle",
      documentSessionId: "document-session-2",
    },
    { pageIndex: 2, textItemIndex: 0, text: "current end" },
  ]);
  const range = document.createRange();
  range.setStart(textNodes[0], 0);
  range.setEnd(textNodes[2], textNodes[2].length);

  expect(captureRange(range, options(root))).toEqual({
    type: "unsupported-selection",
    reason: "mixed-document-session",
  });
});
