import { useEffect, useRef, useState } from "react";
import {
  cacheStats,
  clearCache,
} from "../translation/ipc";
import type { CacheStats } from "../translation/schemas";
import {
  credentialStatuses,
  deleteCredential,
  saveCredential,
  type CredentialKind,
  type CredentialSummary,
} from "./credentialSchemas";
import {
  loadPreferences,
  saveDefaultProvider,
  type ProviderId,
} from "./preferences";

type CredentialField = {
  kind: CredentialKind;
  inputLabel: string;
  actionLabel: string;
};

const CREDENTIAL_FIELDS: CredentialField[] = [
  {
    kind: "deepseek_api_key",
    inputLabel: "DeepSeek API Key",
    actionLabel: "DeepSeek Key",
  },
  {
    kind: "youdao_app_id",
    inputLabel: "Youdao App ID",
    actionLabel: "Youdao App ID",
  },
  {
    kind: "youdao_app_secret",
    inputLabel: "Youdao App Secret",
    actionLabel: "Youdao App Secret",
  },
];

const EMPTY_INPUTS: Record<CredentialKind, string> = {
  deepseek_api_key: "",
  youdao_app_id: "",
  youdao_app_secret: "",
};

function perCredential<T>(value: T): Record<CredentialKind, T> {
  return {
    deepseek_api_key: value,
    youdao_app_id: value,
    youdao_app_secret: value,
  };
}

