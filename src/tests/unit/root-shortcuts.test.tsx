import { render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { APP_EVENTS } from "@/constants";
import { Route } from "@/routes/__root";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async () => {
  const React = await import("react");

  return {
    Outlet: () => React.createElement("div", null, "outlet"),
    createRootRoute: (options: unknown) => ({ options }),
    useNavigate: () => navigate,
  };
});

vi.mock("@tanstack/react-router-devtools", () => ({
  TanStackRouterDevtools: () => null,
}));

vi.mock("@/components/onboarding-wizard", async () => {
  const React = await import("react");

  return {
    default: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("@/components/app-header", () => ({
  default: () => null,
}));

vi.mock("@/components/deployment-history-launcher", () => ({
  default: () => null,
}));

const Root = (Route as unknown as { options: { component: () => JSX.Element } })
  .options.component;

afterEach(() => {
  vi.clearAllMocks();
});

test("navigates with Cmd+1, Cmd+2, and Cmd+comma", () => {
  render(<Root />);

  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "1", metaKey: true })
  );
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "2", metaKey: true })
  );
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: ",", metaKey: true })
  );

  expect(navigate).toHaveBeenNthCalledWith(1, { to: "/" });
  expect(navigate).toHaveBeenNthCalledWith(2, { to: "/systems" });
  expect(navigate).toHaveBeenNthCalledWith(3, { to: "/settings" });
});

test("opens deployment history with Cmd+3", () => {
  const onOpenDeploymentHistory = vi.fn();
  window.addEventListener(
    APP_EVENTS.OPEN_DEPLOYMENT_HISTORY,
    onOpenDeploymentHistory
  );

  render(<Root />);
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "3", metaKey: true })
  );

  expect(onOpenDeploymentHistory).toHaveBeenCalledTimes(1);
  expect(navigate).not.toHaveBeenCalled();

  window.removeEventListener(
    APP_EVENTS.OPEN_DEPLOYMENT_HISTORY,
    onOpenDeploymentHistory
  );
});
