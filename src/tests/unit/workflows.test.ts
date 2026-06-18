import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WorkflowService } from "@/services/workflows";
import type { AppConfig } from "@/types/bfd";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => tmpdir()),
  },
}));

const BASE_CONFIG: AppConfig = {
  argo: {
    app: "shop",
    devContext: "dev",
  },
  github: {
    owner: "bergfreunde",
    repo: "shop",
    useGhCli: true,
  },
  jira: {
    baseUrl: "https://jirabergfreunde.atlassian.net",
    email: "ada@example.com",
    project: "PC",
    sprintJql: "project = PC",
  },
  onboardingComplete: true,
  repoPath: "/tmp/shop",
};

function configProvider(repoPath: string, repo = "shop") {
  return {
    get: () => ({
      ...BASE_CONFIG,
      github: { ...BASE_CONFIG.github, repo },
      repoPath,
    }),
  };
}

function workflowDir(repoPath: string): string {
  return path.join(repoPath, ".github", "workflows");
}

function writeWorkflow(
  repoPath: string,
  fileName: string,
  content = "name: Deploy\non:\n  workflow_dispatch:\n"
): void {
  const dir = workflowDir(repoPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, fileName), content, "utf8");
}

describe("WorkflowService", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "bfd-workflows-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tempDir, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  test("discovers dispatchable top-level yml/yaml workflows and BFD aliases", () => {
    writeWorkflow(tempDir, "app-shop.yml");
    writeWorkflow(tempDir, "im-api-im.yaml");
    writeWorkflow(tempDir, "tool-karabiner.yml");
    writeWorkflow(tempDir, "app-services-php.yml");
    writeWorkflow(tempDir, "CHECK_quality.yml");
    writeWorkflow(tempDir, "LEGACY_old.yml");
    writeWorkflow(tempDir, "RW_reusable.yml");
    writeWorkflow(tempDir, "push-only.yml", "name: Push\non:\n  push:\n");
    mkdirSync(path.join(workflowDir(tempDir), "nested"));
    writeWorkflow(path.join(workflowDir(tempDir), "nested"), "app-nested.yml");

    const service = new WorkflowService(
      configProvider(tempDir),
      path.join(tempDir, "usage.json")
    );
    const result = service.discoverTargets();

    expect(result.targets.map((target) => target.name)).toEqual([
      "app-services-php",
      "app-shop",
      "im-api-im",
      "tool-karabiner",
    ]);
    expect(result.targets.map((target) => target.fileName)).not.toContain(
      "CHECK_quality.yml"
    );
    expect(result.targets.map((target) => target.fileName)).not.toContain(
      "push-only.yml"
    );

    expect(service.resolveTargetAlias("shop")?.name).toBe("app-shop");
    expect(service.resolveTargetAlias("api-im")?.name).toBe("im-api-im");
    expect(service.resolveTargetAlias("karabiner")?.name).toBe(
      "tool-karabiner"
    );
    expect(service.resolveTargetAlias("services-php")?.name).toBe(
      "app-services-php"
    );
    expect(service.resolveTargetAlias("app-shop.yml")?.path).toBe(
      ".github/workflows/app-shop.yml"
    );
  });

  test("discovers workflows inside a repo-named checkout under devenv", () => {
    const devenvPath = path.join(tempDir, "devenv");
    const checkoutPath = path.join(devenvPath, "shop");
    writeWorkflow(checkoutPath, "app-shop.yml");

    const result = new WorkflowService(
      configProvider(devenvPath, "shop"),
      path.join(tempDir, "usage.json")
    ).discoverTargets();

    expect(result.workflowsPath).toBe(workflowDir(checkoutPath));
    expect(result.targets).toHaveLength(1);
  });

  test("parses workflow_dispatch inputs and defaults", () => {
    writeWorkflow(
      tempDir,
      "app-shop.yml",
      `name: Deploy shop
on:
  workflow_dispatch:
    inputs:
      ENVIRONMENT:
        description: Target system
        required: true
        type: choice
        options:
          - "01"
          - "04"
      PERFORM_TESTS:
        description: Run tests
        default: "false"
        required: false
        type: boolean
      FORCE_IMAGE_REBUILD:
        default: "true"
        type: boolean
`
    );

    const [target] = new WorkflowService(
      configProvider(tempDir),
      path.join(tempDir, "usage.json")
    ).discoverTargets().targets;

    expect(target?.inputs).toEqual([
      {
        description: "Target system",
        name: "ENVIRONMENT",
        options: ["01", "04"],
        required: true,
        type: "choice",
      },
      {
        default: "false",
        description: "Run tests",
        name: "PERFORM_TESTS",
        options: [],
        required: false,
        type: "boolean",
      },
      {
        default: "true",
        name: "FORCE_IMAGE_REBUILD",
        options: [],
        required: false,
        type: "boolean",
      },
    ]);
  });

  test("persists usage and ranks frequently used targets first", () => {
    const usagePath = path.join(tempDir, "usage.json");
    writeWorkflow(tempDir, "app-shop.yml");
    writeWorkflow(tempDir, "tool-karabiner.yml");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T10:00:00.000Z"));

    const service = new WorkflowService(configProvider(tempDir), usagePath);
    service.recordUsage({
      branch: "PC-123-karabiner",
      environment: "04",
      name: "tool-karabiner.yml",
      ticketKey: "PC-123",
    });
    vi.setSystemTime(new Date("2026-06-18T10:05:00.000Z"));
    service.recordUsage({
      branch: "PC-123-karabiner",
      environment: "04",
      name: "tool-karabiner",
      ticketKey: "PC-123",
    });
    service.recordUsage({ name: "app-shop" });

    const rediscovered = new WorkflowService(
      configProvider(tempDir),
      usagePath
    ).discoverTargets();

    expect(rediscovered.targets[0]).toMatchObject({
      name: "tool-karabiner",
      usage: {
        lastBranch: "PC-123-karabiner",
        lastEnvironment: "04",
        lastTicketKey: "PC-123",
        usageCount: 2,
      },
    });
  });
});
