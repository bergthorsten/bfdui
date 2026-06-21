import { describe, expect, test, vi } from "vitest";
import { DeploymentStatusService } from "@/services/deployment-status";
import type { DevDeployment } from "@/types/bfd";

const DEPLOYMENT = {
  ageSeconds: 60,
  app: "shop",
  autoSync: "on",
  branch: "PC-255-fix-search-a11y",
  deployedAt: "2026-06-17T11:59:00Z",
  deployedRevision: "abc123",
  environment: "04",
  health: "Healthy",
  isFree: false,
  reserved: false,
  sync: "Synced",
  ticketKey: "PC-255",
} satisfies DevDeployment;

describe("DeploymentStatusService", () => {
  test("returns ticket deployment freshness", async () => {
    const service = new DeploymentStatusService(
      { getDevDeployments: vi.fn().mockResolvedValue([DEPLOYMENT]) },
      {
        getBranchFreshness: vi.fn().mockResolvedValue({
          aheadBy: 0,
          latestCommitSha: null,
          method: "compare",
          status: "identical",
          url: "https://github.com/bergfreunde/shop/compare/abc...branch",
        }),
      }
    );

    const status = await service.getTicketStatus("pc-255");

    expect(status).toMatchObject({
      isDeployed: true,
      ticketKey: "PC-255",
    });
    expect(status.deployments[0]).toMatchObject({
      environment: "04",
      isUpToDate: true,
      newCommitsSinceDeploy: 0,
      upToDateCheck: "compare",
    });
  });

  test("returns not deployed when Argo has no matching ticket", async () => {
    const service = new DeploymentStatusService(
      { getDevDeployments: vi.fn().mockResolvedValue([DEPLOYMENT]) },
      { getBranchFreshness: vi.fn() }
    );

    await expect(service.getTicketStatus("PC-999")).resolves.toMatchObject({
      deployments: [],
      isDeployed: false,
      ticketKey: "PC-999",
    });
  });
});
