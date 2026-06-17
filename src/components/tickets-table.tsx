import { ArrowDown, ArrowUp, ArrowUpDown, Rocket } from "lucide-react";
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
import { initialsOf } from "@/lib/status";
import type { DevDeployment, TicketDeploymentRow } from "@/types/bfd";

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
    { key: "prs", label: "PRs", className: "w-[8.5rem]" },
    { key: "deployed", label: "Deployed to", className: "w-[11rem]" },
  ];

const NUMERIC_ENVIRONMENT_PATTERN = /^\d+$/;

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

function devSystemUrl(environment: string) {
  if (NUMERIC_ENVIRONMENT_PATTERN.test(environment)) {
    return `https://dev-${environment}.bergfreunde.de/`;
  }
  return `https://${environment}.bergfreunde.de/`;
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

export default function TicketsTable({
  deployments,
  rows,
}: {
  deployments: DevDeployment[];
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
          {sortedRows.map((row) => {
            const { ticket, pullRequests, deployments } = row;
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
                  <div className="flex flex-wrap gap-1">
                    {pullRequests.length === 0 && (
                      <span className="text-muted-foreground/60 text-xs">
                        —
                      </span>
                    )}
                    {pullRequests.map((pr) => (
                      <button
                        className="inline-flex"
                        key={pr.number}
                        onClick={() => openExternalLink(pr.url)}
                        type="button"
                      >
                        <PullRequestBadge pullRequest={pr} />
                      </button>
                    ))}
                  </div>
                </TableCell>

                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {deployments.length === 0 && (
                      <span className="text-muted-foreground/60 text-xs">
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
