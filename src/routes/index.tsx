import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  CircleCheck,
  Clock,
  Loader2,
  RefreshCw,
  Search,
  Server,
  TriangleAlert,
} from "lucide-react";
import {
  type RefObject,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getBfdConfig,
  getDeploymentBatches,
  getDevDeployments,
  getSprintTickets,
  getTicketDevelopment,
  searchTickets,
} from "@/actions/bfd";
import PageHeader from "@/components/page-header";
import StatCard from "@/components/stat-card";
import TicketsTable from "@/components/tickets-table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  MOCK_DEPLOYMENTS,
  MOCK_OUTDATED,
  MOCK_PIPELINE_FAILURES,
  MOCK_TICKETS,
} from "@/data/mock";
import { DEFAULT_GITHUB_REPO } from "@/domain/urls";
import type {
  DeploymentBatch,
  DevDeployment,
  IntegrationStatus,
  JiraDevelopmentInfo,
  JiraTicket,
  TicketDeploymentRow,
} from "@/types/bfd";
import { cn } from "@/utils/tailwind";

const SHOW_STAT_CARDS = false;
const JIRA_DEVELOPMENT_CACHE_MS = 10 * 60_000;
const DASHBOARD_UPDATED_LABEL_INTERVAL_MS = 30_000;
const TERMINAL_DEPLOYMENT_STATES = new Set([
  "cancelled",
  "failure",
  "success",
  "timed-out",
]);

type SprintFilter = "hide-closed" | "hide-open";

const SPRINT_FILTERS: { key: SprintFilter; label: string }[] = [
  { key: "hide-open", label: "Hide open" },
  { key: "hide-closed", label: "Hide closed" },
];

interface SprintFilterState {
  hideClosed: boolean;
  hideOpen: boolean;
}

const EMPTY_SPRINT_FILTER: SprintFilterState = {
  hideClosed: false,
  hideOpen: false,
};

