import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  getBfdConfig,
  getDeploymentBatches,
  getDevDeployments,
  getSprintTickets,
  getTicketDevelopment,
  searchTickets,
} from "@/actions/bfd";
import { Route } from "@/routes/index";
import type {
  AppConfig,
  JiraDevelopmentInfo,
  JiraTicket,
  PullRequestSummary,
} from "@/types/bfd";

vi.mock("@tanstack/react-router", async () => {
  const React = await import("react");

  return {
    Link: ({ children, to, ...props }: { children: ReactNode; to: string }) =>
      React.createElement("a", { href: to, ...props }, children),
    createFileRoute: () => (options: unknown) => ({ options }),
  };
});

vi.mock("@/actions/bfd", () => ({
  createDeployment: vi.fn(),
  getBfdConfig: vi.fn(),
  getDeploymentBatches: vi.fn(),
  getDevDeployments: vi.fn(),
  getSprintTickets: vi.fn(),
  getTicketDevelopment: vi.fn(),
  getWorkflowTargets: vi.fn(),
  refreshDeploymentBatch: vi.fn(),
  searchTickets: vi.fn(),
}));

vi.mock("@/actions/shell", () => ({
  openExternalLink: vi.fn(),
}));

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
    email: "ada@example.com",
    project: "PC",
    sprintJql: "project = PC ORDER BY rank ASC",
  },
  onboardingComplete: true,
  repoPath: "~/devenv/src",
};

const Dashboard = (
  Route as unknown as { options: { component: ComponentType } }
).options.component;
const ARGO_ERROR_PATTERN = /Dev-system state could not be loaded from ArgoCD/;
const LIVE_JIRA_ERROR_PATTERN = /Jira tickets could not be loaded: Bad JQL/;
const PREVIEW_JIRA_ERROR_PATTERN =
  /Jira tickets could not be loaded before setup is complete: Missing Jira token\. Showing preview data\./;
const PR_BADGE_PATTERN = /#7/;

function ticket(
  key: string,
  title: string,
  status = "In Progress",
  statusCategory: JiraTicket["statusCategory"] = "occupied"
): JiraTicket {
  return {
    assignee: "Ada Lovelace",
    assigneeAvatar: null,
    id: key.replace("PC-", ""),
    key,
    status,
    statusCategory,
    title,
    updated: "2026-06-18T09:00:00.000Z",
    url: `https://jira.example.com/browse/${key}`,
  };
}

function pullRequest(
  number: number,
  key: string,
  state: PullRequestSummary["state"] = "open"
): PullRequestSummary {
  return {
    approved: state === "open",
    baseRef: "master",
    headRef: `${key}-pricing-work`,
    headSha: "abc123",
    isDraft: false,
    number,
    source: "enriched",
    state,
    title: `${key}: Pricing work`,
    url: `https://github.example.com/pulls/${number}`,
  };
}

function development(
  pullRequests: PullRequestSummary[] = []
): JiraDevelopmentInfo {
  return {
    branches: [],
    buildCount: 0,
    builds: [],
    errors: [],
    pullRequests,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: PromiseLike<T> | T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] | undefined;
  let reject: Deferred<T>["reject"] | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  if (!(resolve && reject)) {
    throw new Error("Deferred promise handlers were not assigned.");
  }

  return { promise, reject, resolve };
}

function renderDashboard(config: AppConfig = baseConfig) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  vi.mocked(getBfdConfig).mockResolvedValue({
    config,
    secrets: { githubToken: false, jiraToken: true },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDeploymentBatches).mockResolvedValue([]);
  vi.mocked(getDevDeployments).mockResolvedValue([]);
  vi.mocked(getSprintTickets).mockResolvedValue([]);
  vi.mocked(getTicketDevelopment).mockResolvedValue(development());
  vi.mocked(searchTickets).mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

test("filters loaded sprint rows locally and only uses global Jira search after local misses", async () => {
  const user = userEvent.setup();
  const localTickets = [
    ticket("PC-101", "No development yet"),
    ticket("PC-102", "Pricing approval", "Done", "free"),
  ];
  const globalTicket = ticket("PC-999", "Global-only ticket");

  vi.mocked(getSprintTickets).mockResolvedValue(localTickets);
  vi.mocked(getTicketDevelopment).mockImplementation(async ({ ticketKey }) =>
    development(
      ticketKey === "PC-102" ? [pullRequest(7, ticketKey, "merged")] : []
    )
  );
  vi.mocked(searchTickets).mockResolvedValue([globalTicket]);

  renderDashboard();

  expect(await screen.findByText("No development yet")).toBeInTheDocument();
  expect(screen.getByText("Pricing approval")).toBeInTheDocument();
  expect(await screen.findByText(PR_BADGE_PATTERN)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Hide open" }));

  expect(screen.queryByText("No development yet")).not.toBeInTheDocument();
  expect(screen.getByText("Pricing approval")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "All" }));
  await user.click(screen.getByRole("button", { name: "Hide closed" }));

  expect(screen.getByText("No development yet")).toBeInTheDocument();
  expect(screen.queryByText("Pricing approval")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "All" }));

  const search = screen.getByPlaceholderText("Search ticket or topic...");
  fireEvent.change(search, { target: { value: "pricing" } });

  expect(await screen.findByText("Pricing approval")).toBeInTheDocument();
  expect(screen.queryByText("No development yet")).not.toBeInTheDocument();
  expect(searchTickets).not.toHaveBeenCalled();

  fireEvent.change(search, { target: { value: "global-only" } });

  await waitFor(() => {
    expect(searchTickets).toHaveBeenCalledWith("global-only");
  });
  expect(await screen.findByText("Global-only ticket")).toBeInTheDocument();
  expect(
    screen.getByText("1 Jira result outside the loaded sprint result set.")
  ).toBeInTheDocument();
});

test("shows preview data only before onboarding when Jira fails", async () => {
  vi.mocked(getSprintTickets).mockRejectedValue(
    new Error("Missing Jira token")
  );
  vi.mocked(getDevDeployments).mockRejectedValue(new Error("Argo unavailable"));

  renderDashboard({ ...baseConfig, onboardingComplete: false });

  expect(
    await screen.findByText("Show member price in basket summary")
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "Preview data shown until Jira credentials are configured."
    )
  ).toBeInTheDocument();
  expect(screen.getByText(PREVIEW_JIRA_ERROR_PATTERN)).toBeInTheDocument();
  expect(screen.queryByText(ARGO_ERROR_PATTERN)).not.toBeInTheDocument();
});

test("shows live loading and Jira error states when onboarding is complete", async () => {
  const tickets = deferred<JiraTicket[]>();
  vi.mocked(getSprintTickets).mockReturnValue(tickets.promise);

  renderDashboard();

  expect(
    await screen.findByText(
      "Loading Jira tickets from the configured sprint JQL."
    )
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "Loading Jira sprint tickets from the configured sprint JQL..."
    )
  ).toBeInTheDocument();

  tickets.reject(new Error("Bad JQL"));

  expect(await screen.findByText(LIVE_JIRA_ERROR_PATTERN)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Retry Jira" })
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open settings" })).toHaveAttribute(
    "href",
    "/settings"
  );
  expect(
    screen.getByText(
      "No live sprint tickets are shown because Jira failed. Retry Jira or open settings."
    )
  ).toBeInTheDocument();
});
