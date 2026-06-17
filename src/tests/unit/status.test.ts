import { describe, expect, test } from "vitest";
import {
  autoSyncLabel,
  autoSyncVariant,
  formatAge,
  healthVariant,
  initialsOf,
  jiraStatusVariant,
  syncVariant,
} from "@/lib/status";

describe("status helpers", () => {
  test("maps known statuses to badge variants", () => {
    expect(jiraStatusVariant("Done", "occupied")).toBe("success");
    expect(jiraStatusVariant("In Testing", "occupied")).toBe("purple");
    expect(jiraStatusVariant("Review", "occupied")).toBe("warning");
    expect(jiraStatusVariant("Something Else", "backlog")).toBe("muted");
    expect(syncVariant("OutOfSync")).toBe("warning");
    expect(healthVariant("Degraded")).toBe("danger");
    expect(autoSyncVariant("No prune")).toBe("info");
    expect(autoSyncLabel("off")).toBe("Manual");
  });

  test("formats ages and initials", () => {
    expect(formatAge(null)).toBe("—");
    expect(formatAge(45)).toBe("45s");
    expect(formatAge(125)).toBe("2m");
    expect(formatAge(3720)).toBe("1h 2m");
    expect(formatAge(93_600)).toBe("1d 2h");
    expect(initialsOf("Lena Hoffmann")).toBe("LH");
    expect(initialsOf(null)).toBe("?");
  });
});
