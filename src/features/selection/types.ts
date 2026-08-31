export type TextPosition = {
  textItemIndex: number;
  offset: number;
};

export type SelectionSpan = {
  pageIndex: number;
  start: TextPosition;
  end: TextPosition;
  text: string;
};

export type SelectionFragment = {
  id: string;
  documentSessionId: string;
  order: number;
  text: string;
  spans: SelectionSpan[];
};

export type SelectionState = {
  fragments: SelectionFragment[];
};
