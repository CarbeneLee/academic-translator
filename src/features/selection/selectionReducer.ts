import type { SelectionFragment, SelectionState } from "./types";

export type SelectionAction =
  | {
      type: "capture";
      fragment: SelectionFragment;
      additive: boolean;
    }
  | { type: "clear" };

export const emptySelectionState: SelectionState = { fragments: [] };

export function selectionReducer(
  state: SelectionState,
  action: SelectionAction,
): SelectionState {
  if (action.type === "clear") {
    return emptySelectionState;
  }

  return {
    fragments: action.additive
      ? [...state.fragments, action.fragment]
      : [action.fragment],
  };
}
