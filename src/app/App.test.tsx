import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";

test("renders the approved shell regions and functional PDF controls", async () => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: () => null },
  });
  const user = userEvent.setup();
  render(<App />);

  expect(screen.getByRole("toolbar", { name: "论文阅读工具" })).toBeVisible();
  expect(screen.getByLabelText("PDF 工具栏")).toBeVisible();
  expect(screen.getByRole("main", { name: "PDF 阅读区" })).toBeVisible();
  expect(screen.getByRole("complementary", { name: "翻译面板" })).toBeVisible();
  expect(screen.getByRole("status", { name: "阅读状态" })).toBeVisible();

  expect(screen.getByRole("button", { name: "收起翻译面板" })).toBeVisible();
  expect(screen.getByRole("button", { name: "打开 PDF" })).toBeVisible();
  const settingsButton = screen.getByRole("button", { name: "设置" });
  expect(settingsButton).toBeVisible();
  await user.click(settingsButton);
  expect(screen.getByRole("dialog", { name: "设置" })).toBeVisible();
  expect(screen.queryByText(/聊天|笔记|OCR/)).not.toBeInTheDocument();
});
