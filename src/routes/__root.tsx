import { createRootRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { Activity, useEffect } from "react";
import DeploymentHistoryLauncher from "@/components/deployment-history-launcher";
import OnboardingGate from "@/components/onboarding-wizard";
import { APP_EVENTS, inDevelopment } from "@/constants";
import BaseLayout from "@/layouts/base-layout";

function AppKeyboardShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) {
        return;
      }

      switch (event.key) {
        case "1":
          event.preventDefault();
          navigate({ to: "/" });
          break;
        case "2":
          event.preventDefault();
          navigate({ to: "/systems" });
          break;
        case "3":
          event.preventDefault();
          window.dispatchEvent(new Event(APP_EVENTS.OPEN_DEPLOYMENT_HISTORY));
          break;
        case ",":
          event.preventDefault();
          navigate({ to: "/settings" });
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return null;
}

function Root() {
  return (
    <BaseLayout>
      <AppKeyboardShortcuts />
      <OnboardingGate>
        <Outlet />
        <DeploymentHistoryLauncher />
      </OnboardingGate>
      <Activity mode={inDevelopment ? "visible" : "hidden"}>
        <TanStackRouterDevtools />
      </Activity>
    </BaseLayout>
  );
}

export const Route = createRootRoute({
  component: Root,
});
