import { deploymentPollingInterval } from "@/components/deployment-dialog-helpers";
import { MOCK_DEPLOYMENTS } from "@/data/mock";
import type {
  DeploymentBatch,
  DevDeployment,
  IntegrationStatus,
  JiraDevelopmentInfo,
  JiraSprint,
  JiraTicket,
  TicketDeploymentRow,
} from "@/types/bfd";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const DEPLOYMENT_HISTORY_RETENTION_MS = DAY_MS;
const TERMINAL_DEPLOYMENT_STATES = new Set([
  "cancelled",
  "failure",
  "success",
  "timed-out",
]);

export type SprintFilter = "hide-closed" | "hide-open";

export interface SprintFilterState {
  hideClosed: boolean;
  hideOpen: boolean;
}

export const EMPTY_SPRINT_FILTER: SprintFilterState = {
  hideClosed: false,
  hideOpen: false,
};

export function rowsForTickets(
  tickets: JiraTicket[],
  options: {
    developmentByKey?: Map<string, JiraDevelopmentInfo>;
    developmentStatusByKey?: Map<string, IntegrationStatus>;
    deployments?: DevDeployment[];
    devSystemStatus?: IntegrationStatus;
    includeMockDeployments?: boolean;
  } = {}
): TicketDeploymentRow[] {
  return tickets.map((ticket) => {
    const development = options.developmentByKey?.get(ticket.key);
    return {
      ticket,
      branches: development?.branches ?? [],
      developmentStatus: options.developmentStatusByKey?.get(ticket.key),
      pullRequests: development?.pullRequests ?? [],
      devSystemStatus: options.devSystemStatus,
      deployments: (options.includeMockDeployments
        ? MOCK_DEPLOYMENTS
        : (options.deployments ?? [])
      ).filter((deployment) => deployment.ticketKey === ticket.key),
    };
  });
}

export function formatRelativeUpdate(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 10) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds} seconds ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function dashboardUpdatedLabel({
  lastUpdatedAt,
  now,
  previewMode,
  refreshingCachedData,
}: {
  lastUpdatedAt: number;
  now: number;
  previewMode: boolean;
  refreshingCachedData: boolean;
}): string {
  if (lastUpdatedAt) {
    const age = formatRelativeUpdate(lastUpdatedAt, now);
    return refreshingCachedData ? `cached ${age} · refreshing` : age;
  }
  return previewMode ? "preview data" : "not loaded yet";
}

export function rowMatchesSprintFilter(
  row: TicketDeploymentRow,
  filter: SprintFilterState
): boolean {
  if (!(filter.hideOpen || filter.hideClosed)) {
    return true;
  }
  const hasNoPr = row.pullRequests.length === 0;
  const isClosed =
    row.ticket.statusCategory === "free" ||
    row.pullRequests.some((pr) => pr.state === "merged");
  if (filter.hideOpen && hasNoPr) {
    return false;
  }
  if (filter.hideClosed && isClosed) {
    return false;
  }
  return true;
}

export function searchRows(
  rows: TicketDeploymentRow[],
  normalizedQuery: string
): TicketDeploymentRow[] {
  const q = normalizedQuery.toLowerCase();
  if (!q) {
    return rows;
  }
  return rows.filter(
    ({ ticket }) =>
      ticket.key.toLowerCase().includes(q) ||
      ticket.title.toLowerCase().includes(q)
  );
}

export function dashboardResultLabel({
  jiraSearchCount,
  jiraSearchFetching,
  localRowsCount,
  normalizedQuery,
  previewMode,
  searchedRowsCount,
  ticketsCount,
  ticketsError,
  ticketsFetching,
}: {
  jiraSearchCount?: number;
  jiraSearchFetching: boolean;
  localRowsCount: number;
  normalizedQuery: string;
  previewMode: boolean;
  searchedRowsCount: number;
  ticketsCount?: number;
  ticketsError: unknown;
  ticketsFetching: boolean;
}): string {
  if (!normalizedQuery) {
    if (typeof ticketsCount === "number") {
      return ticketsFetching
        ? `${ticketsCount} Jira tickets loaded from cache while the configured sprint JQL refreshes.`
        : `${ticketsCount} Jira tickets loaded from the configured sprint JQL.`;
    }
    if (previewMode) {
      return "Preview data shown until Jira credentials are configured.";
    }
    if (ticketsError) {
      return "Jira tickets could not be loaded from the configured sprint JQL.";
    }
    return "Loading Jira tickets from the configured sprint JQL.";
  }
  if (searchedRowsCount > 0) {
    return `${localRowsCount} local result${localRowsCount === 1 ? "" : "s"} in the loaded sprint tickets.`;
  }
  if (jiraSearchFetching) {
    return "No local match. Searching all accessible Jira tickets...";
  }
  if (typeof jiraSearchCount === "number") {
    return `${jiraSearchCount} Jira result${jiraSearchCount === 1 ? "" : "s"} outside the loaded sprint result set.`;
  }
  return "No local match. Jira global search starts after 2 characters.";
}

export function sprintRemainingLabel(
  sprint: JiraSprint,
  now: number
): string | null {
  if (!sprint.endDate) {
    return null;
  }
  const endAt = Date.parse(sprint.endDate);
  if (!Number.isFinite(endAt)) {
    return null;
  }
  const remainingMs = endAt - now;
  if (remainingMs <= 0) {
    return "Sprint ended";
  }
  if (remainingMs < DAY_MS) {
    const hours = Math.max(1, Math.ceil(remainingMs / HOUR_MS));
    return `${hours} hour${hours === 1 ? "" : "s"} remaining`;
  }
  const days = Math.ceil(remainingMs / DAY_MS);
  return `${days} day${days === 1 ? "" : "s"} remaining`;
}