export function SettingsDialog({
  open,
  onClose,
  provider,
  onProviderChange,
}: {
  open: boolean;
  onClose: () => void;
  provider?: ProviderId;
  onProviderChange?(provider: ProviderId): void;
}) {
  const [inputs, setInputs] = useState(EMPTY_INPUTS);
  const [summaries, setSummaries] = useState<
    Partial<Record<CredentialKind, CredentialSummary>>
  >({});
  const [pendingByKind, setPendingByKind] = useState(() =>
    perCredential(false),
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cacheUsage, setCacheUsage] = useState<CacheStats | null>(null);
  const [cacheErrorMessage, setCacheErrorMessage] = useState<string | null>(
    null,
  );
  const [isCachePending, setIsCachePending] = useState(false);
  const [defaultProvider, setDefaultProvider] = useState<ProviderId>(
    () => loadPreferences().defaultProvider,
  );
  const operationGenerationsRef = useRef(perCredential(0));
  const pendingOperationsRef = useRef<Record<CredentialKind, number | null>>(
    perCredential(null),
  );
  const statusGenerationsRef = useRef(perCredential(0));
  const statusRequestGenerationRef = useRef(0);
  const cacheRequestGenerationRef = useRef(0);

  const isCurrentOperation = (kind: CredentialKind, generation: number) =>
    operationGenerationsRef.current[kind] === generation &&
    pendingOperationsRef.current[kind] === generation;

  const beginOperation = (kind: CredentialKind): number | null => {
    if (pendingOperationsRef.current[kind] !== null) {
      return null;
    }

    const generation = operationGenerationsRef.current[kind] + 1;
    operationGenerationsRef.current[kind] = generation;
    pendingOperationsRef.current[kind] = generation;
    statusGenerationsRef.current[kind] += 1;
    setPendingByKind((current) => ({ ...current, [kind]: true }));
    return generation;
  };

  const finishOperation = (kind: CredentialKind, generation: number) => {
    if (!isCurrentOperation(kind, generation)) {
      return;
    }
    pendingOperationsRef.current[kind] = null;
    setPendingByKind((current) => ({ ...current, [kind]: false }));
  };

  useEffect(() => {
    if (!open) {
      setInputs(EMPTY_INPUTS);
      setErrorMessage(null);
      return;
    }

    let active = true;
    const requestGeneration = statusRequestGenerationRef.current + 1;
    statusRequestGenerationRef.current = requestGeneration;
    const statusGenerations = perCredential(0);
    const operationGenerations = { ...operationGenerationsRef.current };
    const wasPending = perCredential(false);
    for (const { kind } of CREDENTIAL_FIELDS) {
      const statusGeneration = statusGenerationsRef.current[kind] + 1;
      statusGenerationsRef.current[kind] = statusGeneration;
      statusGenerations[kind] = statusGeneration;
      wasPending[kind] = pendingOperationsRef.current[kind] !== null;
    }
    const isCurrentStatusFor = (kind: CredentialKind) =>
      active &&
      statusRequestGenerationRef.current === requestGeneration &&
      !wasPending[kind] &&
      pendingOperationsRef.current[kind] === null &&
      operationGenerationsRef.current[kind] === operationGenerations[kind] &&
      statusGenerationsRef.current[kind] === statusGenerations[kind];
    setErrorMessage(null);
    void credentialStatuses()
      .then((nextSummaries) => {
        if (
          !CREDENTIAL_FIELDS.some(({ kind }) => isCurrentStatusFor(kind))
        ) {
          return;
        }
        setSummaries((current) => {
          const next = { ...current };
          for (const summary of nextSummaries) {
            const { kind } = summary;
            if (isCurrentStatusFor(kind)) {
              next[kind] = summary;
            }
          }
          return next;
        });
      })
      .catch(() => {
        if (CREDENTIAL_FIELDS.every(({ kind }) => isCurrentStatusFor(kind))) {
          setErrorMessage("无法读取凭据状态。");
        }
      });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setCacheErrorMessage(null);
      return;
    }

    let active = true;
    const generation = cacheRequestGenerationRef.current + 1;
    cacheRequestGenerationRef.current = generation;
    setIsCachePending(true);
    setCacheErrorMessage(null);
    void cacheStats()
      .then((usage) => {
        if (active && cacheRequestGenerationRef.current === generation) {
          setCacheUsage(usage);
        }
      })
      .catch(() => {
        if (active && cacheRequestGenerationRef.current === generation) {
          setCacheErrorMessage("无法读取缓存状态。");
        }
      })
      .finally(() => {
        if (active && cacheRequestGenerationRef.current === generation) {
          setIsCachePending(false);
        }
      });
    return () => {
      active = false;
    };
  }, [open]);

  const close = () => {
    setInputs(EMPTY_INPUTS);
    setErrorMessage(null);
    onClose();
  };

  const clearTranslationCache = async () => {
    if (
      isCachePending ||
      !window.confirm("确定清空本地翻译缓存吗？此操作无法撤销。")
    ) {
      return;
    }

    const generation = cacheRequestGenerationRef.current + 1;
    cacheRequestGenerationRef.current = generation;
    setIsCachePending(true);
    setCacheErrorMessage(null);
    try {
      await clearCache();
      const usage = await cacheStats();
      if (cacheRequestGenerationRef.current === generation) {
        setCacheUsage(usage);
      }
    } catch {
      if (cacheRequestGenerationRef.current === generation) {
        setCacheErrorMessage("无法清空缓存，请稍后重试。");
      }
    } finally {
      if (cacheRequestGenerationRef.current === generation) {
        setIsCachePending(false);
      }
    }
  };

  const save = async (kind: CredentialKind) => {
    const value = inputs[kind];
    if (value.trim().length === 0) {
      setErrorMessage("凭据不能为空。");
      return;
    }

    const generation = beginOperation(kind);
    if (generation === null) {
      return;
    }
    setErrorMessage(null);
    try {
      const summary = await saveCredential(kind, value);
      if (isCurrentOperation(kind, generation)) {
        setInputs((current) => ({ ...current, [kind]: "" }));
        setSummaries((current) => ({ ...current, [kind]: summary }));
      }
    } catch {
      if (isCurrentOperation(kind, generation)) {
        setErrorMessage("保存失败，请检查后重试。");
      }
    } finally {
      finishOperation(kind, generation);
    }
  };

  const remove = async (kind: CredentialKind) => {
    const generation = beginOperation(kind);
    if (generation === null) {
      return;
    }
    setErrorMessage(null);
    try {
      const summary = await deleteCredential(kind);
      if (isCurrentOperation(kind, generation)) {
        setInputs((current) => ({ ...current, [kind]: "" }));
        setSummaries((current) => ({ ...current, [kind]: summary }));
      }
    } catch {
      if (isCurrentOperation(kind, generation)) {
        setErrorMessage("删除失败，请稍后重试。");
      }
    } finally {
      finishOperation(kind, generation);
    }
  };

  if (!open) {
    return null;
  }

  return (
    <div className="settingsBackdrop">
      <section
        className="settingsDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="settingsDialogHeader">
          <h2 id="settings-title">设置</h2>
          <button type="button" aria-label="关闭设置" onClick={close}>
            ×
          </button>
        </header>

        <label className="settingsProviderField">
          <span>默认翻译服务</span>
          <select
            value={provider ?? defaultProvider}
            onChange={(event) => {
              const nextProvider = event.currentTarget.value as ProviderId;
              if (onProviderChange) {
                onProviderChange(nextProvider);
              } else {
                saveDefaultProvider(nextProvider);
                setDefaultProvider(nextProvider);
              }
            }}
          >
            <option value="deepseek">DeepSeek V4 Flash</option>
            <option value="youdao">Youdao</option>
          </select>
        </label>

        <section className="cacheSettings" aria-labelledby="cache-settings-title">
          <h3 id="cache-settings-title">翻译缓存</h3>
          <p className="cacheUsage" aria-live="polite">
            {cacheUsage
              ? `${cacheUsage.rowCount} 条 · ${formatBytes(cacheUsage.databaseBytes)}`
              : isCachePending
                ? "正在读取缓存用量…"
                : "暂无缓存用量。"}
          </p>
          <button
            type="button"
            disabled={isCachePending}
            onClick={() => void clearTranslationCache()}
          >
            清空翻译缓存
          </button>
          {cacheErrorMessage && (
            <p className="cacheError" role="alert">
              {cacheErrorMessage}
            </p>
          )}
        </section>

        <div className="credentialSettings">
          {CREDENTIAL_FIELDS.map((field) => {
            const summary = summaries[field.kind];
            const configured = summary?.configured === true;
            const isPending = pendingByKind[field.kind];
            return (
              <section className="credentialField" key={field.kind}>
                <label>
                  <span>{field.inputLabel}</span>
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={isPending}
                    value={inputs[field.kind]}
                    onChange={(event) => {
                      if (pendingOperationsRef.current[field.kind] !== null) {
                        return;
                      }
                      const value = event.currentTarget.value;
                      setInputs((current) => ({
                        ...current,
                        [field.kind]: value,
                      }));
                    }}
                  />
                </label>
                <div className="credentialStatus" aria-live="polite">
                  {configured ? (
                    <>
                      <span>已配置</span>
                      <span>{summary.maskedHint}</span>
                    </>
                  ) : (
                    <span>未配置</span>
                  )}
                </div>
                <div className="credentialActions">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => void save(field.kind)}
                  >
                    {configured ? "替换" : "保存"} {field.actionLabel}
                  </button>
                  {configured && (
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => void remove(field.kind)}
                    >
                      删除 {field.actionLabel}
                    </button>
                  )}
                </div>
              </section>
            );
          })}
        </div>

        {errorMessage && <p role="alert">{errorMessage}</p>}
      </section>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
