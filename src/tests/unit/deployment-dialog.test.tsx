import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createDeployment,
  getWorkflowTargets,
  refreshDeploymentBatch,
} from "@/actions/bfd";
import { openExternalLink } from "@/actions/shell";
import DeploymentDialog from "@/components/deployment-dialog";
import type {
  DeploymentBatch,
  DevDeployment,
  TicketDeploymentRow,
  WorkflowTarget,
} from "@/types/bfd";

const DEPLOY_BUTTON_PATTERN = /deploy/i;
const OPEN_RUN_BUTTON_PATTERN = /open run/i;
const PERFORM_TESTS_SWITCH_PATTERN = /perform tests/i;

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
  inputs: WorkflowTarget["inputs"] = []
): WorkflowTarget {
  const aliases = [
    name,
    name.split("-").filter(Boolean).slice(1).join("-"),
  ].filter(Boolean);
  return {
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

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DeploymentDialog
        deployments={deployments}
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
