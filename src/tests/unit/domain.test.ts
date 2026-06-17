import { describe, expect, test } from "vitest";
import {
  environmentDisplayName,
  isDefaultBranch,
  isReservedEnvironment,
} from "@/domain/environments";
import {
  devSystemUrl,
  githubBranchUrl,
  githubPullRequestUrl,
} from "@/domain/urls";

describe("environment helpers", () => {
  test("classifies reserved systems and default branches", () => {
    expect(isReservedEnvironment("20")).toBe(true);
    expect(isReservedEnvironment("04")).toBe(false);
    expect(isDefaultBranch("master")).toBe(true);
    expect(isDefaultBranch("main")).toBe(true);
    expect(isDefaultBranch(null)).toBe(true);
    expect(isDefaultBranch("PC-123-feature")).toBe(false);
  });

  test("formats environment display names", () => {
    expect(environmentDisplayName("04")).toBe("dev-04");
    expect(environmentDisplayName("oms")).toBe("oms");
  });
});

describe("URL helpers", () => {
  const github = { owner: "acme", repo: "shop" };

  test("builds GitHub URLs from configured owner and repo", () => {
    expect(githubBranchUrl(github, "PC-123/test branch")).toBe(
      "https://github.com/acme/shop/tree/PC-123%2Ftest%20branch"
    );
    expect(githubPullRequestUrl(github, 42)).toBe(
      "https://github.com/acme/shop/pull/42"
    );
  });

  test("builds dev-system URLs", () => {
    expect(devSystemUrl("04")).toBe("https://dev-04.bergfreunde.de/");
    expect(devSystemUrl("oms")).toBe("https://oms.bergfreunde.de/");
  });
});
