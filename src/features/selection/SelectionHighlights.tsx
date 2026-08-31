import type { HighlightRect } from "./highlightGeometry";

type SelectionHighlightsProps = {
  pageIndex: number;
  rectangles: readonly HighlightRect[];
};

export function SelectionHighlights({
  pageIndex,
  rectangles,
}: SelectionHighlightsProps) {
  return (
    <div className="selectionHighlights" aria-hidden="true">
      {rectangles.flatMap((rectangle, index) =>
        rectangle.pageIndex === pageIndex
          ? [
              <span
                key={`${rectangle.fragmentId}:${index}`}
                className="selectionHighlight"
                style={{
                  left: rectangle.x,
                  top: rectangle.y,
                  width: rectangle.width,
                  height: rectangle.height,
                }}
              />,
            ]
          : [],
      )}
    </div>
  );
}
