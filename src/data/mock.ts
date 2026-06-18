import { isDefaultBranch, isReservedEnvironment } from "@/domain/environments";
import {
  DEFAULT_GITHUB_REPO,
  githubBranchUrl,
  githubPullRequestUrl,
} from "@/domain/urls";
import type {
  BranchSummary,
  DevDeployment,
  JiraTicket,
  PullRequestSummary,
  TicketDeploymentRow,
} from "@/types/bfd";

const JIRA_BASE = "https://bergfreunde.atlassian.net/browse";
const TICKET_KEY_PREFIX_PATTERN = /^([A-Z]+-[0-9]+)-/;

function ticket(
  key: string,
  title: string,
  status: string,
  category: JiraTicket["statusCategory"],
  assignee: string | null
): JiraTicket {
  return {
    key,
    id: key,
    title,
    status,
    statusCategory: category,
    assignee,
    assigneeAvatar: null,
    updated: new Date(
      Date.now() - Math.random() * 4 * 86_400_000
    ).toISOString(),
    url: `${JIRA_BASE}/${key}`,
  };
}

export const MOCK_TICKETS: JiraTicket[] = [
  ticket(
    "PC-254",
    "Show member price in basket summary",
    "In Progress",
    "occupied",
    "Lena Hoffmann"
  ),
  ticket(
    "PC-255",
    "Fix search icon invisible border (a11y)",
    "Review",
    "occupied",
    "Thorsten Berg"
  ),
  ticket(
    "PC-261",
    "Wishlist: persist items across sessions",
    "In Arbeit",
    "occupied",
    "Marco Klein"
  ),
  ticket(
    "PC-263",
    "Checkout: add PayPal express button",
    "In Testing",
    "occupied",
    "Sofia Ricci"
  ),
  ticket(
    "PC-268",
    "Product gallery zoom on hover",
    "Awaiting testing",
    "occupied",
    "Lena Hoffmann"
  ),
  ticket(
    "PC-270",
    "Refactor filter sidebar to server components",
    "Selected for Development",
    "backlog",
    "Thorsten Berg"
  ),
  ticket(
    "PC-271",
    "Add size advisor to ski boots PDP",
    "Done",
    "free",
    "Marco Klein"
  ),
  ticket(
    "PC-274",
    "Mini-cart flicker on quantity change",
    "In Progress",
    "occupied",
    null
  ),
];

