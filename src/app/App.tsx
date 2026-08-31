import { useState } from "react";
import {
  PdfDocumentToolbar,
  PdfWorkspace,
  usePdfWorkspaceController,
} from "../features/pdf-viewer/PdfWorkspace";
import "./App.css";

const handleTranslateSelection = () => undefined;

export function App() {
  const [isTranslationPanelCollapsed, setIsTranslationPanelCollapsed] =
    useState(false);
  const pdfWorkspace = usePdfWorkspaceController();

  return (
    <div
      className={`appShell${isTranslationPanelCollapsed ? " appShell--panelCollapsed" : ""}`}
    >
      <header className="topToolbar" role="toolbar" aria-label="论文阅读工具">
        <PdfDocumentToolbar controller={pdfWorkspace} />
      </header>

      <nav className="toolRail" aria-label="PDF 工具栏" />

      <main className="pdfWorkspace" aria-label="PDF 阅读区">
        <PdfWorkspace
          controller={pdfWorkspace}
          onTranslate={handleTranslateSelection}
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
          <p className="translationPanelPlaceholder">选择 PDF 文本后可在此查看翻译。</p>
        )}
      </aside>

      <div id="settings-dialog-root" className="settingsDialogRoot" />
      <footer className="statusBar" role="status" aria-label="阅读状态">
        {pdfWorkspace.status}
      </footer>
    </div>
  );
}
