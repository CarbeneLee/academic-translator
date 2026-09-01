import { useCallback, useEffect, useRef, useState } from "react";
import type { SelectionFragment } from "../selection/types";
import { invalidIpcResponse } from "./errors";
import {
  cancelTranslation,
  startTranslation,
  type TranslationRequest,
} from "./ipc";
import {
  CommandErrorSchema,
  type CommandError,
  type Provider,
  type TranslationResult,
} from "./schemas";

export type TranslationViewState =
  | { status: "idle" }
  | { status: "loading"; requestId: string }
  | { status: "success"; result: TranslationResult }
  | { status: "error"; requestId: string; error: CommandError };

type TranslationControllerOptions = {
  documentSessionId: string | null;
  provider: Provider;
  fragments: readonly SelectionFragment[];
};

type RequestSnapshot = Omit<TranslationRequest, "requestId">;

type ActiveRequest = RequestSnapshot & {
  requestId: string;
  selectionKey: string;
  generation: number;
};

type CurrentInputs = TranslationControllerOptions & {
  selectionKey: string;
};

const IDLE_STATE: TranslationViewState = { status: "idle" };

function selectionKey(fragments: readonly SelectionFragment[]): string {
  return JSON.stringify(
    fragments.map(({ id, order, text, documentSessionId }) => ({
      id,
      order,
      text,
      documentSessionId,
    })),
  );
}

function safeCommandError(value: unknown): CommandError {
  const parsed = CommandErrorSchema.safeParse(value);
  return parsed.success ? parsed.data : invalidIpcResponse();
}

function requestFragments(
  fragments: readonly SelectionFragment[],
): TranslationRequest["fragments"] {
  return fragments.map(({ id, order, text }) => ({ id, order, text }));
}

export function useTranslationController({
  documentSessionId,
  provider,
  fragments,
}: TranslationControllerOptions) {
  const currentSelectionKey = selectionKey(fragments);
  const currentInputsRef = useRef<CurrentInputs>({
    documentSessionId,
    provider,
    fragments,
    selectionKey: currentSelectionKey,
  });
  currentInputsRef.current = {
    documentSessionId,
    provider,
    fragments,
    selectionKey: currentSelectionKey,
  };

  const [state, setReactState] = useState<TranslationViewState>(IDLE_STATE);
  const stateRef = useRef<TranslationViewState>(IDLE_STATE);
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const lastRequestRef = useRef<RequestSnapshot | null>(null);
  const requestGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  const publishState = useCallback((nextState: TranslationViewState) => {
    stateRef.current = nextState;
    if (mountedRef.current) {
      setReactState(nextState);
    }
  }, []);

  const isCurrent = useCallback((request: ActiveRequest) => {
    const current = currentInputsRef.current;
    return (
      mountedRef.current &&
      activeRequestRef.current === request &&
      requestGenerationRef.current === request.generation &&
      current.documentSessionId === request.documentSessionId &&
      current.provider === request.provider &&
      current.selectionKey === request.selectionKey
    );
  }, []);

  const begin = useCallback(
    (snapshot: RequestSnapshot) => {
      if (activeRequestRef.current !== null) {
        return;
      }

      const requestId = globalThis.crypto.randomUUID();
      const generation = requestGenerationRef.current + 1;
      requestGenerationRef.current = generation;
      const request: ActiveRequest = {
        ...snapshot,
        requestId,
        selectionKey: currentInputsRef.current.selectionKey,
        generation,
      };
      activeRequestRef.current = request;
      lastRequestRef.current = snapshot;
      publishState({ status: "loading", requestId });

      void startTranslation({
        requestId,
        documentSessionId: snapshot.documentSessionId,
        provider: snapshot.provider,
        fragments: snapshot.fragments,
      })
        .then((result) => {
          if (!isCurrent(request)) {
            return;
          }
          activeRequestRef.current = null;
          if (
            result.requestId !== request.requestId ||
            result.documentSessionId !== request.documentSessionId ||
            result.provider !== request.provider
          ) {
            publishState({
              status: "error",
              requestId,
              error: invalidIpcResponse(),
            });
            return;
          }
          publishState({ status: "success", result });
        })
        .catch((error: unknown) => {
          if (!isCurrent(request)) {
            return;
          }
          activeRequestRef.current = null;
          publishState({
            status: "error",
            requestId,
            error: safeCommandError(error),
          });
        });
    },
    [isCurrent, publishState],
  );

  const trigger = useCallback(() => {
    if (activeRequestRef.current !== null) {
      return;
    }
    const current = currentInputsRef.current;
    const hasValidSelection =
      current.documentSessionId !== null &&
      current.fragments.length > 0 &&
      current.fragments.every(
        (fragment) =>
          fragment.documentSessionId === current.documentSessionId &&
          fragment.text.length > 0,
      );
    if (!hasValidSelection || current.documentSessionId === null) {
      const requestId = globalThis.crypto.randomUUID();
      lastRequestRef.current = null;
      publishState({
        status: "error",
        requestId,
        error: { code: "SELECTION_EMPTY", retryable: false },
      });
      return;
    }
    begin({
      documentSessionId: current.documentSessionId,
      provider: current.provider,
      fragments: requestFragments(current.fragments),
    });
  }, [begin, publishState]);

  const retry = useCallback(() => {
    const previousState = stateRef.current;
    if (
      activeRequestRef.current !== null ||
      !lastRequestRef.current ||
      (previousState.status === "error" && !previousState.error.retryable)
    ) {
      return;
    }
    begin({
      ...lastRequestRef.current,
      fragments: lastRequestRef.current.fragments.map((fragment) => ({
        ...fragment,
      })),
    });
  }, [begin]);

  const cancelActive = useCallback(
    (explicit: boolean) => {
      const active = activeRequestRef.current;
      if (!active) {
        if (!explicit) {
          lastRequestRef.current = null;
          if (stateRef.current.status !== "idle") {
            publishState(IDLE_STATE);
          }
        }
        return;
      }
      activeRequestRef.current = null;
      if (explicit) {
        publishState({
          status: "error",
          requestId: active.requestId,
          error: { code: "REQUEST_CANCELLED", retryable: false },
        });
      } else {
        lastRequestRef.current = null;
        publishState(IDLE_STATE);
      }
      void cancelTranslation(active.requestId).catch(() => undefined);
    },
    [publishState],
  );

  const cancel = useCallback(() => cancelActive(true), [cancelActive]);
  const cancelForLifecycle = useCallback(
    () => cancelActive(false),
    [cancelActive],
  );

  const lifecycleKey = `${documentSessionId ?? ""}\u0000${provider}\u0000${currentSelectionKey}`;
  const previousLifecycleKeyRef = useRef(lifecycleKey);
  useEffect(() => {
    if (previousLifecycleKeyRef.current === lifecycleKey) {
      return;
    }
    previousLifecycleKeyRef.current = lifecycleKey;
    cancelForLifecycle();
  }, [cancelForLifecycle, lifecycleKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = activeRequestRef.current;
      activeRequestRef.current = null;
      if (active) {
        void cancelTranslation(active.requestId).catch(() => undefined);
      }
    };
  }, []);

  return {
    state,
    isRequestActive: state.status === "loading",
    trigger,
    retry,
    cancel,
    cancelForLifecycle,
  };
}
