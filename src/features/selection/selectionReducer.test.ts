import { selectionReducer } from "./selectionReducer";
import type { SelectionFragment } from "./types";

function fragment(text: string, order: number): SelectionFragment {
  return {
    id: `fragment-${order}-${text}`,
    documentSessionId: "document-session-1",
    order,
    text,
    spans: [
      {
        pageIndex: order,
        start: { textItemIndex: 0, offset: 0 },
        end: { textItemIndex: 0, offset: text.length },
        text,
      },
    ],
  };
}

test("normal capture replaces while Alt capture appends in user order", () => {
  let state = selectionReducer(
    { fragments: [fragment("old", 0)] },
    {
      type: "capture",
      fragment: fragment("new", 0),
      additive: false,
    },
  );
  expect(state.fragments.map((item) => item.text)).toEqual(["new"]);

  state = selectionReducer(state, {
    type: "capture",
    fragment: fragment("later", 1),
    additive: true,
  });
  expect(state.fragments.map((item) => item.text)).toEqual(["new", "later"]);
  expect(state.fragments.map((item) => item.order)).toEqual([0, 1]);
});

test("document replacement and Escape clear fragment state", () => {
  expect(
    selectionReducer({ fragments: [fragment("x", 0)] }, { type: "clear" }),
  ).toEqual({ fragments: [] });
});
