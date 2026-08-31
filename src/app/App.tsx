import { useState } from "react";
import "./App.css";

export function App() {
  const [isTranslationPanelCollapsed, setIsTranslationPanelCollapsed] =
    useState(false);

  return (
    <div
      className={`appShell${isTranslationPanelCollapsed ? " appShell--panelCollapsed" : ""}`}
    >
      <header className="topToolbar" role="toolbar" aria-label="论文阅读工具" />

      <nav className="toolRail" aria-label="PDF 工具栏" />

      <main className="pdfWorkspace" aria-label="PDF 阅读区">
        <div className="emptyDocumentState">
          <p>打开本地 PDF 开始阅读</p>
        </div>
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
        准备就绪
      </footer>
    </div>
  );
}
