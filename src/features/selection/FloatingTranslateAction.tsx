import type { SelectionFragment } from "./types";

type FloatingTranslateActionProps = {
  fragments: SelectionFragment[];
  onTranslate(fragments: SelectionFragment[]): void;
};

export function FloatingTranslateAction({
  fragments,
  onTranslate,
}: FloatingTranslateActionProps) {
  if (fragments.length === 0) {
    return null;
  }

  return (
    <button
      type="button"
      className="floatingTranslateAction"
      aria-label="翻译所选文本"
      onClick={() => onTranslate(fragments)}
    >
      翻译
    </button>
  );
}
