import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DeploymentService } from "@/services/deployments";
import type { WorkflowTarget } from "@/types/bfd";

const APP_WORKFLOW_PREFIX_PATTERN = /^app-/;

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => tmpdir()),
  },
  Notification: class Notification {
    static isSupported() {
      return false;
    }

    show() {
      return;
    }
  },
}));

const BASE_TIME = Date.parse("2026-06-18T10:00:00.000Z");

function target(
  name: string,
  inputs: WorkflowTarget["inputs"] = []
): WorkflowTarget {
  return {
    affectedPathGlobs: [],
    aliases: [name.replace(APP_WORKFLOW_PREFIX_PATTERN, "")],
    fileName: `${name}.yml`,
    group: name.split("-")[0] ?? "app",
    inputs,
    name,
    path: `.github/workflows/${name}.yml`,
    usage: null,
  };
}

function serviceFor(options: {
  github?: Partial<ConstructorParameters<typeof DeploymentService>[0]>;
  historyPath?: string;
  now?: () => number;
  targets?: WorkflowTarget[];
}) {
  const github = {
    dispatchWorkflow: vi.fn().mockResolvedValue(undefined),
    getBranchHeadSha: vi.fn().mockResolvedValue("branch-sha"),
    listWorkflowRunJobs: vi.fn().mockResolvedValue([]),
    listWorkflowRuns: vi.fn().mockResolvedValue([]),
    ...options.github,
  };
  const workflows = {
    discoverTargets: vi.fn(() => ({
      repoPath: "/tmp/shop",
      targets: options.targets ?? [target("app-shop")],
      warnings: [],
      workflowsPath: "/tmp/shop/.github/workflows",
    })),
    recordUsage: vi.fn(),
  };
  const notifier = { notify: vi.fn() };
  const historyPath =
    options.historyPath ??
    path.join(
      tmpdir(),
      `bfd-deployments-${Math.random().toString(36).slice(2)}.json`
    );
  const service = new DeploymentService(github, workflows, {
    historyPath,
    idFactory: () => "batch-1",
    notifier,
    now: options.now ?? (() => BASE_TIME),
    runTimeoutMs: 60_000,
  });

  return { github, historyPath, notifier, service, workflows };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("DeploymentService", () => {
  test("validates deployment intent before dispatch", async () => {
    const { github, service } = serviceFor({});

    await expect(
      service.createDeployment({
        branch: "",
        environment: "04",
        workflows: [{ inputs: {}, name: "app-shop" }],
      })
    ).rejects.toThrow("A branch/ref is required");
    await expect(
      service.createDeployment({
        branch: "PC-123-shop",
        environment: "04",
        workflows: [],
      })
    ).rejects.toThrow("Select at least one workflow target");
    expect(github.dispatchWorkflow).not.toHaveBeenCalled();
  });

  test("dispatches one run per selected workflow and records usage", async () => {
    const targets = [
      target("app-shop", [
        {
          name: "ENVIRONMENT",
          options: ["01", "04"],
          required: true,
          type: "choice",
        },
        {
          default: "false",
          name: "PERFORM_TESTS",
          options: [],
          required: false,
          type: "boolean",
        },
      ]),
      target("helper-unattended-build-and-deploy", [
        {
          name: "RUN_ENVIRONMENTS",
          options: [],
          required: true,
          type: "string",
        },
      ]),
    ];
    const { github, service, workflows } = serviceFor({ targets });

    const batch = await service.createDeployment({
      branch: "PC-123-shop",
      environment: "04",
      ticketKey: "PC-123",
      workflows: [
        {
          inputs: { PERFORM_TESTS: "true" },
          name: "shop",
          path: ".github/workflows/app-shop.yml",
        },
        {
          inputs: {},
          name: "helper-unattended-build-and-deploy",
        },
      ],
    });

    expect(batch).toMatchObject({
      aggregateState: "queued",
      branch: "PC-123-shop",
      environment: "04",
      sourceCommitSha: "branch-sha",
    });
    expect(github.dispatchWorkflow).toHaveBeenCalledWith({
      inputs: { ENVIRONMENT: "04", PERFORM_TESTS: "true" },
      ref: "PC-123-shop",
      workflowFileName: "app-shop.yml",
    });
    expect(github.dispatchWorkflow).toHaveBeenCalledWith({
      inputs: { RUN_ENVIRONMENTS: "04" },
      ref: "PC-123-shop",
      workflowFileName: "helper-unattended-build-and-deploy.yml",
    });
    expect(workflows.recordUsage).toHaveBeenCalledTimes(2);
  });

  test("matches workflow_dispatch runs and refreshes terminal state", async () => {
    const runStarted = {
      conclusion: null,
      createdAt: "2026-06-18T10:00:02.000Z",
      currentAttempt: 1,
      event: "workflow_dispatch",
      headBranch: "PC-123-shop",
      id: 987,
      status: "in_progress",
      updatedAt: "2026-06-18T10:00:10.000Z",
      url: "https://github.com/bergfreunde/shop/actions/runs/987",
    };
    const runSucceeded = {
      ...runStarted,
      conclusion: "success",
      status: "completed",
      updatedAt: "2026-06-18T10:02:00.000Z",
    };
    const github = {
      listWorkflowRuns: vi
        .fn()
        .mockResolvedValueOnce([runStarted])
        .mockResolvedValueOnce([runSucceeded]),
    };
    const { notifier, service } = serviceFor({ github });

    const started = await service.createDeployment({
      branch: "PC-123-shop",
      environment: "04",
      ticketKey: "PC-123",
      workflows: [{ inputs: {}, name: "app-shop" }],
    });

    expect(started.aggregateState).toBe("in-progress");
    expect(started.workflows[0]).toMatchObject({
      runId: 987,
      runUrl: "https://github.com/bergfreunde/shop/actions/runs/987",
      state: "in-progress",
    });

    const succeeded = await service.refreshDeploymentBatch(started.id);

    expect(succeeded.aggregateState).toBe("success");
    expect(notifier.notify).toHaveBeenCalledWith(
      "Deployment succeeded",
      "1 workflow finished for PC-123."
    );
  });

  test("finishes app-shop deployments when adminserver and k8s jobs succeed", async () => {
    const runStarted = {
      conclusion: null,
      createdAt: "2026-06-18T10:00:02.000Z",
      currentAttempt: 1,
      event: "workflow_dispatch",
      headBranch: "PC-123-shop",
      id: 987,
      status: "in_progress",
      updatedAt: "2026-06-18T10:03:00.000Z",
      url: "https://github.com/bergfreunde/shop/actions/runs/987",
    };
    const github = {
      listWorkflowRunJobs: vi.fn().mockResolvedValue([
        {
          completedAt: "2026-06-18T10:01:00.000Z",
          conclusion: "success",
          id: 1,
          name: "Deploy 04 to adminserver",
          startedAt: "2026-06-18T10:00:30.000Z",
          status: "completed",
          url: "https://github.example/jobs/1",
        },
        {
          completedAt: "2026-06-18T10:02:00.000Z",
          conclusion: "success",
          id: 2,
          name: "Deploy 04 to k8s",
          startedAt: "2026-06-18T10:01:30.000Z",
          status: "completed",
          url: "https://github.example/jobs/2",
        },
      ]),
      listWorkflowRuns: vi.fn().mockResolvedValue([runStarted]),
    };
    const { service } = serviceFor({ github });

    const batch = await service.createDeployment({
      branch: "PC-123-shop",
      environment: "04",
      ticketKey: "PC-123",
      workflows: [{ inputs: {}, name: "app-shop" }],
    });

    expect(batch.aggregateState).toBe("success");
    expect(batch.workflows[0]).toMatchObject({
      runId: 987,
      state: "success",
    });
    expect(github.listWorkflowRunJobs).toHaveBeenCalledWith(987);
  });

  test("times out runs that never appear", async () => {
    let now = BASE_TIME;
    const { service } = serviceFor({ now: () => now });
    const batch = await service.createDeployment({
      branch: "PC-123-shop",
      environment: "04",
      workflows: [{ inputs: {}, name: "app-shop" }],
    });

    now = BASE_TIME + 61_000;

    await expect(
      service.refreshDeploymentBatch(batch.id)
    ).resolves.toMatchObject({
      aggregateState: "timed-out",
    });
  });

  test("prunes terminal deployment history after 24 hours", () => {
    const historyPath = path.join(
      tmpdir(),
      `bfd-deployments-${Math.random().toString(36).slice(2)}.json`
    );
    const staleTerminalBatch = {
      aggregateState: "success",
      branch: "PC-123-shop",
      createdAt: BASE_TIME - 48 * 60 * 60_000,
      environment: "04",
      id: "stale-terminal",
      updatedAt: BASE_TIME - 25 * 60 * 60_000,
      workflows: [
        {
          dispatchRequestedAt: BASE_TIME - 48 * 60 * 60_000,
          environment: "04",
          fileName: "app-shop.yml",
          inputs: {},
          state: "success",
          targetName: "app-shop",
          workflowPath: ".github/workflows/app-shop.yml",
        },
      ],
    };
    const oldActiveBatch = {
      ...staleTerminalBatch,
      aggregateState: "in-progress",
      id: "old-active",
      workflows: [{ ...staleTerminalBatch.workflows[0], state: "in-progress" }],
    };
    const freshTerminalBatch = {
      ...staleTerminalBatch,
      id: "fresh-terminal",
      updatedAt: BASE_TIME - 23 * 60 * 60_000,
    };
    writeFileSync(
      historyPath,
      JSON.stringify([staleTerminalBatch, oldActiveBatch, freshTerminalBatch]),
      "utf8"
    );
    const { service } = serviceFor({ historyPath, now: () => BASE_TIME });

    expect(service.listDeploymentBatches().map((batch) => batch.id)).toEqual([
      "old-active",
      "fresh-terminal",
    ]);
    expect(
      JSON.parse(readFileSync(historyPath, "utf8")).map(
        (batch: { id: string }) => batch.id
      )
    ).toEqual(["old-active", "fresh-terminal"]);
  });
});
