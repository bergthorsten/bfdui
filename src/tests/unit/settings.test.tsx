import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType, ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { getBfdConfig, saveBfdConfig, testBfdConnection } from "@/actions/bfd";
import { Route } from "@/routes/settings";
import type { AppConfig } from "@/types/bfd";

vi.mock("@tanstack/react-router", async () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock("@/actions/bfd", () => ({
  getBfdConfig: vi.fn(),
  saveBfdConfig: vi.fn(),
  testBfdConnection: vi.fn(),
}));

vi.mock("@/components/page-header", () => ({
  default: ({
    description,
    title,
  }: {
    description: ReactNode;
    title: string;
  }) => (
    <header>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  ),
}));

const Settings = (Route as unknown as { options: { component: ComponentType } })
  .options.component;

const SAVE_SETTINGS_PATTERN = /save settings/i;

const config: AppConfig = {
  argo: { app: "shop", devContext: "dev" },
  github: { owner: "bergfreunde", repo: "shop", useGhCli: false },
  jira: {
    baseUrl: "https://jira.example.com",
    email: "ada@example.com",
    project: "PC",
    sprintJql: "project = PC ORDER BY rank ASC",
  },
  onboardingComplete: false,
  repoPath: "/Users/ada/devenv/src",
};

function renderSettings() {
  return render(<Settings />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBfdConfig).mockResolvedValue({
    config,
    secrets: { githubToken: true, jiraToken: true },
  });
  vi.mocked(saveBfdConfig).mockResolvedValue({
    config: { ...config, onboardingComplete: true },
    secrets: { githubToken: true, jiraToken: true },
  });
  vi.mocked(testBfdConnection).mockResolvedValue({
    detail: "Ada Lovelace",
    message: "Connected.",
    ok: true,
  });
});

test("saves edited settings with new token values and marks onboarding complete", async () => {
  const user = userEvent.setup();
  renderSettings();

  await screen.findByDisplayValue("https://jira.example.com");
  const projectInput = screen.getByDisplayValue("PC");
  const jiraTokenInput = screen.getAllByPlaceholderText("Enter new token")[0];
  const ownerInput = screen.getByDisplayValue("bergfreunde");
  await user.clear(projectInput);
  await user.type(projectInput, "EXP");
  await user.type(jiraTokenInput, "new-jira-token");
  await user.clear(ownerInput);
  await user.type(ownerInput, "acme");

  await user.click(screen.getByRole("button", { name: SAVE_SETTINGS_PATTERN }));

  await waitFor(() => {
    expect(saveBfdConfig).toHaveBeenCalled();
  });
  expect(vi.mocked(saveBfdConfig).mock.calls[0]?.[0]).toMatchObject({
    config: {
      github: { owner: "acme" },
      jira: { project: "EXP" },
      onboardingComplete: true,
    },
    secrets: { jiraToken: "new-jira-token" },
  });
  expect(await screen.findByText("Settings saved.")).toBeInTheDocument();
});

test("shows save errors and clears stored Jira token explicitly", async () => {
  const user = userEvent.setup();
  renderSettings();

  expect(
    await screen.findAllByText(
      "Stored token is present. Leave empty to keep it."
    )
  ).toHaveLength(2);
  const clearButtons = screen.getAllByRole("button", { name: "Clear" });
  await user.click(clearButtons[0]);

  await waitFor(() => {
    expect(saveBfdConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        secrets: expect.objectContaining({ clearJiraToken: true }),
      })
    );
  });

  vi.mocked(saveBfdConfig).mockRejectedValueOnce(new Error("Disk full"));
  await user.click(screen.getByRole("button", { name: SAVE_SETTINGS_PATTERN }));

  expect(await screen.findByText("Disk full")).toBeInTheDocument();
});

test("tests connections with current draft config and token values", async () => {
  const user = userEvent.setup();
  renderSettings();

  await screen.findByDisplayValue("https://jira.example.com");
  await user.type(
    screen.getAllByPlaceholderText("Enter new token")[0],
    "draft-token"
  );
  await user.click(
    screen.getByRole("button", { name: "Test Jira connection" })
  );

  await waitFor(() => {
    expect(testBfdConnection).toHaveBeenCalledWith(
      "jira",
      expect.objectContaining({
        config: expect.objectContaining({ jira: config.jira }),
        secrets: expect.objectContaining({ jiraToken: "draft-token" }),
      })
    );
  });
  expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
});
