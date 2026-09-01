import { useEffect, useRef, useState } from "react";
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
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [inputs, setInputs] = useState(EMPTY_INPUTS);
  const [summaries, setSummaries] = useState<
    Partial<Record<CredentialKind, CredentialSummary>>
  >({});
  const [pendingByKind, setPendingByKind] = useState(() =>
    perCredential(false),
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [defaultProvider, setDefaultProvider] = useState<ProviderId>(
    () => loadPreferences().defaultProvider,
  );
  const operationGenerationsRef = useRef(perCredential(0));
  const pendingOperationsRef = useRef<Record<CredentialKind, number | null>>(
    perCredential(null),
  );
  const statusGenerationsRef = useRef(perCredential(0));
  const statusRequestGenerationRef = useRef(0);

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

  const close = () => {
    setInputs(EMPTY_INPUTS);
    setErrorMessage(null);
    onClose();
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
            value={defaultProvider}
            onChange={(event) => {
              const provider = event.currentTarget.value as ProviderId;
              saveDefaultProvider(provider);
              setDefaultProvider(provider);
            }}
          >
            <option value="deepseek">DeepSeek V4 Flash</option>
            <option value="youdao">Youdao</option>
          </select>
        </label>

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
