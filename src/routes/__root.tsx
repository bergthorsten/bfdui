import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { Activity } from "react";
import OnboardingGate from "@/components/onboarding-wizard";
import { inDevelopment } from "@/constants";
import BaseLayout from "@/layouts/base-layout";

function Root() {
  return (
    <BaseLayout>
      <OnboardingGate>
        <Outlet />
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
