export const DEV_ENVIRONMENTS = Array.from({ length: 16 }, (_, index) =>
  String(index + 1).padStart(2, "0")
);

export const RESERVED_ENVIRONMENTS = ["20", "epm", "oms", "sap"];
export const NON_PROD_ENVIRONMENTS = [
  ...DEV_ENVIRONMENTS,
  ...RESERVED_ENVIRONMENTS,
  "staging",
];

export const DEFAULT_BRANCHES = ["master", "main"] as const;
export const NUMERIC_ENVIRONMENT_PATTERN = /^\d+$/;

const RESERVED_ENVIRONMENT_SET = new Set<string>(RESERVED_ENVIRONMENTS);
const DEFAULT_BRANCH_SET = new Set<string>(DEFAULT_BRANCHES);

export function isReservedEnvironment(environment: string): boolean {
  return RESERVED_ENVIRONMENT_SET.has(environment);
}

export function isDefaultBranch(branch: string | null): boolean {
  return branch ? DEFAULT_BRANCH_SET.has(branch) : true;
}

export function environmentDisplayName(environment: string): string {
  if (NUMERIC_ENVIRONMENT_PATTERN.test(environment)) {
    return `dev-${environment}`;
  }
  return environment;
}
