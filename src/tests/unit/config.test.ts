import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigService } from "@/services/config";

const electronState = vi.hoisted(() => ({
  encryptionAvailable: true,
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => electronState.userDataDir),
  },
  safeStorage: {
    decryptString: vi.fn((value: Buffer) => {
      const raw = value.toString("utf8");
      if (!raw.startsWith("encrypted:")) {
        throw new Error("Invalid ciphertext");
      }
      return raw.slice("encrypted:".length);
    }),
    encryptString: vi.fn((value: string) =>
      Buffer.from(`encrypted:${value}`, "utf8")
    ),
    isEncryptionAvailable: vi.fn(() => electronState.encryptionAvailable),
  },
}));

describe("ConfigService", () => {
  beforeEach(() => {
    electronState.encryptionAvailable = true;
    electronState.userDataDir = mkdtempSync(path.join(tmpdir(), "bfd-config-"));
  });

  afterEach(() => {
    rmSync(electronState.userDataDir, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  test("loads default config", () => {
    const service = new ConfigService();

    expect(service.get()).toMatchObject({
      github: { owner: "bergfreunde", repo: "shop", useGhCli: true },
      jira: {
        baseUrl: "https://jirabergfreunde.atlassian.net",
        project: "PC",
      },
      onboardingComplete: false,
    });
  });

  test("merges partial config and migrates the old Jira URL", () => {
    writeFileSync(
      path.join(electronState.userDataDir, "bfd-config.json"),
      JSON.stringify({
        github: { repo: "storefront" },
        jira: { baseUrl: "https://bergfreunde.atlassian.net" },
      }),
      "utf8"
    );

    const service = new ConfigService();

    expect(service.get()).toMatchObject({
      github: { owner: "bergfreunde", repo: "storefront", useGhCli: true },
      jira: { baseUrl: "https://jirabergfreunde.atlassian.net" },
    });
  });

  test("saves, reads, reports, and clears encrypted secrets", () => {
    const service = new ConfigService();

    service.setSecret("jiraToken", "token-123");

    expect(service.getSecret("jiraToken")).toBe("token-123");
    expect(service.secretStatus()).toMatchObject({ jiraToken: true });

    service.clearSecret("jiraToken");

    expect(service.getSecret("jiraToken")).toBeNull();
    expect(service.secretStatus()).toMatchObject({ jiraToken: false });
  });

  test("does not write secrets when encryption is unavailable", () => {
    const service = new ConfigService();
    electronState.encryptionAvailable = false;

    expect(() => service.setSecret("jiraToken", "token-123")).toThrow(
      "Secret storage encryption is not available"
    );
    expect(
      existsSync(
        path.join(electronState.userDataDir, "secrets", "jiraToken.enc")
      )
    ).toBe(false);
  });

  test("does not read encrypted secrets when encryption is unavailable", () => {
    const service = new ConfigService();
    service.setSecret("jiraToken", "token-123");

    electronState.encryptionAvailable = false;

    expect(service.getSecret("jiraToken")).toBeNull();
    expect(service.secretStatus()).toMatchObject({ jiraToken: false });
  });
});
