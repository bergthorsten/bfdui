import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createDeployment,
  getWorkflowTargets,
  refreshDeploymentBatch,
} from "@/actions/bfd";
import { openExternalLink } from "@/actions/shell";
import DeploymentDialog from "@/components/deployment-dialog";
import { rankWorkflowTargets } from "@/components/deployment-dialog-helpers";
import type {
  DeploymentBatch,
  DevDeployment,
  TicketDeploymentRow,
  WorkflowTarget,
} from "@/types/bfd";

const DEPLOY_BUTTON_PATTERN = /deploy/i;
const OPEN_RUN_BUTTON_PATTERN = /open run/i;
const PERFORM_TESTS_SWITCH_PATTERN = /perform tests/i;
const OCCUPIED_WARNING_PATTERN = /Current branch: PC-999-owned-system/;
const RESERVED_WARNING_PATTERN = /dev-20 is reserved in BFD/;
const STAGING_WARNING_PATTERN = /Staging is shared/;

vi.mock("@/actions/bfd", () => ({
  createDeployment: vi.fn(),
  getWorkflowTargets: vi.fn(),
  refreshDeploymentBatch: vi.fn(),
}));

vi.mock("@/actions/shell", () => ({
  openExternalLink: vi.fn(),
}));

vi.mock("@/components/ui/dialog", async () => {
  const React = await import("react");

  return {
    Dialog: ({
      children,
      open,
    }: {
      children: React.ReactNode;
      open: boolean;
    }) => (open ? React.createElement("div", null, children) : null),
    DialogClose: ({ children }: { children: React.ReactNode }) => children,
    DialogContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    DialogDescription: ({ children }: { children: React.ReactNode }) =>
      React.createElement("p", null, children),
    DialogFooter: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    DialogHeader: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    DialogTitle: ({ children }: { children: React.ReactNode }) =>
      React.createElement("h2", null, children),
  };
});

function workflowTarget(
  name: string,
  inputs: WorkflowTarget["inputs"] = [],
  affectedPathGlobs: string[] = []
): WorkflowTarget {
  const aliases = [
    name,
    name.split("-").filter(Boolean).slice(1).join("-"),
  ].filter(Boolean);
  return {
    affectedPathGlobs,
    aliases,
    fileName: `${name}.yml`,
    group: name.split("-")[0] ?? "app",
    inputs,
    name,
    path: `.github/workflows/${name}.yml`,
    usage: null,
  };
}

const row: TicketDeploymentRow = {
  branches: [
    {
      headSha: "branch-sha",
      name: "PC-123-shop",
      source: "github",
      url: "https://github.com/bergfreunde/shop/tree/PC-123-shop",
    },
  ],
  deployments: [],
  pullRequests: [],
  ticket: {
    assignee: "Ada Lovelace",
    assigneeAvatar: null,
    id: "123",
    key: "PC-123",
    status: "In Progress",
    statusCategory: "occupied",
    title: "Deploy dialog test",
    updated: "2026-06-18T10:00:00.000Z",
    url: "https://jira.example.com/browse/PC-123",
  },
};

const deployments: DevDeployment[] = [
  {
    ageSeconds: null,
    app: "shop",
    autoSync: "off",
    branch: "master",
    deployedAt: null,
    environment: "04",
    health: "Healthy",
    isFree: true,
    reserved: false,
    sync: "Synced",
    ticketKey: null,
  },
];

const failedBatch: DeploymentBatch = {
  aggregateState: "failure",
  branch: "PC-123-shop",
  createdAt: Date.parse("2026-06-18T10:00:00.000Z"),
  environment: "04",
  id: "batch-1",
  ticketKey: "PC-123",
  updatedAt: Date.parse("2026-06-18T10:01:00.000Z"),
  workflows: [
    {
      dispatchRequestedAt: Date.parse("2026-06-18T10:00:00.000Z"),
      environment: "04",
      fileName: "app-shop.yml",
      inputs: { ENVIRONMENT: "04", PERFORM_TESTS: "true" },
      runId: 123,
      runUrl: "https://github.com/bergfreunde/shop/actions/runs/123",
      state: "failure",
      targetName: "app-shop",
      workflowPath: ".github/workflows/app-shop.yml",
    },
  ],
};

function renderDialog(options: { deployments?: DevDeployment[] } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DeploymentDialog
        deployments={options.deployments ?? deployments}
        onOpenChange={vi.fn()}
        open={true}
        row={row}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWorkflowTargets).mockResolvedValue({
    repoPath: "/tmp/shop",
    targets: [
      workflowTarget("app-shop", [
        {
          name: "ENVIRONMENT",
          options: ["01", "04"],
          required: true,
          type: "choice",
        },
        {
          default: "false",
          description: "Run workflow tests",
          name: "PERFORM_TESTS",
          options: [],
          required: false,
          type: "boolean",
        },
      ]),
      workflowTarget("tool-karabiner", [
        {
          name: "RUN_ENVIRONMENTS",
          options: [],
          required: true,
          type: "string",
        },
      ]),
    ],
    warnings: [],
    workflowsPath: "/tmp/shop/.github/workflows",
  });
  vi.mocked(createDeployment).mockResolvedValue(failedBatch);
  vi.mocked(refreshDeploymentBatch).mockResolvedValue(failedBatch);
});

