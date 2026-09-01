import { ERROR_COPY } from "./errors";
import type { Provider } from "./schemas";
import type { TranslationViewState } from "./useTranslationController";

const PROVIDER_LABEL: Record<Provider, string> = {
  deepseek: "DeepSeek V4 Flash",
  youdao: "Youdao",
};

type TranslationPanelProps = {
  state: TranslationViewState;
  provider: Provider;
  onProviderChange(provider: Provider): void;
  onRetry(): void;
  onCancel(): void;
  onOpenSettings(): void;
};

export function TranslationPanel({
  state,
  provider,
  onProviderChange,
  onRetry,
  onCancel,
  onOpenSettings,
}: TranslationPanelProps) {
  return (
    <div className="translationPanelContent">
      <label className="translationProviderField">
        <span>当前翻译服务</span>
        <select
          value={provider}
          onChange={(event) =>
            onProviderChange(event.currentTarget.value as Provider)
          }
        >
          <option value="deepseek">{PROVIDER_LABEL.deepseek}</option>
          <option value="youdao">{PROVIDER_LABEL.youdao}</option>
        </select>
      </label>

      {state.status === "idle" && (
        <p className="translationPanelPlaceholder">
          选择 PDF 文本后，手动触发翻译。
        </p>
      )}

      {state.status === "loading" && (
        <section className="translationLoading" aria-live="polite">
          <p role="status">正在翻译…</p>
          <button type="button" onClick={onCancel} aria-label="取消翻译">
            取消
          </button>
        </section>
      )}

      {state.status === "success" && (
        <section className="translationResult">
          <div className="translationMetadata">
            <span>{PROVIDER_LABEL[state.result.provider]}</span>
            <span>{state.result.modelId}</span>
            {state.result.cacheHit && <span>来自本地缓存</span>}
          </div>
          <section aria-labelledby="translation-source-title">
            <h3 id="translation-source-title">原文</h3>
            <p className="translationText">{state.result.normalizedSource}</p>
          </section>
          <section aria-labelledby="translation-result-title">
            <h3 id="translation-result-title">简体中文</h3>
            <p className="translationText">{state.result.translation}</p>
          </section>
          {state.result.diagnostics.includes("cache_unavailable") && (
            <p
              className="translationWarning"
              role="status"
              aria-label="缓存状态"
            >
              {ERROR_COPY.CACHE_UNAVAILABLE}
            </p>
          )}
          <div className="translationActions">
            <button
              type="button"
              onClick={() => {
                void window.navigator.clipboard
                  .writeText(state.result.translation)
                  .catch(() => undefined);
              }}
            >
              复制译文
            </button>
            <button type="button" onClick={onRetry}>
              重试
            </button>
          </div>
        </section>
      )}

      {state.status === "error" && (
        <section className="translationError">
          <p role="alert">{ERROR_COPY[state.error.code]}</p>
          <div className="translationActions">
            {(state.error.code === "CREDENTIALS_MISSING" ||
              state.error.code === "AUTH_INVALID") && (
              <button type="button" onClick={onOpenSettings}>
                打开设置
              </button>
            )}
            {state.error.retryable && (
              <button type="button" onClick={onRetry}>
                重试
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
