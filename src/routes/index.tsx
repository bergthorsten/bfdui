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
  type ReactNode,
  type RefObject,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getActiveSprint,
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
import {
  dashboardEmptyMessage,
  dashboardResultLabel,
  dashboardUpdatedLabel,
  developmentStateForTickets,
  EMPTY_SPRINT_FILTER,
  githubFallbackDifferenceCount,
  hasActiveDeploymentBatches,
  integrationStatusFromDevSystemsQuery,
  refetchDevelopmentQueries,
  rowMatchesSprintFilter,
  rowsForTickets,
  type SprintFilter,
  type SprintFilterState,
  searchRows,
  sprintRemainingLabel,
} from "@/routes/dashboard-helpers";
import type { JiraSprint } from "@/types/bfd";
import { cn } from "@/utils/tailwind";

const SHOW_STAT_CARDS = false;
const JIRA_DEVELOPMENT_CACHE_MS = 10 * 60_000;
const DASHBOARD_UPDATED_LABEL_INTERVAL_MS = 30_000;
const SPRINT_FILTERS: { key: SprintFilter; label: string }[] = [
  { key: "hide-open", label: "Hide open" },
  { key: "hide-closed", label: "Hide closed" },
];

function dashboardHeaderDescription({
  activeSprint,
  activeSprintFetching,
  normalizedQuery,
  now,
  previewMode,
  resultLabel,
}: {
  activeSprint?: JiraSprint | null;
  activeSprintFetching: boolean;
  normalizedQuery: string;
  now: number;
  previewMode: boolean;
  resultLabel: string;
}): ReactNode {
  if (normalizedQuery) {
    return resultLabel;
  }

  if (activeSprint) {
    const remainingLabel = sprintRemainingLabel(activeSprint, now);
    return (
      <div className="flex max-w-3xl flex-col gap-1">
        {activeSprint.goal ? (
          <span className="text-foreground">{activeSprint.goal}</span>
        ) : (
          <span>No sprint goal set.</span>
        )}
        {remainingLabel && <span>{remainingLabel}</span>}
      </div>
    );
  }

  if (activeSprintFetching && !previewMode) {
    return "Loading sprint details from Jira.";
  }

  return resultLabel;
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
  const activeSprintQuery = useQuery({
    queryKey: [
      "bfd",
      "jira",
      "activeSprint",
      configQuery.data?.config.jira.sprintJql,
    ],
    queryFn: getActiveSprint,
    enabled: Boolean(configQuery.data?.config.jira.sprintJql),
    retry: false,
    staleTime: 60_000,
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
  const searchedRows = useMemo(
    () => searchRows(allRows, normalizedQuery),
    [normalizedQuery, allRows]
  );
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
  const headerDescription = dashboardHeaderDescription({
    activeSprint: activeSprintQuery.data,
    activeSprintFetching: activeSprintQuery.isFetching,
    normalizedQuery,
    now,
    previewMode,
    resultLabel,
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
    activeSprintQuery.dataUpdatedAt,
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
      (activeSprintQuery.data && activeSprintQuery.isFetching) ||
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
      activeSprintQuery.refetch(),
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
              activeSprintQuery.isFetching ||
              ticketsQuery.isFetching ||
              deploymentsQuery.isFetching ||
              deploymentBatchesQuery.isFetching
            }
            onRefresh={refreshJira}
            updatedLabel={updatedLabel}
          />
        }
        description={headerDescription}
        title={activeSprintQuery.data?.name ?? "Sprint tickets"}
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
