import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, History, Loader2, Rocket, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { deleteDeploymentBatch, getDeploymentBatches } from "@/actions/bfd";
import { openExternalLink } from "@/actions/shell";
import { DEPLOYMENT_POLLING_INTERVAL_MS } from "@/components/deployment-dialog-helpers";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { APP_EVENTS } from "@/constants";
import { devSystemUrl } from "@/domain/urls";
import { deploymentBatchesPollingInterval } from "@/lib/dashboard-helpers";
import type { DeploymentBatch, DeploymentRunState } from "@/types/bfd";
import { cn } from "@/utils/tailwind";

const MAX_LOCAL_DEPLOYMENT_HISTORY = 100;
const NUMERIC_ENVIRONMENT_LABEL_PATTERN = /^\d+$/;
const EMPTY_DEPLOYMENT_BATCHES: DeploymentBatch[] = [];
const TERMINAL_DEPLOYMENT_STATES = new Set<DeploymentRunState>([
  "cancelled",
  "failure",
  "success",
  "timed-out",
]);

function deploymentStateLabel(state: DeploymentRunState): string {
  switch (state) {
    case "pending-dispatch":
      return "dispatching";
    case "in-progress":
      return "running";
    case "timed-out":
      return "timed out";
    default:
      return state;
  }
}

