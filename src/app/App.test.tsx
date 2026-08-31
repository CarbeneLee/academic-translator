import { render, screen } from "@testing-library/react";
import { App } from "./App";

test("renders the approved reader regions without post-MVP placeholders", () => {
  render(<App />);

  expect(screen.getByRole("toolbar", { name: "论文阅读工具" })).toBeVisible();
  expect(screen.getByLabelText("PDF 工具栏")).toBeVisible();
  expect(screen.getByRole("main", { name: "PDF 阅读区" })).toBeVisible();
  expect(screen.getByRole("complementary", { name: "翻译面板" })).toBeVisible();
  expect(screen.queryByText(/聊天|笔记|OCR/)).not.toBeInTheDocument();
});