function rowsForTickets(
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

function formatRelativeUpdate(timestamp: number, now: number): string {
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

function dashboardUpdatedLabel({
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
  if (previewMode) {
    return "preview data";
  }
  return "not loaded yet";
}

function rowMatchesSprintFilter(
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

function dashboardResultLabel({
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
      if (ticketsFetching) {
        return `${ticketsCount} Jira tickets loaded from cache while the configured sprint JQL refreshes.`;
      }
      return `${ticketsCount} Jira tickets loaded from the configured sprint JQL.`;
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

function dashboardEmptyMessage({
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
  if (previewMode) {
    return "No preview tickets match this search/filter.";
  }
  return "No sprint tickets match this search/filter.";
}

function integrationStatusFromDevelopmentQuery(queryResult: {
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

function integrationStatusFromDevSystemsQuery(queryResult: {
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

function developmentStateForTickets(
  tickets: JiraTicket[],
  queryResults: Array<{
    data?: JiraDevelopmentInfo;
    error: unknown;
    isFetching: boolean;
    isLoading: boolean;
  }>,
  hasLiveTickets: boolean
): {
  developmentByKey: Map<string, JiraDevelopmentInfo>;
  developmentStatusByKey: Map<string, IntegrationStatus>;
} {
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

function refetchDevelopmentQueries(
  queryResults: Array<{ refetch: () => Promise<unknown> }>
): void {
  for (const queryResult of queryResults) {
    queryResult.refetch();
  }
}

function githubFallbackDifferenceCount(
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

function hasActiveDeploymentBatches(
  batches: DeploymentBatch[] | undefined
): boolean {
  return Boolean(
    batches?.some(
      (batch) => !TERMINAL_DEPLOYMENT_STATES.has(batch.aggregateState)
    )
  );
}

function DashboardAlerts({
  deploymentsError,
  jiraSearchError,
  onRetryJira,
  previewMode,
  shouldSearchJira,
  showDeploymentsError,
  ticketsError,
}: {
  deploymentsError: unknown;
  jiraSearchError: unknown;
  onRetryJira: () => void;
  previewMode: boolean;
  shouldSearchJira: boolean;
  showDeploymentsError: boolean;
  ticketsError: unknown;
}) {
  return (
    <>
      {ticketsError && previewMode && (
        <Alert variant="warning">
          <AlertDescription>
            Jira tickets could not be loaded before setup is complete:{" "}
            {messageOf(ticketsError)}. Showing preview data.
          </AlertDescription>
        </Alert>
      )}

      {ticketsError && !previewMode && (
        <Alert
          className="flex items-center justify-between gap-3"
          variant="danger"
        >
          <AlertDescription>
            Jira tickets could not be loaded: {messageOf(ticketsError)}. Live
            sprint data is hidden until Jira works again.
          </AlertDescription>
          <div className="flex shrink-0 items-center gap-2">
            <Button onClick={onRetryJira} size="sm" variant="outline">
              Retry Jira
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/settings">Open settings</Link>
            </Button>
          </div>
        </Alert>
      )}

      {jiraSearchError && shouldSearchJira && (
        <Alert variant="warning">
          <AlertDescription>
            Jira global search failed: {messageOf(jiraSearchError)}
          </AlertDescription>
        </Alert>
      )}

      {deploymentsError && showDeploymentsError && (
        <Alert variant="warning">
          <AlertDescription>
            Dev-system state could not be loaded from ArgoCD:{" "}
            {messageOf(deploymentsError)}.
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}

function DashboardStats({
  freeCount,
  occupiedCount,
}: {
  freeCount: number;
  occupiedCount: number;
}) {
  if (!SHOW_STAT_CARDS) {
    return null;
  }

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard
        hint="ready to deploy"
        icon={CircleCheck}
        label="Free systems"
        tone="success"
        value={freeCount}
      />
      <StatCard
        icon={Server}
        label="Occupied systems"
        tone="info"
        value={occupiedCount}
      />
      <StatCard
        hint="needs attention"
        icon={TriangleAlert}
        label="Pipeline failures"
        tone={MOCK_PIPELINE_FAILURES > 0 ? "danger" : "default"}
        value={MOCK_PIPELINE_FAILURES}
      />
      <StatCard
        hint="new commits available"
        icon={Clock}
        label="Outdated deploys"
        tone={MOCK_OUTDATED > 0 ? "warning" : "default"}
        value={MOCK_OUTDATED}
      />
    </div>
  );
}

function DashboardHeaderActions({
  isRefreshing,
  onRefresh,
  updatedLabel,
}: {
  isRefreshing: boolean;
  onRefresh: () => void;
  updatedLabel: string;
}) {
  return (
    <>
      <span className="whitespace-nowrap text-muted-foreground text-xs">
        Updated at: {updatedLabel}
      </span>
      <Button
        disabled={isRefreshing}
        onClick={onRefresh}
        size="sm"
        variant="outline"
      >
        {isRefreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        Refresh data
      </Button>
    </>
  );
}

function DashboardControls({
  allFilterActive,
  filter,
  jiraSearchFetching,
  onQueryChange,
  onResetFilter,
  onToggleFilter,
  query,
  searchRef,
}: {
  allFilterActive: boolean;
  filter: SprintFilterState;
  jiraSearchFetching: boolean;
  onQueryChange: (value: string) => void;
  onResetFilter: () => void;
  onToggleFilter: (key: SprintFilter) => void;
  query: string;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-0.5 shadow-xs">
        <button
          className={cn(
            "rounded-md px-2.5 py-1 font-medium text-xs transition-colors",
            allFilterActive
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={onResetFilter}
          type="button"
        >
          All
        </button>
        {SPRINT_FILTERS.map((option) => (
          <button
            className={cn(
              "rounded-md px-2.5 py-1 font-medium text-xs transition-colors",
              (option.key === "hide-open" ? filter.hideOpen : filter.hideClosed)
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
            key={option.key}
            onClick={() => onToggleFilter(option.key)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="relative w-80">
        {jiraSearchFetching ? (
          <Loader2 className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
        ) : (
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        )}
        <Input
          className="pl-8"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search ticket or topic..."
          ref={searchRef}
          value={query}
        />
      </div>
    </div>
  );
}

function Dashboard() {
  const [filter, setFilter] = useState<SprintFilterState>(EMPTY_SPRINT_FILTER);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const deferredQuery = useDeferredValue(query);
  const searchRef = useRef<HTMLInputElement>(null);
  const configQuery = useQuery({
    queryKey: ["bfd", "config"],
    queryFn: getBfdConfig,
    retry: false,
  });
  const ticketsQuery = useQuery({
    queryKey: ["bfd", "jira", "sprintTickets"],
    queryFn: getSprintTickets,
    retry: false,
  });
  const canShowPreview = configQuery.data
    ? !configQuery.data.config.onboardingComplete
    : false;
  const previewMode = canShowPreview && !ticketsQuery.data;
  const sprintTickets = ticketsQuery.data ?? (previewMode ? MOCK_TICKETS : []);
  const deploymentsQuery = useQuery({
    queryKey: ["bfd", "argo", "devDeployments"],
    queryFn: getDevDeployments,
    retry: false,
    staleTime: 30_000,
  });
  const deploymentBatchesQuery = useQuery({
    queryKey: ["bfd", "deployments"],
    queryFn: getDeploymentBatches,
    refetchInterval: (query) =>
      hasActiveDeploymentBatches(query.state.data) ? 5000 : false,
    retry: false,
  });
  const devDeployments = deploymentsQuery.data ?? [];
  const developmentQueries = useQueries({
    queries: sprintTickets.map((ticket) => ({
      queryKey: ["bfd", "jira", "development", ticket.id],
      queryFn: () =>
        getTicketDevelopment({ issueId: ticket.id, ticketKey: ticket.key }),
      enabled: Boolean(ticketsQuery.data && ticket.id),
      retry: false,
      staleTime: JIRA_DEVELOPMENT_CACHE_MS,
      gcTime: JIRA_DEVELOPMENT_CACHE_MS * 2,
      refetchOnMount: false,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
    })),
  });

  const statDeployments = previewMode ? MOCK_DEPLOYMENTS : devDeployments;
  const freeCount = statDeployments.filter((d) => d.isFree).length;
  const occupiedCount = statDeployments.filter(
    (d) => !(d.isFree || d.reserved)
  ).length;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const id = window.setInterval(
      () => setNow(Date.now()),
      DASHBOARD_UPDATED_LABEL_INTERVAL_MS
    );
    return () => window.clearInterval(id);
  }, []);

  const { developmentByKey, developmentStatusByKey } =
    developmentStateForTickets(
      sprintTickets,
      developmentQueries,
      Boolean(ticketsQuery.data)
    );
  const fallbackDifferenceCount =
    githubFallbackDifferenceCount(developmentByKey);
  const devSystemStatus = previewMode
    ? undefined
    : integrationStatusFromDevSystemsQuery(deploymentsQuery);

  const allRows = rowsForTickets(sprintTickets, {
    developmentByKey,
    developmentStatusByKey,
    deployments: devDeployments,
    devSystemStatus,
    includeMockDeployments: previewMode,
  });

  const normalizedQuery = deferredQuery.trim();
  const searchedRows = useMemo(() => {
    const q = normalizedQuery.toLowerCase();
    if (!q) {
      return allRows;
    }
    return allRows.filter(
      ({ ticket }) =>
        ticket.key.toLowerCase().includes(q) ||
        ticket.title.toLowerCase().includes(q)
    );
  }, [normalizedQuery, allRows]);
  const localRows = useMemo(
    () => searchedRows.filter((row) => rowMatchesSprintFilter(row, filter)),
    [searchedRows, filter]
  );

  const shouldSearchJira =
    !previewMode && normalizedQuery.length >= 2 && searchedRows.length === 0;
  const jiraSearchQuery = useQuery({
    queryKey: ["bfd", "jira", "ticketSearch", normalizedQuery],
    queryFn: () => searchTickets(normalizedQuery),
    enabled: shouldSearchJira,
    retry: false,
  });

  const rows = useMemo(() => {
    if (shouldSearchJira && jiraSearchQuery.data) {
      return rowsForTickets(jiraSearchQuery.data, {
        deployments: devDeployments,
        devSystemStatus,
      }).filter((row) => rowMatchesSprintFilter(row, filter));
    }
    return localRows;
  }, [
    shouldSearchJira,
    jiraSearchQuery.data,
    localRows,
    devDeployments,
    devSystemStatus,
    filter,
  ]);

  const resultLabel = dashboardResultLabel({
    jiraSearchCount: jiraSearchQuery.data?.length,
    jiraSearchFetching: jiraSearchQuery.isFetching,
    localRowsCount: localRows.length,
    normalizedQuery,
    previewMode,
    searchedRowsCount: searchedRows.length,
    ticketsCount: ticketsQuery.data?.length,
    ticketsError: ticketsQuery.error,
    ticketsFetching: ticketsQuery.isFetching,
  });
  const emptyMessage = dashboardEmptyMessage({
    jiraSearchFetching: jiraSearchQuery.isFetching,
    normalizedQuery,
    previewMode,
    shouldSearchJira,
    ticketsError: ticketsQuery.error,
    ticketsFetching: ticketsQuery.isFetching,
  });

  const lastUpdatedAt = Math.max(
    ticketsQuery.dataUpdatedAt,
    deploymentsQuery.dataUpdatedAt,
    deploymentBatchesQuery.dataUpdatedAt,
    ...developmentQueries.map((queryResult) => queryResult.dataUpdatedAt)
  );
  const updatedLabel = dashboardUpdatedLabel({
    lastUpdatedAt,
    now,
    previewMode,
    refreshingCachedData:
      (ticketsQuery.data && ticketsQuery.isFetching) ||
      (deploymentsQuery.data && deploymentsQuery.isFetching) ||
      (deploymentBatchesQuery.data && deploymentBatchesQuery.isFetching) ||
      developmentQueries.some(
        (queryResult) => queryResult.data && queryResult.isFetching
      ),
  });
  const allFilterActive = !(filter.hideOpen || filter.hideClosed);

  function toggleSprintFilter(key: SprintFilter) {
    setFilter((current) => ({
      ...current,
      [key === "hide-open" ? "hideOpen" : "hideClosed"]:
        !current[key === "hide-open" ? "hideOpen" : "hideClosed"],
    }));
  }

  async function refreshJira() {
    await Promise.all([
      ticketsQuery.refetch(),
      deploymentsQuery.refetch(),
      deploymentBatchesQuery.refetch(),
    ]);
    refetchDevelopmentQueries(developmentQueries);
  }

  return (
    <>
      <PageHeader
        actions={
          <DashboardHeaderActions
            isRefreshing={
              ticketsQuery.isFetching ||
              deploymentsQuery.isFetching ||
              deploymentBatchesQuery.isFetching
            }
            onRefresh={refreshJira}
            updatedLabel={updatedLabel}
          />
        }
        description={resultLabel}
        title="Sprint tickets"
      />
      <div className="flex min-h-0 flex-1 items-start overflow-auto">
        <div className="mx-auto flex w-full min-w-[72rem] max-w-[1480px] shrink-0 flex-col gap-5 p-6 pb-24">
          <DashboardStats freeCount={freeCount} occupiedCount={occupiedCount} />

          <DashboardControls
            allFilterActive={allFilterActive}
            filter={filter}
            jiraSearchFetching={jiraSearchQuery.isFetching}
            onQueryChange={setQuery}
            onResetFilter={() => setFilter(EMPTY_SPRINT_FILTER)}
            onToggleFilter={toggleSprintFilter}
            query={query}
            searchRef={searchRef}
          />

          {fallbackDifferenceCount > 3 && (
            <Alert variant="warning">
              <AlertDescription>
                GitHub fallback found {fallbackDifferenceCount} PR/branch items
                that Jira dev-status did not provide. Jira remains primary;
                check Jira development links if this keeps happening.
              </AlertDescription>
            </Alert>
          )}

          <DashboardAlerts
            deploymentsError={deploymentsQuery.error}
            jiraSearchError={jiraSearchQuery.error}
            onRetryJira={() => ticketsQuery.refetch()}
            previewMode={previewMode}
            shouldSearchJira={shouldSearchJira}
            showDeploymentsError={!previewMode}
            ticketsError={ticketsQuery.error}
          />

          <Card className="overflow-hidden">
            <TicketsTable
              deploymentBatches={deploymentBatchesQuery.data ?? []}
              deployments={devDeployments}
              emptyMessage={emptyMessage}
              github={configQuery.data?.config.github ?? DEFAULT_GITHUB_REPO}
              rows={rows}
            />
          </Card>
        </div>
      </div>
    </>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const Route = createFileRoute("/")({
  component: Dashboard,
});
