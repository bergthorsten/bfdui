import { useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { getBfdConfig, getDevDeployments, searchTickets } from "@/actions/bfd";
import DevSystemsTable from "@/components/dev-systems-table";
import PageHeader from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DEFAULT_GITHUB_REPO } from "@/domain/urls";
import { dashboardUpdatedLabel } from "@/routes/dashboard-helpers";
import type { JiraTicket } from "@/types/bfd";
import { cn } from "@/utils/tailwind";

type Filter = "all" | "free" | "occupied";
const SYSTEMS_UPDATED_LABEL_INTERVAL_MS = 30_000;

function systemsDescription({
  filteredCount,
  query,
  totalCount,
}: {
  filteredCount: number;
  query: string;
  totalCount: number;
}) {
  if (query) {
    return `${filteredCount} of ${totalCount} dev systems match this search/filter.`;
  }
  return `Live deployment state across ${totalCount} dev systems (ArgoCD).`;
}

function SystemsHeaderActions({
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

function DevSystems() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [now, setNow] = useState(() => Date.now());
  const deferredQuery = useDeferredValue(query);
  const searchRef = useRef<HTMLInputElement>(null);
  const deploymentsQuery = useQuery({
    queryKey: ["bfd", "argo", "devDeployments"],
    queryFn: getDevDeployments,
    retry: false,
    staleTime: 30_000,
  });
  const configQuery = useQuery({
    queryKey: ["bfd", "config"],
    queryFn: getBfdConfig,
    retry: false,
  });
  const deployments = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return [...(deploymentsQuery.data ?? [])].filter((d) => {
      if (filter === "free" && !d.isFree) {
        return false;
      }
      if (filter === "occupied" && (d.isFree || d.reserved)) {
        return false;
      }
      if (!q) {
        return true;
      }
      return (
        d.environment.toLowerCase().includes(q) ||
        (d.branch?.toLowerCase().includes(q) ?? false) ||
        (d.ticketKey?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [deferredQuery, filter, deploymentsQuery.data]);
  const ticketKeys = useMemo(
    () => [...new Set(deployments.flatMap((d) => d.ticketKey ?? []))],
    [deployments]
  );
  const ticketQueries = useQueries({
    queries: ticketKeys.map((key) => ({
      queryKey: ["bfd", "jira", "ticket", key],
      queryFn: () => searchTickets(key),
      retry: false,
      staleTime: 60_000,
    })),
  });
  const ticketsByKey = new Map<string, JiraTicket>();
  for (const queryResult of ticketQueries) {
    const ticket = queryResult.data?.[0];
    if (ticket) {
      ticketsByKey.set(ticket.key, ticket);
    }
  }
  const jiraTicketsFetching = ticketQueries.some(
    (queryResult) => queryResult.isFetching
  );
  const isRefreshing = deploymentsQuery.isFetching || jiraTicketsFetching;
  const totalCount = deploymentsQuery.data?.length ?? 0;
  const lastUpdatedAt = Math.max(
    deploymentsQuery.dataUpdatedAt,
    configQuery.dataUpdatedAt,
    ...ticketQueries.map((queryResult) => queryResult.dataUpdatedAt)
  );
  const updatedLabel = dashboardUpdatedLabel({
    lastUpdatedAt,
    now,
    previewMode: false,
    refreshingCachedData:
      (deploymentsQuery.data && deploymentsQuery.isFetching) ||
      ticketQueries.some(
        (queryResult) => queryResult.data && queryResult.isFetching
      ),
  });
  const description = systemsDescription({
    filteredCount: deployments.length,
    query: deferredQuery.trim(),
    totalCount,
  });

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
      SYSTEMS_UPDATED_LABEL_INTERVAL_MS
    );
    return () => window.clearInterval(id);
  }, []);

  function refreshSystems() {
    deploymentsQuery.refetch();
    for (const queryResult of ticketQueries) {
      queryResult.refetch();
    }
  }

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "free", label: "Free" },
    { key: "occupied", label: "Occupied" },
  ];

  return (
    <>
      <PageHeader
        actions={
          <SystemsHeaderActions
            isRefreshing={isRefreshing}
            onRefresh={refreshSystems}
            updatedLabel={updatedLabel}
          />
        }
        description={description}
        title="Dev Systems"
      />
      <div className="flex min-h-0 flex-1 items-start overflow-auto">
        <div className="mx-auto flex w-full min-w-[72rem] max-w-[1480px] shrink-0 flex-col gap-5 p-6 pb-24">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-0.5 shadow-xs">
              {filters.map((f) => (
                <button
                  className={cn(
                    "rounded-md px-2.5 py-1 font-medium text-xs transition-colors",
                    filter === f.key
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  type="button"
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="relative w-80">
              {jiraTicketsFetching ? (
                <Loader2 className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
              ) : (
                <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              )}
              <Input
                className="pl-8"
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search system, branch, ticket…"
                ref={searchRef}
                value={query}
              />
            </div>
          </div>

          {deploymentsQuery.error && (
            <Alert variant="warning">
              <AlertDescription>
                Dev-system state could not be loaded from ArgoCD:{" "}
                {messageOf(deploymentsQuery.error)}.
              </AlertDescription>
            </Alert>
          )}

          <Card className="overflow-hidden">
            <DevSystemsTable
              deployments={deployments}
              github={configQuery.data?.config.github ?? DEFAULT_GITHUB_REPO}
              jiraBaseUrl={configQuery.data?.config.jira.baseUrl}
              ticketsByKey={ticketsByKey}
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

export const Route = createFileRoute("/systems")({
  component: DevSystems,
});
