import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ExternalLink,
  Loader2,
  Rocket,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { openExternalLink } from "@/actions/shell";
import DeploymentDialog from "@/components/deployment-dialog";
import { JiraStatusBadge, PullRequestBadge } from "@/components/status-badges";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  devSystemUrl,
  type GithubRepoRef,
  githubPullRequestUrl,
} from "@/domain/urls";
import { initialsOf } from "@/lib/status";
import type {
  DeploymentBatch,
  DeploymentRunState,
  DevDeployment,
  DevelopmentDataSource,
  IntegrationStatus,
  TicketDeploymentRow,
} from "@/types/bfd";

type SortDirection = "asc" | "desc";
type SortKey = "assignee" | "deployed" | "prs" | "status" | "ticket" | "title";

interface SortState {
  direction: SortDirection;
  key: SortKey;
}

const SORTABLE_HEADERS: { className?: string; key: SortKey; label: string }[] =
  [
    { key: "ticket", label: "Ticket", className: "w-[5rem]" },
    { key: "title", label: "Title" },
    { key: "status", label: "Status", className: "w-[12rem]" },
    { key: "assignee", label: "Assignee", className: "w-[10rem]" },
    { key: "prs", label: "PRs", className: "w-[11rem]" },
    { key: "deployed", label: "Deployed to", className: "w-[11rem]" },
  ];
const TERMINAL_DEPLOYMENT_STATES = new Set<DeploymentRunState>([
  "cancelled",
  "failure",
  "success",
  "timed-out",
]);

function ticketSortValue(ticketKey: string): [string, number] {
  const [project = ticketKey, number = "0"] = ticketKey.split("-");
  return [project, Number(number) || 0];
}

