import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { app } from "electron";
import type { ConfigService } from "@/services/config";
import type {
  WorkflowInputDefinition,
  WorkflowInputType,
  WorkflowTarget,
  WorkflowTargetDiscoveryResult,
  WorkflowTargetUsage,
  WorkflowTargetUsageInput,
} from "@/types/bfd";

type ConfigProvider = Pick<ConfigService, "get">;
type UsageStore = Record<string, WorkflowTargetUsage>;

const DEPLOYABLE_WORKFLOW_EXTENSION_PATTERN = /\.ya?ml$/i;
const EXCLUDED_WORKFLOW_PREFIX_PATTERN = /^(CHECK|LEGACY|RW)_/i;
const LINE_BREAK_PATTERN = /\r?\n/;
const WORKFLOW_DISPATCH_PATTERN = /\bworkflow_dispatch\b/;
const YAML_INDENT_SEARCH_PATTERN = /\S|$/;
const YAML_KEY_PATTERN = /^([^:]+):(.*)$/;
const YAML_LIST_ITEM_PATTERN = /^-\s*(.*)$/;

export class WorkflowService {
  private readonly config: ConfigProvider;
  private readonly usageStorePath: string;

  constructor(
    config: ConfigProvider,
    usageStorePath = path.join(
      app.getPath("userData"),
      "workflow-target-usage.json"
    )
  ) {
    this.config = config;
    this.usageStorePath = usageStorePath;
  }

  discoverTargets(): WorkflowTargetDiscoveryResult {
    const repoPath = expandHome(this.config.get().repoPath);
    const workflowsPath = resolveWorkflowsPath(
      repoPath,
      this.config.get().github.repo
    );
    const warnings: string[] = [];

    if (!workflowsPath) {
      return {
        repoPath,
        targets: [],
        warnings: [
          workflowPathWarning(repoPath, this.config.get().github.repo),
        ],
        workflowsPath: null,
      };
    }

    const usage = this.readUsage();
    const targets = readdirSync(workflowsPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .filter((entry) => DEPLOYABLE_WORKFLOW_EXTENSION_PATTERN.test(entry.name))
      .filter((entry) => !EXCLUDED_WORKFLOW_PREFIX_PATTERN.test(entry.name))
      .flatMap((entry) => {
        const fullPath = path.join(workflowsPath, entry.name);
        const content = readWorkflowFile(fullPath, warnings);
        if (!(content && hasWorkflowDispatch(content))) {
          return [];
        }

        const name = workflowNameFromFile(entry.name);
        return [
          {
            aliases: aliasesForWorkflowName(name),
            affectedPathGlobs: parseWorkflowAffectedPathGlobs(content),
            fileName: entry.name,
            group: workflowGroupForName(name),
            inputs: parseWorkflowDispatchInputs(content),
            name,
            path: `.github/workflows/${entry.name}`,
            usage: usage[name] ?? null,
          } satisfies WorkflowTarget,
        ];
      })
      .sort(compareTargetsByUsageThenName);

    return { repoPath, targets, warnings, workflowsPath };
  }

  recordUsage(input: WorkflowTargetUsageInput): WorkflowTargetUsage {
    const name = normalizeWorkflowName(input.name);
    const usage = this.readUsage();
    const current = usage[name] ?? { lastUsedAt: 0, usageCount: 0 };
    const next: WorkflowTargetUsage = {
      lastUsedAt: Date.now(),
      usageCount: current.usageCount + 1,
    };

    if (input.branch) {
      next.lastBranch = input.branch;
    }
    if (input.environment) {
      next.lastEnvironment = input.environment;
    }
    if (input.ticketKey) {
      next.lastTicketKey = input.ticketKey;
    }

    usage[name] = next;
    this.writeUsage(usage);
    return next;
  }

  resolveTargetAlias(alias: string): WorkflowTarget | null {
    const normalized = normalizeWorkflowName(alias);
    const { targets } = this.discoverTargets();
    return (
      targets.find((target) => target.name === normalized) ??
      targets.find((target) => target.aliases.includes(normalized)) ??
      null
    );
  }

  private readUsage(): UsageStore {
    if (!existsSync(this.usageStorePath)) {
      return {};
    }

    try {
      const raw = JSON.parse(readFileSync(this.usageStorePath, "utf8"));
      if (!isRecord(raw)) {
        return {};
      }

      return Object.fromEntries(
        Object.entries(raw).flatMap(([key, value]) => {
          const usage = usageFromUnknown(value);
          return usage ? [[normalizeWorkflowName(key), usage]] : [];
        })
      );
    } catch {
      return {};
    }
  }

  private writeUsage(usage: UsageStore): void {
    mkdirSync(path.dirname(this.usageStorePath), { recursive: true });
    writeFileSync(this.usageStorePath, JSON.stringify(usage, null, 2), "utf8");
  }
}

function resolveWorkflowsPath(
  repoPath: string,
  repoName: string
): string | null {
  const directPath = path.join(repoPath, ".github", "workflows");
  if (isDirectory(directPath)) {
    return directPath;
  }

  const nestedPath = path.join(repoPath, repoName, ".github", "workflows");
  if (isDirectory(nestedPath)) {
    return nestedPath;
  }

  return null;
}

function workflowPathWarning(repoPath: string, repoName: string): string {
  if (!existsSync(repoPath)) {
    return "Configured repo/devenv path does not exist.";
  }
  if (!isDirectory(repoPath)) {
    return "Configured repo/devenv path is not a directory.";
  }
  if (repoPath.endsWith(path.sep + repoName)) {
    return "No .github/workflows directory found in this checkout.";
  }
  return `No ${repoName}/.github/workflows directory found inside the configured devenv path.`;
}

function isDirectory(value: string): boolean {
  return existsSync(value) && statSync(value).isDirectory();
}

function readWorkflowFile(filePath: string, warnings: string[]): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    warnings.push(
      `Could not read ${path.basename(filePath)}: ${messageOf(error)}`
    );
    return null;
  }
}

