import type { SelectionFragment, SelectionSpan, TextPosition } from "./types";

export type UnsupportedSelectionReason =
  | "outside-pdf-root"
  | "untagged-text"
  | "mixed-document-session"
  | "empty-selection";

export type UnsupportedSelectionError = {
  type: "unsupported-selection";
  reason: UnsupportedSelectionReason;
};

export type CaptureRangeOptions = {
  documentSessionId: string;
  fragmentId: string;
  order: number;
  root: HTMLElement;
};

type SpanPiece = {
  element: HTMLElement;
  sessionOwner: HTMLElement;
  pageIndex: number;
  textItemIndex: number;
  startOffset: number;
  endOffset: number;
  text: string;
  eolAfterItemIndices: number[];
};

const TAGGED_TEXT_SELECTOR = "[data-page-index][data-text-item-index]";
const TEXT_LAYER_SELECTOR = "[data-page-index][data-document-session-id]";

function unsupported(
  reason: UnsupportedSelectionReason,
): UnsupportedSelectionError {
  return { type: "unsupported-selection", reason };
}

function offsetWithinSpan(
  span: HTMLElement,
  container: Node,
  containerOffset: number,
): number | null {
  try {
    const prefix = document.createRange();
    prefix.setStart(span, 0);
    prefix.setEnd(container, containerOffset);
    const offset = prefix.toString().length;
    prefix.detach();
    return offset;
  } catch {
    return null;
  }
}

function validateBoundaryContainer(
  container: Node,
  root: HTMLElement,
): UnsupportedSelectionError | null {
  if (!root.contains(container)) {
    return unsupported("outside-pdf-root");
  }

  if (container.nodeType === Node.TEXT_NODE) {
    const span = container.parentElement?.closest<HTMLElement>(
      TAGGED_TEXT_SELECTOR,
    );
    return span && root.contains(span) ? null : unsupported("untagged-text");
  }

  if (container.nodeType !== Node.ELEMENT_NODE) {
    return unsupported("untagged-text");
  }

  const element = container as Element;
  const belongsToTextLayer = element.closest(TEXT_LAYER_SELECTOR);
  const containsTaggedText = element.querySelector(TAGGED_TEXT_SELECTOR);
  return element === root || belongsToTextLayer || containsTaggedText
    ? null
    : unsupported("untagged-text");
}

function parseEolIndices(textLayer: HTMLElement): number[] {
  const encoded = textLayer.dataset.eolAfterItemIndices;
  if (!encoded) {
    return [];
  }
  return encoded.split(",").flatMap((value) => {
    const index = Number(value);
    return Number.isSafeInteger(index) && index >= 0 ? [index] : [];
  });
}

function intersectSelectedPiece(
  range: Range,
  span: HTMLElement,
): SpanPiece | null {
  if (!range.intersectsNode(span)) {
    return null;
  }

  const sessionOwner = span.closest<HTMLElement>(TEXT_LAYER_SELECTOR);
  if (!sessionOwner) {
    return null;
  }

  const spanContents = document.createRange();
  spanContents.selectNodeContents(span);
  const intersection = document.createRange();
  if (
    range.compareBoundaryPoints(Range.START_TO_START, spanContents) > 0
  ) {
    intersection.setStart(range.startContainer, range.startOffset);
  } else {
    intersection.setStart(spanContents.startContainer, spanContents.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, spanContents) < 0) {
    intersection.setEnd(range.endContainer, range.endOffset);
  } else {
    intersection.setEnd(spanContents.endContainer, spanContents.endOffset);
  }

  const startOffset = offsetWithinSpan(
    span,
    intersection.startContainer,
    intersection.startOffset,
  );
  const endOffset = offsetWithinSpan(
    span,
    intersection.endContainer,
    intersection.endOffset,
  );
  const text = intersection.toString();
  spanContents.detach();
  intersection.detach();
  if (startOffset === null || endOffset === null || text.length === 0) {
    return null;
  }

  const pageIndex = Number(span.dataset.pageIndex);
  const textItemIndex = Number(span.dataset.textItemIndex);
  if (!Number.isSafeInteger(pageIndex) || !Number.isSafeInteger(textItemIndex)) {
    return null;
  }

  return {
    element: span,
    sessionOwner,
    pageIndex,
    textItemIndex,
    startOffset,
    endOffset,
    text,
    eolAfterItemIndices: parseEolIndices(sessionOwner),
  };
}

function crossedLineBreaks(
  previous: SpanPiece,
  current: SpanPiece,
): string {
  if (
    previous.pageIndex !== current.pageIndex ||
    previous.sessionOwner !== current.sessionOwner
  ) {
    return "";
  }

  const count = previous.eolAfterItemIndices.filter(
    (index) =>
      index >= previous.textItemIndex && index < current.textItemIndex,
  ).length;
  return "\n".repeat(count);
}

function toPageSpans(pieces: readonly SpanPiece[]): SelectionSpan[] {
  const spans: SelectionSpan[] = [];
  let previousPiece: SpanPiece | undefined;
  for (const piece of pieces) {
    const previous = spans.at(-1);
    if (previous?.pageIndex === piece.pageIndex) {
      previous.end = {
        textItemIndex: piece.textItemIndex,
        offset: piece.endOffset,
      };
      previous.text += previousPiece
        ? crossedLineBreaks(previousPiece, piece) + piece.text
        : piece.text;
      previousPiece = piece;
      continue;
    }

    const start: TextPosition = {
      textItemIndex: piece.textItemIndex,
      offset: piece.startOffset,
    };
    spans.push({
      pageIndex: piece.pageIndex,
      start,
      end: {
        textItemIndex: piece.textItemIndex,
        offset: piece.endOffset,
      },
      text: piece.text,
    });
    previousPiece = piece;
  }
  return spans;
}

export function captureRange(
  range: Range,
  options: CaptureRangeOptions,
): SelectionFragment | UnsupportedSelectionError {
  if (range.collapsed) {
    return unsupported("empty-selection");
  }

  const startBoundaryError = validateBoundaryContainer(
    range.startContainer,
    options.root,
  );
  if (startBoundaryError) {
    return startBoundaryError;
  }
  const endBoundaryError = validateBoundaryContainer(
    range.endContainer,
    options.root,
  );
  if (endBoundaryError) {
    return endBoundaryError;
  }

  const rootSession = options.root.dataset.documentSessionId;
  if (rootSession !== options.documentSessionId) {
    return unsupported("mixed-document-session");
  }

  const taggedSpans = Array.from(
    options.root.querySelectorAll<HTMLElement>(TAGGED_TEXT_SELECTOR),
  );
  const pieces = taggedSpans.flatMap((span) => {
    const piece = intersectSelectedPiece(range, span);
    return piece ? [piece] : [];
  });
  if (
    pieces.some(
      (piece) =>
        !options.root.contains(piece.element) ||
        piece.sessionOwner.dataset.documentSessionId !==
          options.documentSessionId,
    )
  ) {
    return unsupported("mixed-document-session");
  }
  const spans = toPageSpans(pieces);
  const text = spans.map((span) => span.text).join("\n");
  if (text.length === 0) {
    return unsupported("empty-selection");
  }

  return {
    id: options.fragmentId,
    documentSessionId: options.documentSessionId,
    order: options.order,
    text,
    spans,
  };
}
