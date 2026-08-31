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