afterEach(() => {
  vi.clearAllMocks();
});

test("selects multiple workflow targets, sends parsed inputs, and shows run link", async () => {
  const user = userEvent.setup();
  renderDialog();

  expect(await screen.findByText("shop -> app-shop")).toBeInTheDocument();
  expect(screen.getByText("1 selected")).toBeInTheDocument();

  await user.click(screen.getByText("karabiner -> tool-karabiner"));
  expect(screen.getByText("2 selected")).toBeInTheDocument();

  await user.click(
    screen.getByRole("switch", { name: PERFORM_TESTS_SWITCH_PATTERN })
  );
  await user.click(screen.getByRole("button", { name: DEPLOY_BUTTON_PATTERN }));

  await waitFor(() => {
    expect(createDeployment).toHaveBeenCalled();
  });
  expect(vi.mocked(createDeployment).mock.calls[0]?.[0]).toEqual({
    branch: "PC-123-shop",
    environment: "04",
    sourceCommitSha: "branch-sha",
    ticketKey: "PC-123",
    workflows: [
      {
        inputs: { ENVIRONMENT: "04", PERFORM_TESTS: "true" },
        name: "app-shop",
        path: ".github/workflows/app-shop.yml",
      },
      {
        inputs: { RUN_ENVIRONMENTS: "04" },
        name: "tool-karabiner",
        path: ".github/workflows/tool-karabiner.yml",
      },
    ],
  });

  expect(await screen.findByText("Deployment run")).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: OPEN_RUN_BUTTON_PATTERN })
  );
  expect(openExternalLink).toHaveBeenCalledWith(
    "https://github.com/bergfreunde/shop/actions/runs/123"
  );
});

test("allows deselecting every workflow and disables deploy", async () => {
  const user = userEvent.setup();
  renderDialog();

  await user.click(await screen.findByText("shop -> app-shop"));

  expect(screen.getByText("0 selected")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: DEPLOY_BUTTON_PATTERN })
  ).toBeDisabled();
});

test("prioritizes free targets and shows selected target warnings", async () => {
  const user = userEvent.setup();
  renderDialog({
    deployments: [
      {
        ageSeconds: 300,
        app: "shop",
        autoSync: "off",
        branch: "PC-999-owned-system",
        deployedAt: "2026-06-18T09:55:00.000Z",
        environment: "01",
        health: "Healthy",
        isFree: false,
        reserved: false,
        sync: "Synced",
        ticketKey: "PC-999",
      },
      {
        ageSeconds: null,
        app: "shop",
        autoSync: "off",
        branch: "master",
        deployedAt: null,
        environment: "04",
        health: "Healthy",
        isFree: true,
        reserved: false,
        sync: "Synced",
        ticketKey: null,
      },
    ],
  });

  expect(await screen.findByText("shop -> app-shop")).toBeInTheDocument();
  const targetOptions = within(
    screen.getByRole("listbox", { name: "Target environment" })
  ).getAllByRole("option");
  expect(targetOptions[0]).toHaveTextContent("dev-04");
  expect(targetOptions[0]).toHaveTextContent("free");

  await user.click(screen.getByText("dev-01"));
  expect(screen.getByText("System is not free")).toBeInTheDocument();
  expect(screen.getByText(OCCUPIED_WARNING_PATTERN)).toBeInTheDocument();

  await user.click(screen.getByText("dev-20"));
  expect(screen.getByText("Reserved system")).toBeInTheDocument();
  expect(screen.getByText(RESERVED_WARNING_PATTERN)).toBeInTheDocument();

  await user.click(
    targetOptions.find((option) => option.textContent?.includes("staging")) ??
      targetOptions.at(-1) ??
      targetOptions[0]
  );
  expect(screen.getByText("Staging target")).toBeInTheDocument();
  expect(screen.getByText(STAGING_WARNING_PATTERN)).toBeInTheDocument();
});

test("boosts workflow ranking from PR changed files and affected path globs", () => {
  const ranked = rankWorkflowTargets(
    [
      workflowTarget("app-shop"),
      workflowTarget("app-services-php", [], ["apps/services-php/**"]),
    ],
    {
      ...row,
      branches: [],
      pullRequests: [
        {
          baseRef: "master",
          changedFiles: ["apps/services-php/src/index.php"],
          headRef: "PC-123-services",
          headSha: "pr-sha",
          isDraft: false,
          number: 123,
          source: "github",
          state: "open",
          title: "Change services",
          url: "https://github.com/bergfreunde/shop/pull/123",
        },
      ],
    }
  );

  expect(ranked.map((target) => target.name)).toEqual([
    "app-services-php",
    "app-shop",
  ]);
});
