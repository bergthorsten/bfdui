import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  checkBfdEnvironment,
  getBfdConfig,
  saveBfdConfig,
  testBfdConnection,
} from "@/actions/bfd";
import OnboardingGate from "@/components/onboarding-wizard";
import type {
  AppConfig,
  EnvironmentToolCheck,
  EnvironmentToolStatus,
  SecretStatus,
} from "@/types/bfd";

vi.mock("@/actions/bfd", () => ({
  checkBfdEnvironment: vi.fn(),
  getBfdConfig: vi.fn(),
  saveBfdConfig: vi.fn(),
  testBfdConnection: vi.fn(),
}));

vi.mock("@/actions/shell", () => ({
  openExternalLink: vi.fn(),
}));

const CONTINUE_TO_ACCOUNTS = /continue to accounts/i;
const SECRETS_STAY_LOCAL = /secrets stay local/i;

const baseConfig: AppConfig = {
  argo: {
    app: "shop",
    devContext: "dev",
  },
  github: {
    owner: "bergfreunde",
    repo: "shop",
    useGhCli: true,
  },
  jira: {
    baseUrl: "https://jirabergfreunde.atlassian.net",
    email: "",
    project: "PC",
    sprintJql: "sprint in openSprints() AND project = PC ORDER BY rank ASC",
  },
  onboardingComplete: false,
  repoPath: "~/devenv/src",
};

const emptySecrets: SecretStatus = {
  githubToken: false,
  jiraToken: false,
};

type EnvironmentToolChecks = [
  EnvironmentToolCheck,
  EnvironmentToolCheck,
  EnvironmentToolCheck,
];

function tool(
  name: EnvironmentToolCheck["name"],
  status: EnvironmentToolStatus
): EnvironmentToolCheck {
  return {
    authCommand: `${name} auth`,
    command: `${name} check`,
    installCommand: `install ${name}`,
    label: `${name} CLI`,
    message: `${name} is ${status}`,
    name,
    status,
  };
}

function renderOnboarding({
  config = baseConfig,
  secrets = emptySecrets,
  strictMode = false,
  tools = [
    tool("gh", "missing"),
    tool("argocd", "missing"),
    tool("kubectl", "missing"),
  ],
}: {
  config?: AppConfig;
  secrets?: SecretStatus;
  strictMode?: boolean;
  tools?: EnvironmentToolChecks;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  vi.mocked(getBfdConfig).mockResolvedValue({ config, secrets });
  vi.mocked(checkBfdEnvironment).mockResolvedValue({ checkedAt: 1, tools });
  vi.mocked(saveBfdConfig).mockResolvedValue({ config, secrets });
  vi.mocked(testBfdConnection).mockImplementation(async (kind) => ({
    ok: true,
    message: `${kind} ok`,
  }));

  const ui = (
    <QueryClientProvider client={queryClient}>
      <OnboardingGate>
        <div>Dashboard</div>
      </OnboardingGate>
    </QueryClientProvider>
  );

  return render(strictMode ? <StrictMode>{ui}</StrictMode> : ui);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

test("shows the onboarding as two full-width screens without a stepper", async () => {
  const user = userEvent.setup();

  renderOnboarding();

  expect(
    await screen.findByRole("heading", { name: "System check & workspace" })
  ).toBeInTheDocument();
  expect(screen.getByText("Screen 1 of 2")).toBeInTheDocument();
  expect(
    screen.queryByRole("navigation", { name: "Onboarding steps" })
  ).not.toBeInTheDocument();
  expect(screen.queryByText(SECRETS_STAY_LOCAL)).not.toBeInTheDocument();
  expect(screen.getByText("~/devenv/src")).toBeInTheDocument();
  expect(screen.queryByText("~/devenv/src/shop")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: CONTINUE_TO_ACCOUNTS }));

  expect(
    screen.getByRole("heading", { name: "Accounts & ready check" })
  ).toBeInTheDocument();
  expect(screen.getByText("Screen 2 of 2")).toBeInTheDocument();
});

test("automatically tests tool-backed connections when CLIs are ready", async () => {
  renderOnboarding({
    tools: [tool("gh", "ok"), tool("argocd", "ok"), tool("kubectl", "ok")],
  });

  await screen.findByRole("heading", { name: "System check & workspace" });

  await waitFor(() => {
    expect(testBfdConnection).toHaveBeenCalledWith(
      "github",
      expect.objectContaining({ config: baseConfig })
    );
    expect(testBfdConnection).toHaveBeenCalledWith(
      "argo",
      expect.objectContaining({ config: baseConfig })
    );
  });
  expect(testBfdConnection).not.toHaveBeenCalledWith("jira", expect.anything());
  expect(testBfdConnection).not.toHaveBeenCalledWith("repo", expect.anything());
});

