import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { openExternalLink } from "@/actions/shell";
import TicketsTable from "@/components/tickets-table";
import type { DeploymentBatch, TicketDeploymentRow } from "@/types/bfd";

vi.mock("@/actions/shell", () => ({
  openExternalLink: vi.fn(),
}));

function DeploymentDialog({
  onSuccess,
  open,
}: {
  onSuccess?: (batch: DeploymentBatch) => void;
  open?: boolean;
}) {
  if (!open) {
    return null;
  }
  return (
    <button
      data-testid="deployment-dialog"
      onClick={() => onSuccess?.(deploymentBatch)}
      type="button"
    >
      Confirm deploy
    </button>
  );
}

vi.mock("@/components/deployment-dialog", () => ({
  default: DeploymentDialog,
}));

const DEPLOY_BUTTON_PATTERN = /^Deploy$/i;
const DEPLOY_RUNNING_PATTERN = /deploy running/i;
const TICKET_HEADER_PATTERN = /ticket/i;

function row(key: string, title: string): TicketDeploymentRow {
  return {
    branches: [],
    deployments:
      key === "PC-2"
        ? [
            {
              ageSeconds: 60,
              app: "shop",
              autoSync: "off",
              branch: "PC-2-checkout",
              deployedAt: "2026-06-18T10:00:00.000Z",
              environment: "04",
              health: "Healthy",
              isFree: false,
              reserved: false,
              sync: "Synced",
              ticketKey: "PC-2",
            },
          ]
        : [],
    pullRequests:
      key === "PC-2"
        ? [
            {
              approved: true,
              baseRef: "master",
              headRef: "PC-2-checkout",
              headSha: "abc123",
              isDraft: false,
              number: 42,
              source: "enriched",
              state: "open",
              title: "PC-2 checkout",
              url: "https://github.example/pulls/42",
            },
          ]
        : [],
    ticket: {
      assignee: key === "PC-2" ? "Ada Lovelace" : null,
      assigneeAvatar: null,
      id: key.replace("PC-", ""),
      key,
      status: key === "PC-2" ? "In Progress" : "Done",
      statusCategory: key === "PC-2" ? "occupied" : "free",
      title,
      updated: "2026-06-18T10:00:00.000Z",
      url: `https://jira.example.com/browse/${key}`,
    },
  };
}

const deploymentBatch: DeploymentBatch = {
  aggregateState: "in-progress",
  branch: "PC-2-checkout",
  createdAt: Date.parse("2026-06-18T10:00:00.000Z"),
  environment: "04",
  id: "batch-1",
  ticketKey: "PC-2",
  updatedAt: Date.parse("2026-06-18T10:01:00.000Z"),
  workflows: [
    {
      dispatchRequestedAt: Date.parse("2026-06-18T10:00:00.000Z"),
      environment: "04",
      fileName: "app-shop.yml",
      inputs: { ENVIRONMENT: "04" },
      runId: 123,
      runUrl: "https://github.com/bergfreunde/shop/actions/runs/123",
      state: "in-progress",
      targetName: "app-shop",
      workflowPath: ".github/workflows/app-shop.yml",
    },
  ],
};

function renderTable() {
  return render(
    <TicketsTable
      deploymentBatches={[deploymentBatch]}
      deployments={[]}
      github={{ owner: "bergfreunde", repo: "shop" }}
      rows={[row("PC-10", "Later ticket"), row("PC-2", "Checkout fixes")]}
    />
  );
}

function renderActiveOnlyTable() {
  return render(
    <TicketsTable
      deploymentBatches={[{ ...deploymentBatch, ticketKey: "PC-10" }]}
      deployments={[]}
      github={{ owner: "bergfreunde", repo: "shop" }}
      rows={[row("PC-10", "Later ticket")]}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("sorts ticket rows by numeric Jira key and toggles direction", async () => {
  const user = userEvent.setup();
  renderTable();

  expect(
    screen
      .getByText("Checkout fixes")
      .compareDocumentPosition(screen.getByText("Later ticket"))
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

  await user.click(screen.getByRole("button", { name: TICKET_HEADER_PATTERN }));

  expect(
    screen
      .getByText("Later ticket")
      .compareDocumentPosition(screen.getByText("Checkout fixes"))
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

test("opens ticket, pull request, dev system, and deployment run links", async () => {
  const user = userEvent.setup();
  renderTable();

  await user.click(screen.getByRole("button", { name: "PC-2" }));
  expect(openExternalLink).toHaveBeenLastCalledWith(
    "https://jira.example.com/browse/PC-2"
  );

  await user.click(screen.getByRole("button", { name: "42" }));
  expect(openExternalLink).toHaveBeenLastCalledWith(
    "https://github.com/bergfreunde/shop/pull/42"
  );

  await user.click(screen.getByRole("button", { name: "04" }));
  expect(openExternalLink).toHaveBeenLastCalledWith(
    "https://dev-04.bergfreunde.de/"
  );

  await user.click(
    screen.getByRole("button", { name: DEPLOY_RUNNING_PATTERN })
  );
  expect(openExternalLink).toHaveBeenLastCalledWith(
    "https://github.com/bergfreunde/shop/actions/runs/123"
  );
});

test("hides not deployed text while a deployment is active", () => {
  renderActiveOnlyTable();

  expect(screen.queryByText("not deployed")).not.toBeInTheDocument();
  expect(screen.getByText(DEPLOY_RUNNING_PATTERN)).toBeInTheDocument();
});

test("filters rows by status and assignee", async () => {
  const user = userEvent.setup();
  renderTable();

  await user.click(screen.getByRole("button", { name: "Filter by status" }));
  await user.click(screen.getByRole("button", { name: "Done" }));

  expect(screen.getByText("Later ticket")).toBeInTheDocument();
  expect(screen.queryByText("Checkout fixes")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Filter by status" }));
  await user.click(screen.getByRole("button", { name: "All statuses" }));
  await user.click(screen.getByRole("button", { name: "Filter by assignee" }));
  await user.click(screen.getByRole("button", { name: "Ada Lovelace" }));

  expect(screen.getByText("Checkout fixes")).toBeInTheDocument();
  expect(screen.queryByText("Later ticket")).not.toBeInTheDocument();
});

test("closes deploy dialog and shows a success toast after a deployment is dispatched", async () => {
  const user = userEvent.setup();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  renderTable();

  const checkoutRow = screen.getByText("Checkout fixes").closest("tr");
  if (!checkoutRow) {
    throw new Error("Checkout row not found");
  }
  await user.click(
    within(checkoutRow).getByRole("button", { name: DEPLOY_BUTTON_PATTERN })
  );
  expect(screen.getByTestId("deployment-dialog")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Confirm deploy" }));

  await waitFor(() => {
    expect(screen.queryByTestId("deployment-dialog")).not.toBeInTheDocument();
  });
  const toast = screen.getByRole("status");
  expect(toast).toHaveTextContent("Deployment started");
  expect(toast).toHaveTextContent("PC-2 dispatched to dev-04");

  act(() => {
    vi.advanceTimersByTime(4000);
  });
  await waitFor(() => {
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  vi.useRealTimers();
});
