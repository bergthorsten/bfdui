import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { getDevDeployments, getSprintTickets } from "@/actions/bfd";
import DevSystemsTable from "@/components/dev-systems-table";
import PageHeader from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { DevDeployment } from "@/types/bfd";
import { cn } from "@/utils/tailwind";

type Filter = "all" | "free" | "occupied";

function rank(d: DevDeployment): number {
  if (d.isFree) {
    return 0;
  }
  if (d.reserved) {
    return 2;
  }
  return 1;
}

function DevSystems() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const deploymentsQuery = useQuery({
    queryKey: ["bfd", "argo", "devDeployments"],
    queryFn: getDevDeployments,
    retry: false,
    staleTime: 30_000,
  });
  const ticketsQuery = useQuery({
    queryKey: ["bfd", "jira", "sprintTickets"],
    queryFn: getSprintTickets,
    retry: false,
    staleTime: 60_000,
  });
  const ticketsByKey = new Map(
    (ticketsQuery.data ?? []).map((t) => [t.key, t])
  );

  const deployments = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...(deploymentsQuery.data ?? [])]
      .filter((d) => {
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
      })
      .sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r !== 0) {
          return r;
        }
        return (a.ageSeconds ?? 0) - (b.ageSeconds ?? 0);
      });
  }, [query, filter, deploymentsQuery.data]);

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "free", label: "Free" },
    { key: "occupied", label: "Occupied" },
  ];

  return (
    <>
      <PageHeader
        actions={
          <Button
            disabled={deploymentsQuery.isFetching}
            onClick={() => deploymentsQuery.refetch()}
            size="sm"
            variant="outline"
          >
            {deploymentsQuery.isFetching ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            Refresh
          </Button>
        }
        description="Live deployment state across all dev systems (ArgoCD)"
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
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search system, branch, ticket…"
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
