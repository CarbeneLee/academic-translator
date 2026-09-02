import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  captureRange,
  type UnsupportedSelectionError,
} from "./captureRange";
import { deriveFloatingActionPosition } from "./floatingActionPosition";
import { deriveHighlightRects } from "./highlightGeometry";
import {
  emptySelectionState,
  selectionReducer,
} from "./selectionReducer";
import type { SelectionFragment } from "./types";

type UsePdfSelectionOptions = {
  rootRef: RefObject<HTMLElement | null>;
  documentSessionId: string | null;
  scale: number;
  onTranslate(fragments: SelectionFragment[]): void;
  onSelectionChange?(fragments: SelectionFragment[]): void;
  onSelectionMutation?(): void;
  isRequestActive?: boolean;
  onCancelActiveRequest?(): void;
};

function isUnsupportedSelection(
  value: SelectionFragment | UnsupportedSelectionError,
): value is UnsupportedSelectionError {
  return "type" in value && value.type === "unsupported-selection";
}

function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(
    window.navigator.platform || window.navigator.userAgent,
  );
}

export function usePdfSelection({
  rootRef,
  documentSessionId,
  scale,
  onTranslate,
  onSelectionChange,
  onSelectionMutation,
  isRequestActive = false,
  onCancelActiveRequest,
}: UsePdfSelectionOptions) {
  const [state, dispatch] = useReducer(
    selectionReducer,
    emptySelectionState,
  );
  const [textLayerRevision, setTextLayerRevision] = useState(0);
  const [viewportRevision, setViewportRevision] = useState(0);
  const textLayerByPageRef = useRef(new Map<number, HTMLElement>());
  const fragmentSequenceRef = useRef(0);
  const previousDocumentSessionRef = useRef(documentSessionId);

  const fragments =
    documentSessionId !== null &&
    state.fragments.every(
      (fragment) => fragment.documentSessionId === documentSessionId,
    )
      ? state.fragments
      : [];

  const clearSelection = useCallback(() => {
    onSelectionMutation?.();
    onSelectionChange?.([]);
    dispatch({ type: "clear" });
    window.getSelection()?.removeAllRanges();
  }, [onSelectionChange, onSelectionMutation]);

  const registerTextLayer = useCallback(
    (pageIndex: number, textLayer: HTMLElement | null) => {
      const layers = textLayerByPageRef.current;
      if (textLayer) {
        if (layers.get(pageIndex) === textLayer) {
          return;
        }
        layers.set(pageIndex, textLayer);
      } else if (!layers.delete(pageIndex)) {
        return;
      }
      setTextLayerRevision((revision) => revision + 1);
    },
    [],
  );

  useEffect(() => {
    if (previousDocumentSessionRef.current === documentSessionId) {
      return;
    }
    previousDocumentSessionRef.current = documentSessionId;
    fragmentSequenceRef.current = 0;
    textLayerByPageRef.current.clear();
    setTextLayerRevision((revision) => revision + 1);
    clearSelection();
  }, [clearSelection, documentSessionId]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || documentSessionId === null) {
      return;
    }

    const captureCurrentRange = (event: MouseEvent) => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
        return;
      }
      const result = captureRange(selection.getRangeAt(0), {
        documentSessionId,
        fragmentId: `${documentSessionId}:${fragmentSequenceRef.current + 1}`,
        order: event.altKey ? fragments.length : 0,
        root,
      });
      if (isUnsupportedSelection(result)) {
        return;
      }

      fragmentSequenceRef.current += 1;
      const nextFragments = event.altKey ? [...fragments, result] : [result];
      onSelectionMutation?.();
      onSelectionChange?.(nextFragments);
      dispatch({
        type: "capture",
        fragment: result,
        additive: event.altKey,
      });
      selection.removeAllRanges();
    };

    root.addEventListener("mouseup", captureCurrentRange);
    return () => root.removeEventListener("mouseup", captureCurrentRange);
  }, [
    documentSessionId,
    fragments,
    onSelectionChange,
    onSelectionMutation,
    rootRef,
  ]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    const refreshRenderedLayer = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !root.contains(target)) {
        return;
      }
      const pageIndex = Number(target.dataset.pageIndex);
      if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        return;
      }
      textLayerByPageRef.current.set(pageIndex, target);
      setTextLayerRevision((revision) => revision + 1);
    };

    root.addEventListener("textlayerrendered", refreshRenderedLayer);
    return () =>
      root.removeEventListener("textlayerrendered", refreshRenderedLayer);
  }, [documentSessionId, rootRef]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    const refreshViewportGeometry = () => {
      setViewportRevision((revision) => revision + 1);
    };
    root.addEventListener("scroll", refreshViewportGeometry, {
      passive: true,
    });
    window.addEventListener("scroll", refreshViewportGeometry, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", refreshViewportGeometry);
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(refreshViewportGeometry);
    resizeObserver?.observe(root);
    return () => {
      root.removeEventListener("scroll", refreshViewportGeometry);
      window.removeEventListener("scroll", refreshViewportGeometry, true);
      window.removeEventListener("resize", refreshViewportGeometry);
      resizeObserver?.disconnect();
    };
  }, [documentSessionId, rootRef]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isRequestActive) {
          onCancelActiveRequest?.();
        } else {
          clearSelection();
        }
        return;
      }

      if (
        event.key !== "Enter" ||
        event.repeat ||
        event.altKey ||
        event.shiftKey ||
        fragments.length === 0
      ) {
        return;
      }
      const matchesPlatformShortcut = isMacPlatform()
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (!matchesPlatformShortcut) {
        return;
      }

      event.preventDefault();
      onTranslate(fragments);
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [
    clearSelection,
    fragments,
    isRequestActive,
    onCancelActiveRequest,
    onTranslate,
  ]);

  const highlightRects = useMemo(
    () => deriveHighlightRects(fragments, textLayerByPageRef.current),
    [fragments, scale, textLayerRevision],
  );
  const floatingActionPosition = useMemo(() => {
    const root = rootRef.current;
    return root
      ? deriveFloatingActionPosition(
          highlightRects,
          textLayerByPageRef.current,
          root,
        )
      : { left: 12, top: 12 };
  }, [highlightRects, rootRef, viewportRevision]);

  return {
    fragments,
    highlightRects,
    floatingActionPosition,
    clearSelection,
    registerTextLayer,
  };
}
