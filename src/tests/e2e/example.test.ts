import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { findLatestBuild, parseElectronApp } from "electron-playwright-helpers";
import type { AppConfig } from "@/types/bfd";

/*
 * Using Playwright with Electron:
 * https://www.electronjs.org/pt/docs/latest/tutorial/automated-testing#using-playwright
 */

let electronApp: ElectronApplication;
let userDataDir: string;

const CONTINUE_TO_ACCOUNTS = /continue to accounts/i;

const E2E_CONFIG: AppConfig = {
  argo: {
    app: "shop",
    devContext: "dev",
  },
  github: {
    owner: "bergfreunde",
    repo: "shop",
    useGhCli: false,
  },
  jira: {
    baseUrl: "https://jirabergfreunde.atlassian.net",
    email: "",
    project: "PC",
    sprintJql: "sprint in openSprints() AND project = PC ORDER BY rank ASC",
  },
  onboardingComplete: false,
  repoPath: "~/devenv/src",
};

test.beforeEach(async () => {
  const latestBuild = findLatestBuild();
  const appInfo = parseElectronApp(latestBuild);
  userDataDir = mkdtempSync(path.join(tmpdir(), "bfd-e2e-"));
  writeFileSync(
    path.join(userDataDir, "bfd-config.json"),
    JSON.stringify(E2E_CONFIG, null, 2),
    "utf8"
  );

  electronApp = await electron.launch({
    args: [appInfo.main, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, CI: "e2e" },
  });
  electronApp.on("window", (page) => {
    const filename = page.url()?.split("/").pop();
    console.log(`Window opened: ${filename}`);

    page.on("pageerror", (error) => {
      console.error(error);
    });
    page.on("console", (msg) => {
      console.log(msg.text());
    });
  });
});

test.afterEach(async () => {
  await electronApp.close();
  rmSync(userDataDir, { force: true, recursive: true });
});

async function firstWindow() {
  const page = await electronApp.firstWindow();
  await expect(
    page.getByRole("heading", { name: "System check & workspace" })
  ).toBeVisible();
  return page;
}

test("navigates primary pages", async () => {
  const page: Page = await firstWindow();

  await page.getByRole("button", { name: "Skip setup" }).click();

  await expect(
    page.getByRole("heading", { name: "Sprint tickets" })
  ).toBeVisible();

  await page.getByRole("link", { name: "Dev Systems" }).click();
  await expect(
    page.getByRole("heading", { name: "Dev Systems" })
  ).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(
    page.getByRole("heading", { name: "Sprint tickets" })
  ).toBeVisible();
});

test("onboarding manual test buttons show results", async () => {
  const page: Page = await firstWindow();

  await page
    .locator("input")
    .nth(2)
    .fill(path.join(userDataDir, "missing-src"));
  await page.getByRole("button", { name: "Test path" }).click();
  await expect(page.getByTestId("connection-result-repo")).toBeVisible();
  await expect(
    page.getByText("Devenv path does not exist.", { exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: "Test ArgoCD" }).click();
  await expect(page.getByTestId("connection-result-argo")).toBeVisible({
    timeout: 25_000,
  });

  await page.getByRole("button", { name: CONTINUE_TO_ACCOUNTS }).click();

  await page.getByRole("button", { name: "Test Jira" }).click();
  await expect(page.getByTestId("connection-result-jira")).toBeVisible();
  await expect(
    page
      .getByTestId("connection-result-jira")
      .getByText("No Jira email configured.", { exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: "Test GitHub" }).click();
  await expect(page.getByTestId("connection-result-github")).toBeVisible();
  await expect(
    page
      .getByTestId("connection-result-github")
      .getByText("No GitHub token configured.", { exact: true })
  ).toBeVisible();
});