function compareText(
  a: string | null | undefined,
  b: string | null | undefined
) {
  return (a ?? "").localeCompare(b ?? "", undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function compareTicket(a: string, b: string) {
  const [aProject, aNumber] = ticketSortValue(a);
  const [bProject, bNumber] = ticketSortValue(b);
  const project = compareText(aProject, bProject);
  return project || aNumber - bNumber;
}

function deploymentSortValue(row: TicketDeploymentRow) {
  return row.deployments.map((d) => d.environment).join(", ");
}

function prSortValue(row: TicketDeploymentRow) {
  return row.pullRequests.map((pr) => pr.number).join(", ");
}

function compareRows(
  a: TicketDeploymentRow,
  b: TicketDeploymentRow,
  key: SortKey
) {
  switch (key) {
    case "ticket":
      return compareTicket(a.ticket.key, b.ticket.key);
    case "title":
      return compareText(a.ticket.title, b.ticket.title);
    case "status":
      return compareText(a.ticket.status, b.ticket.status);
    case "assignee":
      return compareText(a.ticket.assignee, b.ticket.assignee);
    case "prs":
      return compareText(prSortValue(a), prSortValue(b));
    case "deployed":
      return compareText(deploymentSortValue(a), deploymentSortValue(b));
    default:
      return 0;
  }
}

function SortIcon({
  active,
  direction,
}: {
  active: boolean;
  direction: SortDirection;
}) {
  if (!active) {
    return <ArrowUpDown className="size-3 text-muted-foreground/60" />;
  }
  return direction === "asc" ? (
    <ArrowUp className="size-3" />
  ) : (
    <ArrowDown className="size-3" />
  );
}

function SortHeader({
  className,
  label,
  sortKey,
  sort,
  onSort,
}: {
  className?: string;
  label: string;
  onSort: (key: SortKey) => void;
  sort: SortState;
  sortKey: SortKey;
}) {
  const active = sort.key === sortKey;
  return (
    <TableHead className={className}>
      <button
        className="inline-flex items-center gap-1 text-left uppercase tracking-wide hover:text-foreground"
        onClick={() => onSort(sortKey)}
        type="button"
      >
        {label}
        <SortIcon active={active} direction={sort.direction} />
      </button>
    </TableHead>
  );
}

function dataSourceLabel(source: DevelopmentDataSource): string | null {
  switch (source) {
    case "enriched":
      return null;
    case "github":
      return "GitHub";
    case "jira":
      return "Jira";
    default:
      return source;
  }
}

function SourceBadge({ source }: { source: DevelopmentDataSource }) {
  const label = dataSourceLabel(source);
  if (!label) {
    return null;
  }

  return (
    <Badge className="px-1 text-[0.625rem]" variant="outline">
      {label}
    </Badge>
  );
}

function integrationStatusLabel(
  status: IntegrationStatus,
  label: string
): string {
  switch (status.kind) {
    case "loading":
      return `${label} loading`;
    case "refreshing":
      return `${label} cached`;
    case "warning":
      return `${label} partial`;
    case "error":
      return `${label} failed`;
    default:
      return label;
  }
}

function IntegrationStatusBadge({
  label,
  status,
}: {
  label: string;
  status?: IntegrationStatus;
}) {
  if (!status || status.kind === "ok" || status.kind === "idle") {
    return null;
  }

  const isLoading = status.kind === "loading" || status.kind === "refreshing";
  const variant = (() => {
    switch (status.kind) {
      case "error":
        return "danger";
      case "warning":
        return "warning";
      case "refreshing":
        return "info";
      default:
        return "muted";
    }
  })();

  return (
    <Badge title={status.message} variant={variant}>
      {isLoading ? <Loader2 className="animate-spin" /> : <TriangleAlert />}
      {integrationStatusLabel(status, label)}
    </Badge>
  );
}

function latestDeploymentByTicket(
  batches: DeploymentBatch[]
): Map<string, DeploymentBatch> {
  const byTicket = new Map<string, DeploymentBatch>();
  for (const batch of batches.toSorted((a, b) => b.createdAt - a.createdAt)) {
    if (batch.ticketKey && !byTicket.has(batch.ticketKey)) {
      byTicket.set(batch.ticketKey, batch);
    }
  }
  return byTicket;
}

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

function deploymentStateTone(
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

function firstDeploymentRunUrl(batch: DeploymentBatch): string | undefined {
  return batch.workflows.find((workflow) => workflow.runUrl)?.runUrl;
}

function DeploymentRunBadge({ batch }: { batch: DeploymentBatch }) {
  const runUrl = firstDeploymentRunUrl(batch);
  const label = `Deploy ${deploymentStateLabel(batch.aggregateState)}`;
  const badge = (
    <Badge
      title={`${batch.workflows.length} workflow${batch.workflows.length === 1 ? "" : "s"} for ${batch.branch}`}
      variant={deploymentStateTone(batch.aggregateState)}
    >
      {!TERMINAL_DEPLOYMENT_STATES.has(batch.aggregateState) && (
        <Loader2 className="animate-spin" />
      )}
      {label}
      {runUrl && <ExternalLink />}
    </Badge>
  );

  if (!runUrl) {
    return badge;
  }

  return (
    <button
      className="inline-flex"
      onClick={() => openExternalLink(runUrl)}
      type="button"
    >
      {badge}
    </button>
  );
}

export default function TicketsTable({
  deploymentBatches,
  deployments,
  emptyMessage = "No sprint tickets match this search/filter.",
  github,
  rows,
}: {
  deploymentBatches: DeploymentBatch[];
  deployments: DevDeployment[];
  emptyMessage?: string;
  github: GithubRepoRef;
  rows: TicketDeploymentRow[];
}) {
  const [deployRow, setDeployRow] = useState<TicketDeploymentRow | null>(null);
  const [sort, setSort] = useState<SortState>({
    key: "ticket",
    direction: "asc",
  });

  const sortedRows = useMemo(
    () =>
      rows.toSorted((a, b) => {
        const result = compareRows(a, b, sort.key);
        return sort.direction === "asc" ? result : -result;
      }),
    [rows, sort]
  );
  const deploymentByTicket = useMemo(
    () => latestDeploymentByTicket(deploymentBatches),
    [deploymentBatches]
  );

  function updateSort(key: SortKey) {
    setSort((current) => ({
      key,
      direction:
        current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {SORTABLE_HEADERS.map((header) => (
              <SortHeader
                className={header.className}
                key={header.key}
                label={header.label}
                onSort={updateSort}
                sort={sort}
                sortKey={header.key}
              />
            ))}
            <TableHead className="w-[6.75rem] text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedRows.length === 0 && (
            <TableRow>
              <TableCell
                className="py-8 text-center text-muted-foreground text-sm"
                colSpan={SORTABLE_HEADERS.length + 1}
              >
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
          {sortedRows.map((row) => {
            const {
              branches,
              deployments,
              developmentStatus,
              devSystemStatus,
              pullRequests,
              ticket,
            } = row;
            const showNoDevelopment =
              pullRequests.length === 0 &&
              branches.length === 0 &&
              developmentStatus?.kind !== "loading";
            const showBranchOnly =
              pullRequests.length === 0 && branches.length > 0;
            const showNotDeployed =
              deployments.length === 0 && devSystemStatus?.kind !== "loading";
            const latestDeployment = deploymentByTicket.get(ticket.key);
            return (
              <TableRow key={ticket.key}>
                <TableCell className="whitespace-nowrap">
                  <button
                    className="font-medium font-mono text-xs hover:underline"
                    onClick={() => openExternalLink(ticket.url)}
                    type="button"
                  >
                    {ticket.key}
                  </button>
                </TableCell>

                <TableCell className="max-w-[280px]">
                  <span className="block truncate text-sm" title={ticket.title}>
                    {ticket.title}
                  </span>
                </TableCell>

                <TableCell>
                  <JiraStatusBadge
                    category={ticket.statusCategory}
                    status={ticket.status}
                  />
                </TableCell>

                <TableCell>
                  {ticket.assignee ? (
                    <div className="flex items-center gap-2">
                      <Avatar>
                        <AvatarFallback>
                          {initialsOf(ticket.assignee)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="truncate text-muted-foreground text-xs">
                        {ticket.assignee}
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground/60 text-xs">
                      Unassigned
                    </span>
                  )}
                </TableCell>

                <TableCell>
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap gap-1">
                      {showNoDevelopment && (
                        <span
                          className="text-muted-foreground/60 text-xs"
                          title="Create a branch prefixed with this Jira key or ensure the PR is linked in Jira/GitHub."
                        >
                          No PR/branch
                        </span>
                      )}
                      {pullRequests.map((pr) => (
                        <span
                          className="inline-flex items-center gap-1"
                          key={pr.number || pr.url}
                        >
                          <button
                            className="inline-flex"
                            onClick={() =>
                              openExternalLink(
                                pr.number > 0
                                  ? githubPullRequestUrl(github, pr.number)
                                  : pr.url
                              )
                            }
                            type="button"
                          >
                            <PullRequestBadge pullRequest={pr} />
                          </button>
                          <SourceBadge source={pr.source} />
                        </span>
                      ))}
                      {showBranchOnly && (
                        <span
                          className="inline-flex items-center gap-1"
                          title={branches
                            .map((branch) => branch.name)
                            .join(", ")}
                        >
                          <Badge variant="outline">Branch found</Badge>
                          <SourceBadge source={branches[0].source} />
                        </span>
                      )}
                    </div>
                    {developmentStatus && (
                      <div className="flex flex-wrap gap-1">
                        <IntegrationStatusBadge
                          label="Dev data"
                          status={developmentStatus}
                        />
                      </div>
                    )}
                  </div>
                </TableCell>

                <TableCell>
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap gap-1">
                      {showNotDeployed && (
                        <span
                          className="text-muted-foreground/60 text-xs"
                          title="No ArgoCD dev system currently reports this Jira key in its branch."
                        >
                          not deployed
                        </span>
                      )}
                      {deployments.map((d) => (
                        <button
                          className="inline-flex"
                          key={d.environment}
                          onClick={() =>
                            openExternalLink(devSystemUrl(d.environment))
                          }
                          title={`Open dev-${d.environment}`}
                          type="button"
                        >
                          <Badge variant="outline">{d.environment}</Badge>
                        </button>
                      ))}
                    </div>
                    {devSystemStatus && (
                      <div className="flex flex-wrap gap-1">
                        <IntegrationStatusBadge
                          label="Argo"
                          status={devSystemStatus}
                        />
                      </div>
                    )}
                    {latestDeployment && (
                      <div className="flex flex-wrap gap-1">
                        <DeploymentRunBadge batch={latestDeployment} />
                      </div>
                    )}
                  </div>
                </TableCell>

                <TableCell className="w-[6.75rem]">
                  <div className="flex justify-end">
                    <Button
                      className="w-[4.25rem]"
                      onClick={() => setDeployRow(row)}
                      size="xs"
                      variant="default"
                    >
                      <Rocket />
                      Deploy
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {deployRow && (
        <DeploymentDialog
          deployments={deployments}
          onOpenChange={(open) => {
            if (!open) {
              setDeployRow(null);
            }
          }}
          open={true}
          row={deployRow}
        />
      )}
    </>
  );
}
