import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  GitBranch,
  RotateCcw,
} from "lucide-react";
import { useMemo, useState } from "react";
import { openExternalLink } from "@/actions/shell";
import {
  AutoSyncBadge,
  FreeBadge,
  HealthBadge,
  JiraStatusBadge,
  ReservedBadge,
  SyncBadge,
} from "@/components/status-badges";
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
  githubBranchUrl,
} from "@/domain/urls";
import { formatAge } from "@/lib/status";
import type { DevDeployment, JiraTicket } from "@/types/bfd";
import { cn } from "@/utils/tailwind";

const TRAILING_SLASHES_PATTERN = /\/+$/;

type SortDirection = "asc" | "desc";
type SortKey = "age" | "branch" | "system" | "ticket";

interface SortState {
  direction: SortDirection;
  key: SortKey;
}

const SORTABLE_HEADERS: { className?: string; key: SortKey; label: string }[] =
  [
    { key: "system", label: "System" },
    { key: "branch", label: "Branch", className: "w-[300px] max-w-[300px]" },
    { key: "ticket", label: "Ticket" },
  ];

interface Props {
  deployments: DevDeployment[];
  github: GithubRepoRef;
  jiraBaseUrl?: string;
  ticketsByKey?: Map<string, JiraTicket>;
}

interface DeploymentJiraStatusProps {
  deployment: DevDeployment;
  ticket?: JiraTicket;
}

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

function compareTicket(
  a: string | null | undefined,
  b: string | null | undefined
) {
  if (!(a && b)) {
    return compareText(a, b);
  }
  const [aProject, aNumber] = ticketSortValue(a);
  const [bProject, bNumber] = ticketSortValue(b);
  const project = compareText(aProject, bProject);
  return project || aNumber - bNumber;
}

function compareAge(a: number | null, b: number | null) {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a - b;
}

function compareDeployments(a: DevDeployment, b: DevDeployment, key: SortKey) {
  switch (key) {
    case "system":
      return compareText(a.environment, b.environment);
    case "branch":
      return compareText(a.branch, b.branch);
    case "ticket":
      return compareTicket(a.ticketKey, b.ticketKey);
    case "age":
      return compareAge(a.ageSeconds, b.ageSeconds);
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

function DeploymentJiraStatus({
  deployment,
  ticket,
}: DeploymentJiraStatusProps) {
  if (deployment.reserved) {
    return <ReservedBadge />;
  }

  if (ticket) {
    return (
      <JiraStatusBadge
        category={ticket.statusCategory}
        status={ticket.status}
      />
    );
  }

  if (deployment.isFree) {
    return <FreeBadge />;
  }

  return <span className="text-muted-foreground/60">—</span>;
}

export default function DevSystemsTable({
  deployments,
  github,
  jiraBaseUrl,
  ticketsByKey,
}: Props) {
  const [sort, setSort] = useState<SortState>({
    key: "system",
    direction: "asc",
  });
  const sortedDeployments = useMemo(
    () =>
      deployments.toSorted((a, b) => {
        const result = compareDeployments(a, b, sort.key);
        return sort.direction === "asc" ? result : -result;
      }),
    [deployments, sort]
  );

  function updateSort(key: SortKey) {
    setSort((current) => ({
      key,
      direction:
        current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  return (
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
          <TableHead>Jira status</TableHead>
          <TableHead>Sync</TableHead>
          <TableHead>Health</TableHead>
          <SortHeader
            className="text-right"
            label="Age"
            onSort={updateSort}
            sort={sort}
            sortKey="age"
          />
          <TableHead>Auto sync</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedDeployments.length === 0 && (
          <TableRow>
            <TableCell
              className="py-8 text-center text-muted-foreground text-sm"
              colSpan={9}
            >
              No dev systems loaded. Check Argo settings or refresh.
            </TableCell>
          </TableRow>
        )}
        {sortedDeployments.map((d) => {
          const ticket = d.ticketKey
            ? ticketsByKey?.get(d.ticketKey)
            : undefined;
          const ticketUrl =
            ticket?.url ?? jiraTicketUrl(jiraBaseUrl, d.ticketKey);
          const branch = d.branch;
          return (
            <TableRow
              className={cn(d.reserved && "bg-amber-500/[0.04]")}
              key={d.environment}
            >
              <TableCell>
                <button
                  className="font-medium font-mono text-sm hover:underline"
                  onClick={() => openExternalLink(devSystemUrl(d.environment))}
                  type="button"
                >
                  {d.environment}
                </button>
              </TableCell>

              <TableCell className="w-[300px] max-w-[300px]">
                {branch ? (
                  <button
                    className="flex w-full min-w-0 items-center gap-1.5 text-left font-mono text-muted-foreground text-xs hover:text-foreground hover:underline"
                    onClick={() =>
                      openExternalLink(githubBranchUrl(github, branch))
                    }
                    title={branch}
                    type="button"
                  >
                    <GitBranch className="size-3 shrink-0" />
                    <span className="truncate">{branch}</span>
                  </button>
                ) : (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </TableCell>

              <TableCell className="whitespace-nowrap">
                {d.ticketKey ? (
                  <button
                    className="font-medium font-mono text-xs hover:underline"
                    onClick={() => ticketUrl && openExternalLink(ticketUrl)}
                    type="button"
                  >
                    {d.ticketKey}
                  </button>
                ) : (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </TableCell>

              <TableCell>
                <DeploymentJiraStatus deployment={d} ticket={ticket} />
              </TableCell>

              <TableCell>
                <SyncBadge sync={d.sync} />
              </TableCell>
              <TableCell>
                <HealthBadge health={d.health} />
              </TableCell>
              <TableCell className="text-right font-mono text-muted-foreground text-xs tabular-nums">
                {formatAge(d.ageSeconds)}
              </TableCell>
              <TableCell>
                <AutoSyncBadge autoSync={d.autoSync} />
              </TableCell>

              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  {!(d.isFree || d.reserved) && (
                    <span title="Reset coming soon">
                      <Button disabled size="xs" variant="outline">
                        <RotateCcw />
                        Reset
                      </Button>
                    </span>
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function jiraTicketUrl(baseUrl: string | undefined, ticketKey: string | null) {
  if (!(baseUrl && ticketKey)) {
    return;
  }
  return `${baseUrl.replace(TRAILING_SLASHES_PATTERN, "")}/browse/${ticketKey}`;
}
