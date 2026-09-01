import { useEffect, useState } from "react";
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

function summariesByKind(
  summaries: CredentialSummary[],
): Partial<Record<CredentialKind, CredentialSummary>> {
  return Object.fromEntries(
    summaries.map((summary) => [summary.kind, summary]),
  );
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
  const [pendingKind, setPendingKind] = useState<CredentialKind | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [defaultProvider, setDefaultProvider] = useState<ProviderId>(
    () => loadPreferences().defaultProvider,
  );

  useEffect(() => {
    if (!open) {
      setInputs(EMPTY_INPUTS);
      setPendingKind(null);
      setErrorMessage(null);
      return;
    }

    let active = true;
    setErrorMessage(null);
    void credentialStatuses()
      .then((nextSummaries) => {
        if (active) {
          setSummaries(summariesByKind(nextSummaries));
        }
      })
      .catch(() => {
        if (active) {
          setErrorMessage("无法读取凭据状态。");
        }
      });
    return () => {
      active = false;
    };
  }, [open]);

  const close = () => {
    setInputs(EMPTY_INPUTS);
    setPendingKind(null);
    setErrorMessage(null);
    onClose();
  };

  const save = async (kind: CredentialKind) => {
    const value = inputs[kind];
    if (value.trim().length === 0) {
      setErrorMessage("凭据不能为空。");
      return;
    }

    setPendingKind(kind);
    setErrorMessage(null);
    try {
      const summary = await saveCredential(kind, value);
      setInputs((current) => ({ ...current, [kind]: "" }));
      setSummaries((current) => ({ ...current, [kind]: summary }));
    } catch {
      setErrorMessage("保存失败，请检查后重试。");
    } finally {
      setPendingKind(null);
    }
  };

  const remove = async (kind: CredentialKind) => {
    setPendingKind(kind);
    setErrorMessage(null);
    try {
      const summary = await deleteCredential(kind);
      setInputs((current) => ({ ...current, [kind]: "" }));
      setSummaries((current) => ({ ...current, [kind]: summary }));
    } catch {
      setErrorMessage("删除失败，请稍后重试。");
    } finally {
      setPendingKind(null);
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
            const isPending = pendingKind === field.kind;
            return (
              <section className="credentialField" key={field.kind}>
                <label>
                  <span>{field.inputLabel}</span>
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={inputs[field.kind]}
                    onChange={(event) => {
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
