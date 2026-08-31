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

type TaggedEndpoint = {
  span: HTMLElement;
  pageIndex: number;
  textItemIndex: number;
  offset: number;
};

type SpanPiece = {
  pageIndex: number;
  textItemIndex: number;
  startOffset: number;
  endOffset: number;
  text: string;
};

function unsupported(
  reason: UnsupportedSelectionReason,
): UnsupportedSelectionError {
  return { type: "unsupported-selection", reason };
}

function owningElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
}

function documentSessionFor(node: Node, root: HTMLElement): string | undefined {
  const sessionOwner = owningElement(node)?.closest<HTMLElement>(
    "[data-document-session-id]",
  );
  return sessionOwner?.dataset.documentSessionId ?? root.dataset.documentSessionId;
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

function taggedEndpoint(
  container: Node,
  offset: number,
  root: HTMLElement,
): TaggedEndpoint | UnsupportedSelectionError {
  if (!root.contains(container)) {
    return unsupported("outside-pdf-root");
  }

  const span = owningElement(container)?.closest<HTMLElement>(
    "[data-page-index][data-text-item-index]",
  );
  if (!span || !root.contains(span)) {
    return unsupported("untagged-text");
  }

  const pageIndex = Number(span.dataset.pageIndex);
  const textItemIndex = Number(span.dataset.textItemIndex);
  const spanOffset = offsetWithinSpan(span, container, offset);
  if (
    !Number.isSafeInteger(pageIndex) ||
    pageIndex < 0 ||
    !Number.isSafeInteger(textItemIndex) ||
    textItemIndex < 0 ||
    spanOffset === null
  ) {
    return unsupported("untagged-text");
  }

  return { span, pageIndex, textItemIndex, offset: spanOffset };
}

function isUnsupported(
  value: TaggedEndpoint | UnsupportedSelectionError,
): value is UnsupportedSelectionError {
  return "type" in value;
}

function selectedPiece(
  span: HTMLElement,
  start: TaggedEndpoint,
  end: TaggedEndpoint,
): SpanPiece | null {
  const textLength = span.textContent?.length ?? 0;
  const startOffset = span === start.span ? start.offset : 0;
  const endOffset = span === end.span ? end.offset : textLength;
  if (endOffset <= startOffset) {
    return null;
  }

  const pageIndex = Number(span.dataset.pageIndex);
  const textItemIndex = Number(span.dataset.textItemIndex);
  if (!Number.isSafeInteger(pageIndex) || !Number.isSafeInteger(textItemIndex)) {
    return null;
  }

  return {
    pageIndex,
    textItemIndex,
    startOffset,
    endOffset,
    text: (span.textContent ?? "").slice(startOffset, endOffset),
  };
}
function toPageSpans(pieces: readonly SpanPiece[]): SelectionSpan[] {
  const spans: SelectionSpan[] = [];
  for (const piece of pieces) {
    const previous = spans.at(-1);
    if (previous?.pageIndex === piece.pageIndex) {
      previous.end = {
        textItemIndex: piece.textItemIndex,
        offset: piece.endOffset,
      };
      previous.text += piece.text;
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

  const start = taggedEndpoint(
    range.startContainer,
    range.startOffset,
    options.root,
  );
  if (isUnsupported(start)) {
    return start;
  }
  const end = taggedEndpoint(range.endContainer, range.endOffset, options.root);
  if (isUnsupported(end)) {
    return end;
  }

  const rootSession = options.root.dataset.documentSessionId;
  const startSession = documentSessionFor(range.startContainer, options.root);
  const endSession = documentSessionFor(range.endContainer, options.root);
  if (
    (rootSession !== undefined && rootSession !== options.documentSessionId) ||
    startSession !== options.documentSessionId ||
    endSession !== options.documentSessionId ||
    startSession !== endSession
  ) {
    return unsupported("mixed-document-session");
  }

  const taggedSpans = Array.from(
    options.root.querySelectorAll<HTMLElement>(
      "[data-page-index][data-text-item-index]",
    ),
  );
  const pieces = taggedSpans.flatMap((span) => {
    if (!range.intersectsNode(span)) {
      return [];
    }
    const piece = selectedPiece(span, start, end);
    return piece ? [piece] : [];
  });
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
