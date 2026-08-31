import { render, screen } from "@testing-library/react";
import { App } from "./App";

test("renders only the approved shell regions and translation-panel control", () => {
  render(<App />);

  expect(screen.getByRole("toolbar", { name: "论文阅读工具" })).toBeVisible();
  expect(screen.getByLabelText("PDF 工具栏")).toBeVisible();
  expect(screen.getByRole("main", { name: "PDF 阅读区" })).toBeVisible();
  expect(screen.getByRole("complementary", { name: "翻译面板" })).toBeVisible();
  expect(screen.getByRole("status", { name: "阅读状态" })).toBeVisible();

  expect(screen.getByRole("button", { name: "收起翻译面板" })).toBeVisible();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(
    screen.queryByRole("button", { name: /打开 PDF|缩小|放大|设置|阅读模式/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/聊天|笔记|OCR/)).not.toBeInTheDocument();
});
