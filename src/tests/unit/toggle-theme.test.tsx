import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { toggleTheme } from "@/actions/theme";
import ThemeToggle from "@/components/theme-toggle";

vi.mock("@/actions/theme", () => ({
  toggleTheme: vi.fn(),
}));

test("toggles the theme through the app header button", async () => {
  const user = userEvent.setup();

  render(<ThemeToggle />);
  await user.click(screen.getByRole("button", { name: "Toggle theme" }));

  expect(toggleTheme).toHaveBeenCalledTimes(1);
});