function hasWorkflowDispatch(content: string): boolean {
  return content.split(LINE_BREAK_PATTERN).some((rawLine) => {
    const line = rawLine.split("#")[0];
    return WORKFLOW_DISPATCH_PATTERN.test(line);
  });
}

function parseWorkflowDispatchInputs(
  content: string
): WorkflowInputDefinition[] {
  const lines = content.split(LINE_BREAK_PATTERN).map(parseYamlLine);
  const dispatchIndex = lines.findIndex((line) =>
    WORKFLOW_DISPATCH_PATTERN.test(line.text)
  );
  if (dispatchIndex < 0) {
    return [];
  }

  const dispatchIndent = lines[dispatchIndex].indent;
  const inputsIndex = lines.findIndex(
    (line, index) =>
      index > dispatchIndex &&
      line.text.startsWith("inputs:") &&
      line.indent > dispatchIndent
  );
  if (inputsIndex < 0) {
    return [];
  }

  const inputsIndent = lines[inputsIndex].indent;
  const inputs: WorkflowInputDefinition[] = [];
  let index = inputsIndex + 1;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.text) {
      index += 1;
      continue;
    }
    if (line.indent <= inputsIndent) {
      break;
    }

    const inputKey = parseYamlKey(line.text);
    if (!(inputKey && line.indent > inputsIndent)) {
      index += 1;
      continue;
    }

    const nextInputIndex = nextYamlSiblingIndex(lines, index + 1, line.indent);
    inputs.push(
      parseWorkflowInputBlock(inputKey, lines.slice(index + 1, nextInputIndex))
    );
    index = nextInputIndex;
  }

  return inputs;
}

function parseWorkflowAffectedPathGlobs(content: string): string[] {
  const lines = content.split(LINE_BREAK_PATTERN).map(parseYamlLine);
  const onIndex = lines.findIndex(
    (line) => parseYamlKeyName(line.text) === "on"
  );
  if (onIndex < 0) {
    return [];
  }

  const onIndent = lines[onIndex].indent;
  const onEndIndex = nextYamlSiblingIndex(lines, onIndex + 1, onIndent);
  const pushIndex = lines.findIndex(
    (line, index) =>
      index > onIndex &&
      index < onEndIndex &&
      line.text &&
      line.indent > onIndent &&
      parseYamlKeyName(line.text) === "push"
  );
  if (pushIndex < 0) {
    return [];
  }

  const pushIndent = lines[pushIndex].indent;
  const pushEndIndex = nextYamlSiblingIndex(lines, pushIndex + 1, pushIndent);
  const pathsIndex = lines.findIndex(
    (line, index) =>
      index > pushIndex &&
      index < pushEndIndex &&
      line.text &&
      line.indent > pushIndent &&
      parseYamlKeyName(line.text) === "paths"
  );
  if (pathsIndex < 0) {
    return [];
  }

  return parseYamlList(lines, pathsIndex + 1, lines[pathsIndex].indent);
}

