import type { ArgoService } from "@/services/argo";
import type { GitHubBranchFreshness, GitHubService } from "@/services/github";
import type { DevDeployment } from "@/types/bfd";

export interface TicketDeploymentStatus {
  checkedAt: string;
  deployments: DeploymentStatusDetails[];
  isDeployed: boolean;
  ticketKey: string;
}

export interface DeploymentStatusDetails {
  app: string;
  branch: string | null;
  deployedAt: string | null;
  deployedRevision: string | null;
  environment: string;
  health: string;
  isUpToDate: boolean | null;
  newCommitsSinceDeploy: number | null;
  status: string;
  sync: string;
  ticketKey: string | null;
  upToDateCheck: "compare" | "since-date" | "unavailable";
  upToDateUrl: string | null;
}

export class DeploymentStatusService {
  private readonly argo: Pick<ArgoService, "getDevDeployments">;
  private readonly github: Pick<GitHubService, "getBranchFreshness">;

  constructor(
    argo: Pick<ArgoService, "getDevDeployments">,
    github: Pick<GitHubService, "getBranchFreshness">
  ) {
    this.argo = argo;
    this.github = github;
  }

  async getTicketStatus(ticketKey: string): Promise<TicketDeploymentStatus> {
    const normalizedTicket = ticketKey.trim().toUpperCase();
    const deployments = await this.argo.getDevDeployments();
    const matchingDeployments = deployments.filter(
      (deployment) => deployment.ticketKey === normalizedTicket
    );

    return {
      checkedAt: new Date().toISOString(),
      deployments: await Promise.all(
        matchingDeployments.map((deployment) => this.withFreshness(deployment))
      ),
      isDeployed: matchingDeployments.length > 0,
      ticketKey: normalizedTicket,
    };
  }

  async listDeploymentStatuses(): Promise<DeploymentStatusDetails[]> {
    const deployments = await this.argo.getDevDeployments();
    return Promise.all(
      deployments.map((deployment) => this.withFreshness(deployment))
    );
  }

  private async withFreshness(
    deployment: DevDeployment
  ): Promise<DeploymentStatusDetails> {
    const freshness = deployment.branch
      ? await this.github
          .getBranchFreshness({
            branch: deployment.branch,
            deployedAt: deployment.deployedAt,
            deployedRevision: deployment.deployedRevision,
          })
          .catch(() => null)
      : null;

    return deploymentDetails(deployment, freshness);
  }
}

function deploymentDetails(
  deployment: DevDeployment,
  freshness: GitHubBranchFreshness | null
): DeploymentStatusDetails {
  const newCommitsSinceDeploy = freshness?.aheadBy ?? null;

  return {
    app: deployment.app,
    branch: deployment.branch,
    deployedAt: deployment.deployedAt,
    deployedRevision: deployment.deployedRevision ?? null,
    environment: deployment.environment,
    health: deployment.health,
    isUpToDate:
      newCommitsSinceDeploy === null ? null : newCommitsSinceDeploy === 0,
    newCommitsSinceDeploy,
    status: deployment.health,
    sync: deployment.sync,
    ticketKey: deployment.ticketKey,
    upToDateCheck: freshness?.method ?? "unavailable",
    upToDateUrl: freshness?.url ?? null,
  };
}
