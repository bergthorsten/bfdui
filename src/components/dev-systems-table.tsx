import { ExternalLink, GitBranch, RotateCcw } from "lucide-react";
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
import { formatAge } from "@/lib/status";
import type { DevDeployment, JiraTicket } from "@/types/bfd";
import { cn } from "@/utils/tailwind";

const GH_BASE = "https://github.com/bergfreunde/shop";

interface Props {
  deployments: DevDeployment[];
  ticketsByKey: Map<string, JiraTicket>;
}

interface DeploymentJiraStatusProps {
  deployment: DevDeployment;
  ticket?: JiraTicket;
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

export default function DevSystemsTable({ deployments, ticketsByKey }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>System</TableHead>
          <TableHead>Branch</TableHead>
          <TableHead>Ticket</TableHead>
          <TableHead>Jira status</TableHead>
          <TableHead>Sync</TableHead>
          <TableHead>Health</TableHead>
          <TableHead className="text-right">Age</TableHead>
          <TableHead>Auto sync</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {deployments.map((d) => {
          const ticket = d.ticketKey
            ? ticketsByKey.get(d.ticketKey)
            : undefined;
          return (
            <TableRow
              className={cn(d.reserved && "bg-amber-500/[0.04]")}
              key={d.environment}
            >
              <TableCell>
                <span className="font-medium font-mono text-sm">
                  {d.environment}
                </span>
              </TableCell>

              <TableCell className="w-[300px] max-w-[300px]">
                {d.branch ? (
                  <button
                    className="flex w-full min-w-0 items-center gap-1.5 text-left font-mono text-muted-foreground text-xs hover:text-foreground hover:underline"
                    onClick={() =>
                      openExternalLink(`${GH_BASE}/tree/${d.branch}`)
                    }
                    title={d.branch}
                    type="button"
                  >
                    <GitBranch className="size-3 shrink-0" />
                    <span className="truncate">{d.branch}</span>
                  </button>
                ) : (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </TableCell>

              <TableCell className="whitespace-nowrap">
                {d.ticketKey ? (
                  <button
                    className="font-medium font-mono text-xs hover:underline"
                    onClick={() => ticket && openExternalLink(ticket.url)}
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
                    <Button size="xs" variant="outline">
                      <RotateCcw />
                      Reset
                    </Button>
                  )}
                  <Button
                    aria-label="Open dev system"
                    onClick={() =>
                      openExternalLink(
                        `https://dev-${d.environment}.bergfreunde.de/`
                      )
                    }
                    size="icon-xs"
                    variant="ghost"
                  >
                    <ExternalLink />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
