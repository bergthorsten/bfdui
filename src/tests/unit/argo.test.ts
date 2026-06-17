import { describe, expect, test } from "vitest";
import { parseArgoApplications, ticketKeyFromBranch } from "@/services/argo";

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
            sync: { status: "Synced" },
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
});

describe("ticketKeyFromBranch", () => {
  test("extracts Jira keys only from prefixed branch names", () => {
    expect(ticketKeyFromBranch("PC-120-fix-bug")).toBe("PC-120");
    expect(ticketKeyFromBranch("feature/PC-120-fix-bug")).toBeNull();
    expect(ticketKeyFromBranch("master")).toBeNull();
    expect(ticketKeyFromBranch(null)).toBeNull();
  });
});
