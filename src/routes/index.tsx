import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  CircleCheck,
  Clock,
  Loader2,
  RefreshCw,
  Search,
  Server,
  TriangleAlert,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
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
import type {
  DevDeployment,
  JiraDevelopmentInfo,
  JiraTicket,
  TicketDeploymentRow,
} from "@/types/bfd";
import { cn } from "@/utils/tailwind";

const SHOW_STAT_CARDS = false;
const JIRA_DEVELOPMENT_CACHE_MS = 10 * 60_000;
const DASHBOARD_UPDATED_LABEL_INTERVAL_MS = 30_000;

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
    deployments?: DevDeployment[];
    includeMockDeployments?: boolean;
  } = {}
): TicketDeploymentRow[] {
  return tickets.map((ticket) => {
    const development = options.developmentByKey?.get(ticket.key);
    return {
      ticket,
      branches: development?.branches ?? [],
      pullRequests: development?.pullRequests ?? [],
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
}: {
  lastUpdatedAt: number;
  now: number;
  previewMode: boolean;
}): string {
  if (lastUpdatedAt) {
    return formatRelativeUpdate(lastUpdatedAt, now);
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

function Dashboard() {
  const [filter, setFilter] = useState<SprintFilterState>(EMPTY_SPRINT_FILTER);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const deferredQuery = useDeferredValue(query);
  const searchRef = useRef<HTMLInputElement>(null);
  const ticketsQuery = useQuery({
    queryKey: ["bfd", "jira", "sprintTickets"],
    queryFn: getSprintTickets,
    retry: false,
  });
  const previewMode = !ticketsQuery.data;
  const sprintTickets = ticketsQuery.data ?? MOCK_TICKETS;
  const deploymentsQuery = useQuery({
    queryKey: ["bfd", "argo", "devDeployments"],
    queryFn: getDevDeployments,
    retry: false,
    staleTime: 30_000,
  });
  const devDeployments = deploymentsQuery.data ?? [];
  const developmentQueries = useQueries({
    queries: sprintTickets.map((ticket) => ({
      queryKey: ["bfd", "jira", "development", ticket.id],
      queryFn: () => getTicketDevelopment(ticket.id),
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

  const developmentByKey = new Map<string, JiraDevelopmentInfo>();
  for (const [index, queryResult] of developmentQueries.entries()) {
    const ticket = sprintTickets[index];
    if (ticket && queryResult.data) {
      developmentByKey.set(ticket.key, queryResult.data);
    }
  }

  const allRows = rowsForTickets(sprintTickets, {
    developmentByKey,
    deployments: devDeployments,
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
    normalizedQuery.length >= 2 && searchedRows.length === 0;
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
      }).filter((row) => rowMatchesSprintFilter(row, filter));
    }
    return localRows;
  }, [
    shouldSearchJira,
    jiraSearchQuery.data,
    localRows,
    devDeployments,
    filter,
  ]);

  const resultLabel = (() => {
    if (!normalizedQuery) {
      return ticketsQuery.data
        ? `${ticketsQuery.data.length} Jira tickets loaded from the configured sprint JQL.`
        : "Preview data shown until Jira credentials are configured.";
    }
    if (searchedRows.length > 0) {
      return `${localRows.length} local result${localRows.length === 1 ? "" : "s"} in the loaded sprint tickets.`;
    }
    if (jiraSearchQuery.isFetching) {
      return "No local match. Searching all accessible Jira tickets...";
    }
    if (jiraSearchQuery.data) {
      return `${jiraSearchQuery.data.length} Jira result${jiraSearchQuery.data.length === 1 ? "" : "s"} outside the loaded sprint result set.`;
    }
    return "No local match. Jira global search starts after 2 characters.";
  })();

  const lastUpdatedAt = Math.max(
    ticketsQuery.dataUpdatedAt,
    deploymentsQuery.dataUpdatedAt,
    ...developmentQueries.map((queryResult) => queryResult.dataUpdatedAt)
  );
  const updatedLabel = dashboardUpdatedLabel({
    lastUpdatedAt,
    now,
    previewMode,
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
    await Promise.all([ticketsQuery.refetch(), deploymentsQuery.refetch()]);
    for (const queryResult of developmentQueries) {
      queryResult.refetch();
    }
  }

  return (
    <>
      <PageHeader
        actions={
          <>
            <span className="whitespace-nowrap text-muted-foreground text-xs">
              Updated at: {updatedLabel}
            </span>
            <Button
              disabled={ticketsQuery.isFetching || deploymentsQuery.isFetching}
              onClick={refreshJira}
              size="sm"
              variant="outline"
            >
              {ticketsQuery.isFetching || deploymentsQuery.isFetching ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              Refresh data
            </Button>
          </>
        }
        description={resultLabel}
        title="Sprint tickets"
      />
      <div className="flex min-h-0 flex-1 items-start overflow-auto">
        <div className="mx-auto flex w-full min-w-[72rem] max-w-[1480px] shrink-0 flex-col gap-5 p-6 pb-24">
          {SHOW_STAT_CARDS && (
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
          )}

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-0.5 shadow-xs">
              <button
                className={cn(
                  "rounded-md px-2.5 py-1 font-medium text-xs transition-colors",
                  allFilterActive
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setFilter(EMPTY_SPRINT_FILTER)}
                type="button"
              >
                All
              </button>
              {SPRINT_FILTERS.map((option) => (
                <button
                  className={cn(
                    "rounded-md px-2.5 py-1 font-medium text-xs transition-colors",
                    (
                      option.key === "hide-open"
                        ? filter.hideOpen
                        : filter.hideClosed
                    )
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  key={option.key}
                  onClick={() => toggleSprintFilter(option.key)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="relative w-80">
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search ticket or topic..."
                ref={searchRef}
                value={query}
              />
            </div>
          </div>

          {ticketsQuery.error && (
            <Alert variant="warning">
              <AlertDescription>
                Jira tickets could not be loaded:{" "}
                {messageOf(ticketsQuery.error)}. Showing preview data instead.
              </AlertDescription>
            </Alert>
          )}

          {jiraSearchQuery.error && shouldSearchJira && (
            <Alert variant="warning">
              <AlertDescription>
                Jira global search failed: {messageOf(jiraSearchQuery.error)}
              </AlertDescription>
            </Alert>
          )}

          {deploymentsQuery.error && !previewMode && (
            <Alert variant="warning">
              <AlertDescription>
                Dev-system state could not be loaded from ArgoCD:{" "}
                {messageOf(deploymentsQuery.error)}.
              </AlertDescription>
            </Alert>
          )}

          <Card className="overflow-hidden">
            <TicketsTable deployments={devDeployments} rows={rows} />
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
