import { useCallback, useRef, useState } from "react";
import {
  PdfDocumentToolbar,
  PdfWorkspace,
  usePdfWorkspaceController,
} from "../features/pdf-viewer/PdfWorkspace";
import { SettingsDialog } from "../features/settings/SettingsDialog";
import {
  loadPreferences,
  saveDefaultProvider,
} from "../features/settings/preferences";
import type { SelectionFragment } from "../features/selection/types";
import { TranslationPanel } from "../features/translation/TranslationPanel";
import type { Provider } from "../features/translation/schemas";
import { useTranslationController } from "../features/translation/useTranslationController";
import "./App.css";

export function App() {
  const [isTranslationPanelCollapsed, setIsTranslationPanelCollapsed] =
    useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>(
    () => loadPreferences().defaultProvider,
  );
  const [documentSessionId, setDocumentSessionId] = useState<string | null>(
    null,
  );
  const [fragments, setFragments] = useState<SelectionFragment[]>([]);
  const translation = useTranslationController({
    documentSessionId,
    provider,
    fragments,
  });
  const cancelTranslationRef = useRef(translation.cancelForLifecycle);
  cancelTranslationRef.current = translation.cancelForLifecycle;

  const handleDocumentSessionChange = useCallback(
    (nextDocumentSessionId: string | null) => {
      cancelTranslationRef.current();
      setFragments([]);
      setDocumentSessionId(nextDocumentSessionId);
    },
    [],
  );
  const pdfWorkspace = usePdfWorkspaceController({
    onDocumentSessionChange: handleDocumentSessionChange,
  });

  const changeProvider = useCallback(
    (nextProvider: Provider) => {
      translation.cancelForLifecycle();
      saveDefaultProvider(nextProvider);
      setProvider(nextProvider);
    },
    [translation.cancelForLifecycle],
  );

  return (
    <div
      className={`appShell${isTranslationPanelCollapsed ? " appShell--panelCollapsed" : ""}`}
    >
      <header className="topToolbar" role="toolbar" aria-label="论文阅读工具">
        <PdfDocumentToolbar controller={pdfWorkspace} />
        <button
          type="button"
          aria-label="设置"
          className="settingsEntry"
          onClick={() => setIsSettingsOpen(true)}
        >
          设置
        </button>
      </header>

      <nav className="toolRail" aria-label="PDF 工具栏" />

      <main className="pdfWorkspace" aria-label="PDF 阅读区">
        <PdfWorkspace
          controller={pdfWorkspace}
          onTranslate={() => translation.trigger()}
          onSelectionChange={setFragments}
          onSelectionMutation={translation.cancelForLifecycle}
          isRequestActive={translation.isRequestActive}
          onCancelActiveRequest={translation.cancel}
        />
      </main>

      <aside
        className="translationPanel"
        aria-label="翻译面板"
        aria-expanded={!isTranslationPanelCollapsed}
      >
        <div className="translationPanelHeader">
          {!isTranslationPanelCollapsed && <span>翻译</span>}
          <button
            type="button"
            aria-label={isTranslationPanelCollapsed ? "展开翻译面板" : "收起翻译面板"}
            onClick={() => {
              setIsTranslationPanelCollapsed((value) => !value);
            }}
          >
            {isTranslationPanelCollapsed ? "‹" : "›"}
          </button>
        </div>
        {!isTranslationPanelCollapsed && (
          <TranslationPanel
            state={translation.state}
            provider={provider}
            onProviderChange={changeProvider}
            onRetry={translation.retry}
            onCancel={translation.cancel}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        )}
      </aside>

      <div id="settings-dialog-root" className="settingsDialogRoot">
        <SettingsDialog
          open={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          provider={provider}
          onProviderChange={changeProvider}
        />
      </div>
      <footer className="statusBar" role="status" aria-label="阅读状态">
        {pdfWorkspace.status}
      </footer>
    </div>
  );
}