function parseWorkflowInputBlock(
  name: string,
  lines: Array<{ indent: number; text: string }>
): WorkflowInputDefinition {
  const input: WorkflowInputDefinition = {
    name: unquoteYamlScalar(name),
    options: [],
    required: false,
    type: "string",
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const property = parseYamlProperty(line.text);
    if (!property) {
      continue;
    }

    const key = unquoteYamlScalar(property.key).toLowerCase();
    const value = unquoteYamlScalar(property.value);
    switch (key) {
      case "default":
        input.default = value;
        break;
      case "description":
        input.description = value;
        break;
      case "options":
        input.options = parseYamlList(lines, index + 1, line.indent);
        break;
      case "required":
        input.required = value.toLowerCase() === "true";
        break;
      case "type":
        input.type = workflowInputType(value);
        break;
      default:
        break;
    }
  }

  return input;
}

function parseYamlList(
  lines: Array<{ indent: number; text: string }>,
  startIndex: number,
  parentIndent: number
): string[] {
  const values: string[] = [];
  for (const line of lines.slice(startIndex)) {
    if (!line.text) {
      continue;
    }
    if (line.indent <= parentIndent) {
      break;
    }
    const match = line.text.match(YAML_LIST_ITEM_PATTERN);
    if (!match) {
      continue;
    }
    values.push(unquoteYamlScalar(match[1] ?? ""));
  }
  return values;
}

function nextYamlSiblingIndex(
  lines: Array<{ indent: number; text: string }>,
  startIndex: number,
  siblingIndent: number
): number {
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (line.text && line.indent <= siblingIndent) {
      break;
    }
    index += 1;
  }
  return index;
}

function parseYamlLine(rawLine: string): { indent: number; text: string } {
  const withoutComment = rawLine.split("#")[0] ?? "";
  return {
    indent: withoutComment.search(YAML_INDENT_SEARCH_PATTERN),
    text: withoutComment.trim(),
  };
}

function parseYamlKey(text: string): string | null {
  return parseYamlProperty(text)?.key ?? null;
}

function parseYamlKeyName(text: string): string | null {
  const key = parseYamlKey(text);
  return key ? unquoteYamlScalar(key).toLowerCase() : null;
}

function parseYamlProperty(
  text: string
): { key: string; value: string } | null {
  const match = text.match(YAML_KEY_PATTERN);
  if (!match) {
    return null;
  }
  return { key: match[1]?.trim() ?? "", value: match[2]?.trim() ?? "" };
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function workflowInputType(value: string): WorkflowInputType {
  switch (value.toLowerCase()) {
    case "boolean":
    case "choice":
    case "environment":
    case "number":
      return value.toLowerCase() as WorkflowInputType;
    default:
      return "string";
  }
}

function workflowNameFromFile(fileName: string): string {
  return fileName.replace(DEPLOYABLE_WORKFLOW_EXTENSION_PATTERN, "");
}

function aliasesForWorkflowName(name: string): string[] {
  const aliases = new Set([name]);
  const parts = name.split("-").filter(Boolean);
  if (parts.length > 1) {
    aliases.add(parts.slice(1).join("-"));
  }
  return [...aliases];
}

function workflowGroupForName(name: string): string {
  if (name.startsWith("app-api-")) {
    return "app-api";
  }
  return name.split("-")[0] || "other";
}

function compareTargetsByUsageThenName(a: WorkflowTarget, b: WorkflowTarget) {
  const usageDelta = (b.usage?.usageCount ?? 0) - (a.usage?.usageCount ?? 0);
  if (usageDelta !== 0) {
    return usageDelta;
  }

  const lastUsedDelta = (b.usage?.lastUsedAt ?? 0) - (a.usage?.lastUsedAt ?? 0);
  if (lastUsedDelta !== 0) {
    return lastUsedDelta;
  }

  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function normalizeWorkflowName(value: string): string {
  return workflowNameFromFile(path.basename(value.trim()));
}

function usageFromUnknown(value: unknown): WorkflowTargetUsage | null {
  if (!isRecord(value)) {
    return null;
  }

  const usageCount = numberFromUnknown(value.usageCount);
  const lastUsedAt = numberFromUnknown(value.lastUsedAt);
  if (usageCount <= 0 || lastUsedAt <= 0) {
    return null;
  }

  const usage: WorkflowTargetUsage = { lastUsedAt, usageCount };
  if (typeof value.lastBranch === "string") {
    usage.lastBranch = value.lastBranch;
  }
  if (typeof value.lastEnvironment === "string") {
    usage.lastEnvironment = value.lastEnvironment;
  }
  if (typeof value.lastTicketKey === "string") {
    usage.lastTicketKey = value.lastTicketKey;
  }
  return usage;
}

function numberFromUnknown(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
