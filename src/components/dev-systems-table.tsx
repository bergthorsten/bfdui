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
import {
  devSystemUrl,
  type GithubRepoRef,
  githubBranchUrl,
} from "@/domain/urls";
import { formatAge } from "@/lib/status";
import type { DevDeployment, JiraTicket } from "@/types/bfd";
import { cn } from "@/utils/tailwind";

interface Props {
  deployments: DevDeployment[];
  github: GithubRepoRef;
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

export default function DevSystemsTable({
  deployments,
  github,
  ticketsByKey,
}: Props) {
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
        {deployments.length === 0 && (
          <TableRow>
            <TableCell
              className="py-8 text-center text-muted-foreground text-sm"
              colSpan={9}
            >
              No dev systems loaded. Check Argo settings or refresh.
            </TableCell>
          </TableRow>
        )}
        {deployments.map((d) => {
          const ticket = d.ticketKey
            ? ticketsByKey.get(d.ticketKey)
            : undefined;
          const branch = d.branch;
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
                    <span title="Reset coming soon">
                      <Button disabled size="xs" variant="outline">
                        <RotateCcw />
                        Reset
                      </Button>
                    </span>
                  )}
                  <Button
                    aria-label="Open dev system"
                    onClick={() =>
                      openExternalLink(devSystemUrl(d.environment))
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