test("automatic tool checks are not lost under React StrictMode", async () => {
  renderOnboarding({
    strictMode: true,
    tools: [tool("gh", "ok"), tool("argocd", "ok"), tool("kubectl", "ok")],
  });

  await screen.findByRole("heading", { name: "System check & workspace" });

  await waitFor(() => {
    expect(testBfdConnection).toHaveBeenCalledWith(
      "github",
      expect.objectContaining({ config: baseConfig })
    );
    expect(testBfdConnection).toHaveBeenCalledWith(
      "argo",
      expect.objectContaining({ config: baseConfig })
    );
  });
});

test("does not auto-test when required tools still need attention", async () => {
  renderOnboarding({
    tools: [
      tool("gh", "warning"),
      tool("argocd", "ok"),
      tool("kubectl", "missing"),
    ],
  });

  expect(await screen.findByText("gh is warning")).toBeInTheDocument();
  expect(screen.getByText("kubectl is missing")).toBeInTheDocument();
  expect(testBfdConnection).not.toHaveBeenCalled();
});

test("manual workspace test buttons run their targeted checks", async () => {
  const user = userEvent.setup();

  renderOnboarding();

  await screen.findByRole("heading", { name: "System check & workspace" });

  await user.click(screen.getByRole("button", { name: "Test ArgoCD" }));

  await waitFor(() => {
    expect(testBfdConnection).toHaveBeenCalledWith(
      "argo",
      expect.objectContaining({ config: baseConfig })
    );
  });
  expect(await screen.findByText("argo ok")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Test path" }));

  await waitFor(() => {
    expect(testBfdConnection).toHaveBeenCalledWith(
      "repo",
      expect.objectContaining({ config: baseConfig })
    );
  });
  expect(await screen.findByText("repo ok")).toBeInTheDocument();
});

test("manual account test buttons run their targeted checks", async () => {
  const user = userEvent.setup();

  renderOnboarding();

  await screen.findByRole("heading", { name: "System check & workspace" });
  await user.click(screen.getByRole("button", { name: CONTINUE_TO_ACCOUNTS }));

  await user.click(screen.getByRole("button", { name: "Test Jira" }));

  await waitFor(() => {
    expect(testBfdConnection).toHaveBeenCalledWith(
      "jira",
      expect.objectContaining({ config: baseConfig })
    );
  });
  await waitFor(() => {
    expect(screen.getAllByText("jira ok").length).toBeGreaterThan(0);
  });

  await user.click(screen.getByRole("button", { name: "Test GitHub" }));

  await waitFor(() => {
    expect(testBfdConnection).toHaveBeenCalledWith(
      "github",
      expect.objectContaining({ config: baseConfig })
    );
  });
  await waitFor(() => {
    expect(screen.getAllByText("github ok").length).toBeGreaterThan(0);
  });
});

test("failed manual tests render as red results", async () => {
  const user = userEvent.setup();

  renderOnboarding();

  await screen.findByRole("heading", { name: "System check & workspace" });
  await user.click(screen.getByRole("button", { name: CONTINUE_TO_ACCOUNTS }));

  vi.mocked(testBfdConnection).mockResolvedValueOnce({
    ok: false,
    message: "No Jira email configured.",
  });

  await user.click(screen.getByRole("button", { name: "Test Jira" }));

  const result = await screen.findByTestId("connection-result-jira");
  expect(result).toHaveTextContent("No Jira email configured.");
  expect(result).toHaveClass("border-red-500/30");
});

test("manual test results still render under React StrictMode", async () => {
  const user = userEvent.setup();

  renderOnboarding({ strictMode: true });

  await screen.findByRole("heading", { name: "System check & workspace" });
  await user.click(screen.getByRole("button", { name: "Test path" }));

  await waitFor(() => {
    expect(testBfdConnection).toHaveBeenCalledWith(
      "repo",
      expect.objectContaining({ config: baseConfig })
    );
  });
  expect(await screen.findByTestId("connection-result-repo")).toHaveTextContent(
    "repo ok"
  );
});