function activeDeploymentCount(batches: DeploymentBatch[]): number {
  return batches.filter(
    (batch) => !TERMINAL_DEPLOYMENT_STATES.has(batch.aggregateState)
  ).length;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function deploymentEnvironmentLabel(environment: string): string {
  return NUMERIC_ENVIRONMENT_LABEL_PATTERN.test(environment)
    ? `dev-${environment}`
    : environment;
}

function durationLabel(start: number, end: number): string {
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0
    ? `${minutes}m ${remainingSeconds}s`
    : `${minutes}m`;
}

export default function DeploymentHistoryLauncher() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const historySeededRef = useRef(false);
  const seenIdsRef = useRef(new Set<string>());
  const deploymentBatchesQuery = useQuery({
    queryKey: ["bfd", "deployments"],
    queryFn: getDeploymentBatches,
    refetchInterval: (query) =>
      deploymentBatchesPollingInterval(query.state.data),
    retry: false,
    staleTime: DEPLOYMENT_POLLING_INTERVAL_MS,
  });
  const deleteDeploymentMutation = useMutation({
    mutationFn: deleteDeploymentBatch,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bfd", "deployments"] });
    },
  });
  const batches = deploymentBatchesQuery.data ?? EMPTY_DEPLOYMENT_BATCHES;
  const sortedBatches = batches
    .toSorted((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_LOCAL_DEPLOYMENT_HISTORY);
  const activeCount = activeDeploymentCount(sortedBatches);
  const badgeCount = open || activeCount > 0 ? 0 : unreadCount;

  useEffect(() => {
    function onOpenDeploymentHistory() {
      seenIdsRef.current = new Set(batches.map((batch) => batch.id));
      setUnreadCount(0);
      setOpen(true);
    }

    window.addEventListener(
      APP_EVENTS.OPEN_DEPLOYMENT_HISTORY,
      onOpenDeploymentHistory
    );
    return () =>
      window.removeEventListener(
        APP_EVENTS.OPEN_DEPLOYMENT_HISTORY,
        onOpenDeploymentHistory
      );
  }, [batches]);

  useEffect(() => {
    const currentIds = new Set(batches.map((batch) => batch.id));
    if (!historySeededRef.current) {
      seenIdsRef.current = currentIds;
      historySeededRef.current = true;
      return;
    }

    const newIds = [...currentIds].filter((id) => !seenIdsRef.current.has(id));
    if (newIds.length === 0) {
      return;
    }

    seenIdsRef.current = new Set([...seenIdsRef.current, ...newIds]);
    setUnreadCount((current) => (open ? 0 : current + newIds.length));
  }, [batches, open]);

  function updateOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      return;
    }
    seenIdsRef.current = new Set(batches.map((batch) => batch.id));
    setUnreadCount(0);
  }

  function deleteDeploymentEvent(batch: DeploymentBatch) {
    if (!TERMINAL_DEPLOYMENT_STATES.has(batch.aggregateState)) {
      return;
    }

    deleteDeploymentMutation.mutate(batch.id);
  }

  return (
    <Sheet onOpenChange={updateOpen} open={open}>
      <SheetTrigger asChild>
        <button
          aria-label="Open deployment history"
          className="fixed right-6 bottom-6 z-40 inline-flex size-12 items-center justify-center rounded-full border border-border bg-primary text-primary-foreground shadow-xl transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          type="button"
        >
          {activeCount > 0 ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <History className="size-5" />
          )}
          {badgeCount > 0 && (
            <span className="absolute -top-1 -right-1 flex min-w-5 items-center justify-center rounded-full bg-background px-1.5 py-0.5 font-medium text-[0.625rem] text-foreground shadow">
              {badgeCount}
            </span>
          )}
        </button>
      </SheetTrigger>
      <SheetContent className="w-[min(100vw,480px)]">
        <SheetHeader>
          <SheetTitle>Deployment history</SheetTitle>
          <SheetDescription>
            Local deployments started from this app. Active runs refresh from
            GitHub while polling is enabled.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {sortedBatches.length === 0 ? (
            <div className="mt-8 rounded-xl border border-border border-dashed p-6 text-center text-muted-foreground text-sm">
              No deployments have been started from this app yet.
            </div>
          ) : (
            <div className="grid gap-3">
              {sortedBatches.map((batch) => (
                <DeploymentHistoryItem
                  batch={batch}
                  key={batch.id}
                  onDelete={deleteDeploymentEvent}
                />
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DeploymentHistoryItem({
  batch,
  onDelete,
}: {
  batch: DeploymentBatch;
  onDelete: (batch: DeploymentBatch) => void;
}) {
  const active = !TERMINAL_DEPLOYMENT_STATES.has(batch.aggregateState);
  return (
    <article className="rounded-xl border border-border bg-card p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium font-mono text-sm">
              {batch.ticketKey ?? batch.branch}
            </span>
            <Badge
              variant={
                active ? "info" : deploymentBadgeVariant(batch.aggregateState)
              }
            >
              {active && <Loader2 className="animate-spin" />}
              {deploymentStateLabel(batch.aggregateState)}
            </Badge>
          </div>
          <div className="mt-1 text-muted-foreground text-xs">
            {batch.branch} to{" "}
            <button
              className="font-medium text-foreground underline-offset-2 hover:underline"
              onClick={() => openExternalLink(devSystemUrl(batch.environment))}
              type="button"
            >
              {deploymentEnvironmentLabel(batch.environment)}
            </button>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!active && (
            <button
              aria-label={`Delete deployment event for ${batch.ticketKey ?? batch.branch}`}
              className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => onDelete(batch)}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          )}
          <Rocket className="size-4 text-muted-foreground" />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
        <span>Started {formatTime(batch.createdAt)}</span>
        <span aria-hidden="true">·</span>
        <span>Duration {durationLabel(batch.createdAt, batch.updatedAt)}</span>
      </div>

      <div className="mt-3 divide-y divide-border border-border border-t">
        {batch.workflows.map((workflow) => (
          <button
            className={cn(
              "grid w-full gap-1 py-2.5 text-left transition-colors",
              workflow.runUrl
                ? "hover:bg-muted/25"
                : "cursor-default text-muted-foreground"
            )}
            disabled={!workflow.runUrl}
            key={`${batch.id}-${workflow.targetName}`}
            onClick={() => workflow.runUrl && openExternalLink(workflow.runUrl)}
            type="button"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium text-sm">
                {workflow.targetName}
              </span>
              <Badge variant={deploymentBadgeVariant(workflow.state)}>
                {deploymentStateLabel(workflow.state)}
              </Badge>
            </span>
            <span className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
              <span>
                {workflow.runId ? `run #${workflow.runId}` : "waiting for run"}
              </span>
              {workflow.runUrl && (
                <span className="inline-flex items-center gap-1 text-foreground">
                  Open action
                  <ExternalLink className="size-3" />
                </span>
              )}
            </span>
            {workflow.dispatchError && (
              <span className="text-destructive text-xs">
                {workflow.dispatchError}
              </span>
            )}
          </button>
        ))}
      </div>
    </article>
  );
}

function deploymentBadgeVariant(
  state: DeploymentRunState
): "danger" | "info" | "muted" | "success" | "warning" {
  switch (state) {
    case "success":
      return "success";
    case "failure":
    case "timed-out":
      return "danger";
    case "cancelled":
      return "warning";
    case "in-progress":
    case "queued":
      return "info";
    default:
      return "muted";
  }
}
