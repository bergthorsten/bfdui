import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AppConfig,
  DeploymentBatch,
  JiraDevelopmentInfo,
} from "@/types/bfd";

const mocks = vi.hoisted(() => {
  const config = {
    clearSecret: vi.fn(),
    get: vi.fn(),
    getSecret: vi.fn(),
    secretStatus: vi.fn(),
    setSecret: vi.fn(),
    update: vi.fn(),
  };
  const argo = { getDevDeployments: vi.fn(), testConnection: vi.fn() };
  const github = {
    completeDevelopmentInfo: vi.fn(),
    testConnection: vi.fn(),
  };
  const jira = {
    getDevelopmentInfo: vi.fn(),
    getActiveSprint: vi.fn(),
    search: vi.fn(),
    searchAccessibleTickets: vi.fn(),
    testConnection: vi.fn(),
  };
  const workflows = { discoverTargets: vi.fn(), recordUsage: vi.fn() };
  const deployments = {
    createDeployment: vi.fn(),
    deleteDeploymentBatch: vi.fn(),
    getDeploymentBatch: vi.fn(),
    listDeploymentBatches: vi.fn(),
    refreshDeploymentBatch: vi.fn(),
  };

  return { argo, config, deployments, github, jira, workflows };
});

vi.mock("@/services/config", () => ({
  ConfigService: vi.fn(function ConfigService() {
    return mocks.config;
  }),
}));

vi.mock("@/services/argo", () => ({
  ArgoService: vi.fn(function ArgoService() {
    return mocks.argo;
  }),
}));

vi.mock("@/services/github", () => ({
  GitHubService: vi.fn(function GitHubService() {
    return mocks.github;
  }),
}));

vi.mock("@/services/jira", () => ({
  JiraCloudService: vi.fn(function JiraCloudService() {
    return mocks.jira;
  }),
}));

vi.mock("@/services/workflows", () => ({
  WorkflowService: vi.fn(function WorkflowService() {
    return mocks.workflows;
  }),
}));

vi.mock("@/services/deployments", () => ({
  DeploymentService: vi.fn(function DeploymentService() {
    return mocks.deployments;
  }),
}));

vi.mock("@/services/cli", () => ({
  execCli: vi.fn(),
}));

import {
  getDeploymentBatches,
  getTicketDevelopment,
  saveConfig,
  testConnection,
} from "@/ipc/bfd/handlers";
import { JiraCloudService } from "@/services/jira";

const appConfig: AppConfig = {
  argo: { app: "shop", argocdNamespace: "argocd", devContext: "dev" },
  github: { owner: "bergfreunde", repo: "shop", useGhCli: true },
  jira: {
    baseUrl: "https://jira.example.com",
    email: "ada@example.com",
    project: "PC",
    sprintJql: "project = PC",
  },
  onboardingComplete: true,
  repoPath: "/tmp/shop",
};

function callProcedure<TInput, TOutput>(
  procedure: unknown,
  input: TInput
): Promise<TOutput> {
  const result = (
    procedure as {
      "~orpc": {
        handler: (options: { input: TInput }) => Promise<TOutput> | TOutput;
      };
    }
  )["~orpc"].handler({ input });
  return Promise.resolve(result);
}

describe("BFD IPC handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.get.mockReturnValue(appConfig);
    mocks.config.getSecret.mockReturnValue("stored-token");
    mocks.config.secretStatus.mockReturnValue({
      githubToken: true,
      jiraToken: true,
    });
    mocks.config.update.mockReturnValue(appConfig);
    mocks.jira.testConnection.mockResolvedValue({
      detail: "Ada Lovelace",
      message: "Connected to Jira.",
      ok: true,
    });
  });

  test("tests Jira connections against draft config and draft secrets", async () => {
    await expect(
      callProcedure<unknown, { ok: boolean }>(testConnection, {
        config: appConfig,
        kind: "jira",
        secrets: { jiraToken: "draft-jira-token" },
      })
    ).resolves.toMatchObject({ ok: true });

    const draftProvider = vi.mocked(JiraCloudService).mock.calls.at(-1)?.[0];
    expect(draftProvider?.get()).toEqual(appConfig);
    expect(draftProvider?.getSecret("jiraToken")).toBe("draft-jira-token");
    expect(draftProvider?.getSecret("githubToken")).toBe("stored-token");
  });

  test("saves config while applying secret updates and clears", async () => {
    await expect(
      callProcedure(saveConfig, {
        config: appConfig,
        secrets: {
          clearGithubToken: true,
          githubToken: "ignored-by-clear",
          jiraToken: "new-jira-token",
        },
      })
    ).resolves.toEqual({
      config: appConfig,
      secrets: { githubToken: true, jiraToken: true },
      warning: undefined,
    });

    expect(mocks.config.clearSecret).toHaveBeenCalledWith("githubToken");
    expect(mocks.config.setSecret).toHaveBeenCalledWith(
      "jiraToken",
      "new-jira-token"
    );
    expect(mocks.config.update).toHaveBeenCalledWith(appConfig);
  });

  test("combines Jira development info with GitHub enrichment", async () => {
    const jiraDevelopment: JiraDevelopmentInfo = {
      branches: [],
      buildCount: 0,
      builds: [],
      errors: [],
      pullRequests: [],
    };
    const enrichedDevelopment = {
      ...jiraDevelopment,
      branches: [
        {
          headSha: "abc123",
          name: "PC-123-checkout",
          source: "github" as const,
          url: "https://github.example/tree/PC-123-checkout",
        },
      ],
    };
    mocks.jira.getDevelopmentInfo.mockResolvedValue(jiraDevelopment);
    mocks.github.completeDevelopmentInfo.mockResolvedValue(enrichedDevelopment);

    await expect(
      callProcedure(getTicketDevelopment, {
        issueId: "123",
        ticketKey: "PC-123",
      })
    ).resolves.toEqual(enrichedDevelopment);

    expect(mocks.jira.getDevelopmentInfo).toHaveBeenCalledWith("123");
    expect(mocks.github.completeDevelopmentInfo).toHaveBeenCalledWith(
      "PC-123",
      jiraDevelopment
    );
  });

  test("throttles active deployment batch refreshes", async () => {
    const now = Date.parse("2026-06-22T10:00:00.000Z");
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    const recentActiveBatch = deploymentBatch({
      id: "recent-active",
      updatedAt: now - 30_000,
    });
    const staleActiveBatch = deploymentBatch({
      id: "stale-active",
      updatedAt: now - 90_000,
    });

    mocks.deployments.listDeploymentBatches.mockReturnValue([
      recentActiveBatch,
      staleActiveBatch,
    ]);
    mocks.deployments.refreshDeploymentBatch.mockResolvedValue(
      staleActiveBatch
    );

    await callProcedure(getDeploymentBatches, undefined);

    expect(mocks.deployments.refreshDeploymentBatch).toHaveBeenCalledTimes(1);
    expect(mocks.deployments.refreshDeploymentBatch).toHaveBeenCalledWith(
      "stale-active"
    );

    dateNow.mockRestore();
  });
});

function deploymentBatch(
  overrides: Partial<DeploymentBatch> = {}
): DeploymentBatch {
  return {
    aggregateState: "queued",
    branch: "PC-123-shop",
    createdAt: Date.parse("2026-06-22T09:59:00.000Z"),
    environment: "04",
    id: "batch-1",
    ticketKey: "PC-123",
    updatedAt: Date.parse("2026-06-22T09:59:00.000Z"),
    workflows: [],
    ...overrides,
  };
}
