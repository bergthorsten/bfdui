import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  ArgoService,
  parseArgoApplications,
  ticketKeyFromBranch,
} from "@/services/argo";
import { execCli } from "@/services/cli";
import type { ConfigService } from "@/services/config";

vi.mock("@/services/cli", () => ({
  execCli: vi.fn(),
}));

const APP_CONFIG = {
  argo: { app: "shop", argocdNamespace: "argocd", devContext: "dev-cluster" },
  github: { owner: "bergfreunde", repo: "shop", useGhCli: true },
  jira: {
    baseUrl: "https://jira.example.com/",
    email: "user@example.com",
    project: "PC",
    sprintJql: "project = PC",
  },
  onboardingComplete: true,
  repoPath: "/tmp/shop",
};

function configService(config = APP_CONFIG): Pick<ConfigService, "get"> {
  return {
    get: () => config,
  } as Pick<ConfigService, "get">;
}

const execCliMock = vi.mocked(execCli);

describe("ArgoService", () => {
  beforeEach(() => {
    execCliMock.mockReset();
  });

  test("constructs kubectl Application list arguments with kube context", async () => {
    execCliMock.mockResolvedValueOnce({ stdout: '{"items":[]}', stderr: "" });

    await new ArgoService(configService()).getDevDeployments();

    expect(execCliMock).toHaveBeenCalledWith(
      "kubectl",
      [
        "--context",
        "dev-cluster",
        "-n",
        "argocd",
        "get",
        "applications.argoproj.io",
        "-l",
        "app=shop",
        "-o",
        "json",
      ],
      { timeout: 20_000 }
    );
  });

  test("omits kube context when it is not configured", async () => {
    execCliMock.mockResolvedValueOnce({ stdout: '{"items":[]}', stderr: "" });

    await new ArgoService(
      configService({
        ...APP_CONFIG,
        argo: { app: "shop", argocdNamespace: "argocd", devContext: "" },
      })
    ).getDevDeployments();

    expect(execCliMock.mock.calls[0][1]).toEqual([
      "-n",
      "argocd",
      "get",
      "applications.argoproj.io",
      "-l",
      "app=shop",
      "-o",
      "json",
    ]);
  });

  test("rejects invalid and non-list kubectl JSON responses", async () => {
    const service = new ArgoService(configService());

    execCliMock.mockResolvedValueOnce({ stdout: "not-json", stderr: "" });
    await expect(service.getDevDeployments()).rejects.toThrow(
      "Kubernetes returned invalid JSON for ArgoCD Applications."
    );

    execCliMock.mockResolvedValueOnce({ stdout: "[]", stderr: "" });
    await expect(service.getDevDeployments()).rejects.toThrow(
      "Kubernetes returned an unexpected ArgoCD Application list shape."
    );
  });

  test("returns clean RBAC errors with developer diagnostics", async () => {
    execCliMock.mockRejectedValueOnce({
      stderr:
        'Error from server (Forbidden): applications.argoproj.io is forbidden: User "ada@example.com" cannot list resource "applications" in API group "argoproj.io" in the namespace "argocd"',
    });

    await expect(
      new ArgoService(configService()).testConnection()
    ).resolves.toMatchObject({
      detail: expect.stringContaining(
        "RBAC check: kubectl --context dev-cluster auth can-i list applications.argoproj.io -n argocd"
      ),
      message:
        'Kubernetes access is missing: this user cannot list ArgoCD Applications in namespace "argocd".',
      ok: false,
    });
  });
});

describe("parseArgoApplications", () => {
  test("maps Argo applications to dev deployments", () => {
    const deployments = parseArgoApplications(
      [
        {
          metadata: {
            labels: { app: "shop", branch: "PC-255-fix-search-a11y" },
            name: "shop-dev-04",
          },
          spec: {
            destination: { namespace: "04" },
            syncPolicy: { automated: { prune: true } },
          },
          status: {
            health: { status: "Healthy" },
            history: [{ deployedAt: "2026-06-17T11:59:00Z" }],
            sync: { revision: "abc123", status: "Synced" },
          },
        },
      ],
      "shop",
      new Date("2026-06-17T12:00:00Z")
    );

    expect(deployments).toEqual([
      {
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
      },
    ]);
  });

  test("marks default branches free except reserved systems", () => {
    const deployments = parseArgoApplications(
      [
        {
          metadata: { labels: { branch: "master" } },
          spec: { destination: { namespace: "02" }, syncPolicy: {} },
          status: {},
        },
        {
          metadata: { labels: { branch: "master" } },
          spec: { destination: { namespace: "20" } },
          status: {},
        },
      ],
      "shop",
      new Date("2026-06-17T12:00:00Z")
    );

    expect(deployments[0]).toMatchObject({
      autoSync: "off",
      environment: "02",
      isFree: true,
      reserved: false,
      ticketKey: null,
    });
    expect(deployments[1]).toMatchObject({
      environment: "20",
      isFree: false,
      reserved: true,
    });
  });

  test("uses source targetRevision as a branch fallback", () => {
    const deployments = parseArgoApplications(
      [
        {
          spec: {
            destination: { namespace: "05" },
            source: { targetRevision: "EXP-118-checkout-test" },
            syncPolicy: { automated: {} },
          },
          status: {
            history: [{ deployedAt: "'2026-06-17T11:00:00Z'" }],
          },
        },
      ],
      "shop",
      new Date("2026-06-17T12:00:00Z")
    );

    expect(deployments[0]).toMatchObject({
      ageSeconds: 3600,
      autoSync: "No prune",
      branch: "EXP-118-checkout-test",
      deployedAt: "2026-06-17T11:00:00Z",
      ticketKey: "EXP-118",
    });
  });

  test("skips applications without a destination namespace", () => {
    expect(parseArgoApplications([{}], "shop")).toEqual([]);
  });

  test("returns null age for invalid and future deployment dates", () => {
    const deployments = parseArgoApplications(
      [
        {
          spec: { destination: { namespace: "03" } },
          status: { history: [{ deployedAt: "not-a-date" }] },
        },
        {
          spec: { destination: { namespace: "04" } },
          status: { history: [{ deployedAt: "2026-06-17T12:05:00Z" }] },
        },
      ],
      "shop",
      new Date("2026-06-17T12:00:00Z")
    );

    expect(deployments[0]).toMatchObject({
      ageSeconds: null,
      branch: null,
      ticketKey: null,
    });
    expect(deployments[1]).toMatchObject({
      ageSeconds: 0,
      branch: null,
      ticketKey: null,
    });
  });
});

describe("ticketKeyFromBranch", () => {
  test("extracts Jira keys only from prefixed branch names", () => {
    expect(ticketKeyFromBranch("PC-120-fix-bug")).toBe("PC-120");
    expect(ticketKeyFromBranch("feature/PC-120-fix-bug")).toBeNull();
    expect(ticketKeyFromBranch("master")).toBeNull();
    expect(ticketKeyFromBranch(null)).toBeNull();
  });
});
