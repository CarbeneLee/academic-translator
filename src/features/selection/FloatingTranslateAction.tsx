import type { SelectionFragment } from "./types";
import type { FloatingActionPosition } from "./floatingActionPosition";

type FloatingTranslateActionProps = {
  fragments: SelectionFragment[];
  position: FloatingActionPosition;
  onTranslate(fragments: SelectionFragment[]): void;
  disabled?: boolean;
};

export function FloatingTranslateAction({
  fragments,
  position,
  onTranslate,
  disabled = false,
}: FloatingTranslateActionProps) {
  if (fragments.length === 0) {
    return null;
  }

  return (
    <button
      type="button"
      className="floatingTranslateAction"
      aria-label="翻译所选文本"
      style={position}
      disabled={disabled}
      onClick={() => onTranslate(fragments)}
    >
      翻译
    </button>
  );
}
