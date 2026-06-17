import type {
  ArgoAutoSync,
  ArgoHealth,
  ArgoSync,
  JiraStatusCategory,
} from "@/types/bfd";

type BadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "muted"
  | "purple";

const WHITESPACE_PATTERN = /\s+/;
const STATUS_DONE = new Set(["Awaiting go live", "Done", "Erledigt", "Fertig"]);
const STATUS_TODO = new Set([
  "Backlog",
  "Selected for Development",
  "To Do",
  "Zu erledigen",
]);
const STATUS_PROGRESS = new Set(["In Arbeit", "In Progress"]);
const STATUS_REVIEW = new Set(["Awaiting Review", "Clarification", "Review"]);
const STATUS_TESTING = new Set([
  "Acceptance Test",
  "Awaiting testing",
  "In Testing",
]);
const STATUS_BLOCKED = new Set(["Blocked", "Rejected"]);

export function jiraStatusVariant(
  status: string,
  category: JiraStatusCategory
): BadgeVariant {
  if (STATUS_DONE.has(status)) {
    return "success";
  }
  if (STATUS_TESTING.has(status)) {
    return "purple";
  }
  if (STATUS_REVIEW.has(status)) {
    return "warning";
  }
  if (STATUS_PROGRESS.has(status)) {
    return "info";
  }
  if (STATUS_TODO.has(status)) {
    return "muted";
  }
  if (STATUS_BLOCKED.has(status)) {
    return "danger";
  }

  switch (category) {
    case "free":
      return "success";
    case "occupied":
      return "info";
    case "backlog":
      return "muted";
    case "reserved":
      return "warning";
    default:
      return "muted";
  }
}

export function syncVariant(sync: ArgoSync): BadgeVariant {
  if (sync === "Synced") {
    return "success";
  }
  if (sync === "OutOfSync") {
    return "warning";
  }
  return "muted";
}

export function healthVariant(health: ArgoHealth): BadgeVariant {
  if (health === "Healthy") {
    return "success";
  }
  if (health === "Progressing") {
    return "info";
  }
  if (health === "Degraded" || health === "Missing") {
    return "danger";
  }
  return "muted";
}

export function autoSyncVariant(auto: ArgoAutoSync): BadgeVariant {
  if (auto === "on") {
    return "success";
  }
  if (auto === "No prune") {
    return "info";
  }
  return "muted";
}

export function autoSyncLabel(auto: ArgoAutoSync): string {
  if (auto === "on") {
    return "Auto";
  }
  if (auto === "No prune") {
    return "No prune";
  }
  return "Manual";
}

/** Compact, CLI-like age string (e.g. "2d 4h", "37m"). */
export function formatAge(seconds: number | null): string {
  if (seconds == null) {
    return "—";
  }
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) {
    return `${d}d ${h}h`;
  }
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  if (m > 0) {
    return `${m}m`;
  }
  return `${seconds}s`;
}

export function initialsOf(name: string | null): string {
  if (!name) {
    return "?";
  }
  const parts = name.trim().split(WHITESPACE_PATTERN);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}
