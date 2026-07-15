import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createDeployment,
  getActiveSprint,
  getBfdConfig,
  getDeploymentBatches,
  getDevDeployments,
  getSprintTickets,
  getTicketDevelopment,
  getWorkflowTargets,
  refreshDeploymentBatch,
  searchTickets,
} from "@/actions/bfd";
import { openExternalLink } from "@/actions/shell";
import DeploymentDialog from "@/components/deployment-dialog";
import { Route } from "@/routes/index";
import type {
  AppConfig,
  DeploymentBatch,
  JiraDevelopmentInfo,
  JiraSprint,
  JiraTicket,
  PullRequestSummary,
  TicketDeploymentRow,
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
  deleteDeploymentBatch: vi.fn(),
  getActiveSprint: vi.fn(),
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
    argocdNamespace: "argocd",
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
const APP_SHOP_PATTERN = /app-shop/;
const DEPLOY_BUTTON_NAME_PATTERN = /^Deploy$/;
const PR_BRANCH = "PC-102-pricing-work";

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

function sprint(overrides: Partial<JiraSprint> = {}): JiraSprint {
  return {
    endDate: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    goal: "Our customers can order with Paypal Express without login.",
    id: 7,
    name: "Endgegner PainPal",
    startDate: "2026-06-16T08:00:00.000Z",
    state: "active",
    ...overrides,
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

function deploymentBatch(
  state: DeploymentBatch["aggregateState"]
): DeploymentBatch {
  return {
    aggregateState: state,
    branch: "PC-101-branch",
    createdAt: Date.parse("2026-06-18T10:00:00.000Z"),
    environment: "04",
    id: "batch-1",
    ticketKey: "PC-101",
    updatedAt: Date.parse("2026-06-18T10:02:00.000Z"),
    workflows: [
      {
        dispatchRequestedAt: Date.parse("2026-06-18T10:00:00.000Z"),
        environment: "04",
        fileName: "app-shop.yml",
        inputs: { ENVIRONMENT: "04" },
        runId: state === "success" ? 987 : undefined,
        runUrl:
          state === "success"
            ? "https://github.example/actions/runs/987"
            : undefined,
        state,
        targetName: "app-shop",
        workflowPath: ".github/workflows/app-shop.yml",
      },
    ],
  };
}

function deploymentRow(): TicketDeploymentRow {
  return {
    branches: [{ headSha: "abc123", name: "PC-101-branch", source: "jira" }],
    deployments: [],
    ticket: ticket("PC-101", "No development yet"),
    pullRequests: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActiveSprint).mockResolvedValue(null);
  vi.mocked(getDeploymentBatches).mockResolvedValue([]);
  vi.mocked(getDevDeployments).mockResolvedValue([]);
  vi.mocked(getSprintTickets).mockResolvedValue([]);
  vi.mocked(getTicketDevelopment).mockResolvedValue(development());
  vi.mocked(searchTickets).mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

test("shows active sprint name, goal, and remaining time in the header", async () => {
  vi.mocked(getActiveSprint).mockResolvedValue(sprint());
  vi.mocked(getSprintTickets).mockResolvedValue([
    ticket("PC-101", "No development yet"),
  ]);

  renderDashboard();

  expect(
    await screen.findByRole("heading", { name: "Endgegner PainPal" })
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "Our customers can order with Paypal Express without login."
    )
  ).toBeInTheDocument();
  expect(screen.getByText("3 days remaining")).toBeInTheDocument();
});

test("focuses and selects dashboard search with Ctrl+F", async () => {
  const user = userEvent.setup();
  vi.mocked(getSprintTickets).mockResolvedValue([
    ticket("PC-101", "No development yet"),
  ]);

  renderDashboard();

  const search = await screen.findByPlaceholderText(
    "Search ticket or topic..."
  );
  fireEvent.change(search, { target: { value: "PC-101" } });
  fireEvent.keyDown(window, { ctrlKey: true, key: "f" });

  expect(search).toHaveFocus();
  expect((search as HTMLInputElement).selectionStart).toBe(0);
  expect((search as HTMLInputElement).selectionEnd).toBe("PC-101".length);

  await user.click(screen.getByRole("button", { name: "Clear search" }));

  expect(search).toHaveValue("");
  expect(search).toHaveFocus();
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
  const prBadge = await screen.findByText("7");
  expect(prBadge).toHaveTextContent("7");
  expect(prBadge).not.toHaveTextContent("#");
  await user.hover(prBadge);
  expect((await screen.findAllByText(PR_BRANCH)).length).toBeGreaterThan(0);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const copyButtons = await screen.findAllByRole("button", {
    name: "Copy branch name",
  });
  await user.click(copyButtons[0]);
  expect(writeText).toHaveBeenCalledWith(PR_BRANCH);
  expect(openExternalLink).not.toHaveBeenCalled();

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

test("syncs deployment history cache when deployment query updates", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const started = deploymentBatch("queued");
  const finished = deploymentBatch("success");
  vi.mocked(getWorkflowTargets).mockResolvedValue({
    repoPath: "/tmp/shop",
    targets: [
      {
        affectedPathGlobs: [],
        aliases: ["shop"],
        fileName: "app-shop.yml",
        group: "app",
        inputs: [],
        name: "app-shop",
        path: ".github/workflows/app-shop.yml",
        usage: null,
      },
    ],
    warnings: [],
    workflowsPath: "/tmp/shop/.github/workflows",
  });
  vi.mocked(createDeployment).mockResolvedValue(started);
  vi.mocked(refreshDeploymentBatch).mockResolvedValue(finished);

  render(
    <QueryClientProvider client={queryClient}>
      <DeploymentDialog
        deployments={[]}
        onOpenChange={vi.fn()}
        open={true}
        row={deploymentRow()}
      />
    </QueryClientProvider>
  );

  expect(await screen.findAllByText(APP_SHOP_PATTERN)).not.toHaveLength(0);
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: DEPLOY_BUTTON_NAME_PATTERN })
    ).toBeEnabled();
  });

  fireEvent.click(
    screen.getByRole("button", { name: DEPLOY_BUTTON_NAME_PATTERN })
  );

  await waitFor(() => {
    expect(createDeployment).toHaveBeenCalled();
  });

  act(() => {
    queryClient.setQueryData(["bfd", "deployment", "batch-1"], finished);
  });

  await waitFor(() => {
    expect(
      queryClient.getQueryData<DeploymentBatch[]>(["bfd", "deployments"])
    ).toEqual([finished]);
  });
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