export function dashboardEmptyMessage({
  jiraSearchFetching,
  normalizedQuery,
  previewMode,
  shouldSearchJira,
  ticketsError,
  ticketsFetching,
}: {
  jiraSearchFetching: boolean;
  normalizedQuery: string;
  previewMode: boolean;
  shouldSearchJira: boolean;
  ticketsError: unknown;
  ticketsFetching: boolean;
}): string {
  if (ticketsFetching && !previewMode && !normalizedQuery) {
    return "Loading Jira sprint tickets from the configured sprint JQL...";
  }
  if (ticketsError && !previewMode) {
    return "No live sprint tickets are shown because Jira failed. Retry Jira or open settings.";
  }
  if (shouldSearchJira && jiraSearchFetching) {
    return "Searching all accessible Jira tickets because nothing matched the loaded sprint.";
  }
  if (shouldSearchJira) {
    return "No Jira tickets matched globally. Try a ticket key or broader search text.";
  }
  return previewMode
    ? "No preview tickets match this search/filter."
    : "No sprint tickets match this search/filter.";
}

export function integrationStatusFromDevelopmentQuery(queryResult: {
  data?: JiraDevelopmentInfo;
  error: unknown;
  isFetching: boolean;
  isLoading: boolean;
}): IntegrationStatus {
  if (queryResult.data && queryResult.isFetching) {
    return {
      kind: "refreshing",
      message:
        "Showing cached Jira dev-status and GitHub PR data while refreshing.",
    };
  }
  if (queryResult.isLoading || queryResult.isFetching) {
    return {
      kind: "loading",
      message:
        "Loading Jira dev-status and GitHub PR discovery for this ticket.",
    };
  }
  if (queryResult.error) {
    return {
      kind: "error",
      message: `Jira dev-status/GitHub PR data failed: ${messageOf(queryResult.error)}`,
    };
  }
  if (queryResult.data?.errors.length) {
    return {
      kind: "warning",
      message: `Partial development data: ${queryResult.data.errors.join("; ")}`,
    };
  }
  if (queryResult.data) {
    return {
      kind: "ok",
      message: "Jira dev-status and GitHub PR data loaded.",
    };
  }
  return {
    kind: "idle",
    message: "Development data has not been requested for this row.",
  };
}

export function integrationStatusFromDevSystemsQuery(queryResult: {
  data?: DevDeployment[];
  error: unknown;
  isFetching: boolean;
  isLoading: boolean;
}): IntegrationStatus {
  if (queryResult.data && queryResult.isFetching) {
    return {
      kind: "refreshing",
      message: "Showing cached dev-system state while ArgoCD refreshes.",
    };
  }
  if (queryResult.isLoading || queryResult.isFetching) {
    return {
      kind: "loading",
      message: "Loading dev-system state from ArgoCD.",
    };
  }
  if (queryResult.error) {
    return {
      kind: "error",
      message: `ArgoCD dev-system state failed: ${messageOf(queryResult.error)}`,
    };
  }
  if (queryResult.data) {
    return { kind: "ok", message: "ArgoCD dev-system state loaded." };
  }
  return { kind: "idle", message: "Dev-system state has not loaded yet." };
}

export function developmentStateForTickets(
  tickets: JiraTicket[],
  queryResults: Array<{
    data?: JiraDevelopmentInfo;
    error: unknown;
    isFetching: boolean;
    isLoading: boolean;
  }>,
  hasLiveTickets: boolean
) {
  const developmentByKey = new Map<string, JiraDevelopmentInfo>();
  const developmentStatusByKey = new Map<string, IntegrationStatus>();
  for (const [index, queryResult] of queryResults.entries()) {
    const ticket = tickets[index];
    if (!ticket) {
      continue;
    }
    if (queryResult.data) {
      developmentByKey.set(ticket.key, queryResult.data);
    }
    if (hasLiveTickets) {
      developmentStatusByKey.set(
        ticket.key,
        integrationStatusFromDevelopmentQuery(queryResult)
      );
    }
  }
  return { developmentByKey, developmentStatusByKey };
}

export function refetchDevelopmentQueries(
  queryResults: Array<{ refetch: () => Promise<unknown> }>
): void {
  for (const queryResult of queryResults) {
    queryResult.refetch();
  }
}

export function githubFallbackDifferenceCount(
  developmentByKey: Map<string, JiraDevelopmentInfo>
): number {
  return [...developmentByKey.values()].reduce(
    (count, info) =>
      count +
      info.branches.filter((branch) => branch.source === "github").length +
      info.pullRequests.filter((pr) => pr.source === "github").length,
    0
  );
}

export function hasActiveDeploymentBatches(
  batches: DeploymentBatch[] | undefined
): boolean {
  return Boolean(
    batches?.some(
      (batch) => !TERMINAL_DEPLOYMENT_STATES.has(batch.aggregateState)
    )
  );
}

export function deploymentBatchesPollingInterval(
  batches: DeploymentBatch[] | undefined
): false | number {
  const intervals = batches
    ?.map(
      (batch) =>
        deploymentPollingInterval(batch) ||
        deploymentHistoryExpiryInterval(batch)
    )
    .filter((interval): interval is number => interval !== false);

  if (!intervals?.length) {
    return false;
  }
  return Math.min(...intervals);
}

function deploymentHistoryExpiryInterval(
  batch: DeploymentBatch
): false | number {
  if (!TERMINAL_DEPLOYMENT_STATES.has(batch.aggregateState)) {
    return false;
  }
  const expiresIn =
    batch.updatedAt + DEPLOYMENT_HISTORY_RETENTION_MS - Date.now();
  return Math.max(1000, expiresIn);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