function sha(): string {
  return Array.from({ length: 40 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");
}

interface DeploySeed {
  ageSeconds: number | null;
  autoSync: DevDeployment["autoSync"];
  branch: string | null;
  env: string;
  health: DevDeployment["health"];
  sync: DevDeployment["sync"];
}

// Mirrors the real dev systems: 01–16, 20, epm, oms, sap.
const SEEDS: DeploySeed[] = [
  {
    env: "01",
    branch: "PC-254-member-price-basket",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 5 * 3600 + 20 * 60,
  },
  {
    env: "02",
    branch: "master",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 26 * 3600,
  },
  {
    env: "03",
    branch: "PC-255-fix-search-icon-invisible-border-a11y",
    sync: "OutOfSync",
    health: "Progressing",
    autoSync: "No prune",
    ageSeconds: 12 * 60,
  },
  {
    env: "04",
    branch: "PC-261-wishlist-persist-sessions",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 2 * 86_400 + 4 * 3600,
  },
  {
    env: "05",
    branch: "master",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 3 * 86_400,
  },
  {
    env: "06",
    branch: "PC-263-checkout-paypal-express",
    sync: "Synced",
    health: "Degraded",
    autoSync: "off",
    ageSeconds: 47 * 60,
  },
  {
    env: "07",
    branch: "PC-274-minicart-flicker-qty",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 95 * 60,
  },
  {
    env: "08",
    branch: "master",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 5 * 86_400,
  },
  {
    env: "09",
    branch: "PC-268-pdp-gallery-zoom",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 8 * 3600,
  },
  {
    env: "10",
    branch: "master",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 6 * 86_400,
  },
  {
    env: "11",
    branch: "master",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 7 * 86_400,
  },
  {
    env: "12",
    branch: "EXP-118-checkout-ab-variant",
    sync: "OutOfSync",
    health: "Healthy",
    autoSync: "off",
    ageSeconds: 33 * 3600,
  },
  {
    env: "13",
    branch: "master",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 9 * 86_400,
  },
  {
    env: "14",
    branch: "master",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 4 * 86_400,
  },
  {
    env: "15",
    branch: "PC-263-checkout-paypal-express",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 70 * 60,
  },
  {
    env: "16",
    branch: "master",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 11 * 86_400,
  },
  {
    env: "20",
    branch: "release-2026.06",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 18 * 3600,
  },
  {
    env: "epm",
    branch: "master",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 30 * 86_400,
  },
  {
    env: "oms",
    branch: "master",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 30 * 86_400,
  },
  {
    env: "sap",
    branch: "master",
    sync: "Synced",
    health: "Healthy",
    autoSync: "on",
    ageSeconds: 30 * 86_400,
  },
];

function ticketKeyFromBranch(branch: string | null): string | null {
  if (!branch) {
    return null;
  }
  const match = branch.match(TICKET_KEY_PREFIX_PATTERN);
  return match ? match[1] : null;
}

export const MOCK_DEPLOYMENTS: DevDeployment[] = SEEDS.map((s) => {
  const ticketKey = ticketKeyFromBranch(s.branch);
  const reserved = isReservedEnvironment(s.env);
  return {
    app: "shop",
    environment: s.env,
    branch: s.branch,
    ticketKey,
    sync: s.sync,
    health: s.health,
    autoSync: s.autoSync,
    deployedAt: s.ageSeconds
      ? new Date(Date.now() - s.ageSeconds * 1000).toISOString()
      : null,
    ageSeconds: s.ageSeconds,
    reserved,
    isFree: isDefaultBranch(s.branch) && !reserved,
  };
});

function pr(
  number: number,
  _ticketKey: string,
  branch: string,
  title: string,
  state: PullRequestSummary["state"],
  isDraft: boolean,
  approved = false
): PullRequestSummary {
  return {
    approved,
    number,
    title,
    url: githubPullRequestUrl(DEFAULT_GITHUB_REPO, number),
    headRef: branch,
    baseRef: "master",
    state,
    isDraft,
    headSha: sha(),
    source: "enriched",
  };
}

const MOCK_PRS: Record<string, PullRequestSummary[]> = {
  "PC-254": [
    pr(
      4821,
      "PC-254",
      "PC-254-member-price-basket",
      "PC-254: Show member price in basket summary",
      "open",
      false,
      true
    ),
  ],
  "PC-255": [
    pr(
      4830,
      "PC-255",
      "PC-255-fix-search-icon-invisible-border-a11y",
      "PC-255: Fix search icon border a11y",
      "open",
      false
    ),
  ],
  "PC-261": [
    pr(
      4835,
      "PC-261",
      "PC-261-wishlist-persist-sessions",
      "PC-261: Persist wishlist across sessions",
      "open",
      true
    ),
  ],
  "PC-263": [
    pr(
      4840,
      "PC-263",
      "PC-263-checkout-paypal-express",
      "PC-263: PayPal express button",
      "merged",
      false
    ),
  ],
  "PC-268": [
    pr(
      4844,
      "PC-268",
      "PC-268-pdp-gallery-zoom",
      "PC-268: PDP gallery zoom on hover",
      "open",
      false
    ),
  ],
  "PC-274": [
    pr(
      4851,
      "PC-274",
      "PC-274-minicart-flicker-qty",
      "PC-274: Fix mini-cart flicker",
      "open",
      true
    ),
  ],
};

function branchSummary(name: string): BranchSummary {
  return {
    name,
    headSha: sha(),
    source: "github",
    url: githubBranchUrl(DEFAULT_GITHUB_REPO, name),
  };
}

export const MOCK_ROWS: TicketDeploymentRow[] = MOCK_TICKETS.map((t) => {
  const prs = MOCK_PRS[t.key] ?? [];
  const deployments = MOCK_DEPLOYMENTS.filter((d) => d.ticketKey === t.key);
  const branches = prs.map((p) => branchSummary(p.headRef));
  return { ticket: t, pullRequests: prs, branches, deployments };
});

export const MOCK_PIPELINE_FAILURES = 1;
export const MOCK_OUTDATED = 2;
