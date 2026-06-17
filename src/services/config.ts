import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { app, safeStorage } from "electron";
import type { AppConfig, SecretStatus } from "@/types/bfd";

export type SecretKey = "jiraToken" | "githubToken";

const OLD_DEFAULT_JIRA_BASE_URL = "https://bergfreunde.atlassian.net";
const DEFAULT_JIRA_BASE_URL = "https://jirabergfreunde.atlassian.net";

const DEFAULT_CONFIG: AppConfig = {
  jira: {
    baseUrl: DEFAULT_JIRA_BASE_URL,
    email: "",
    project: "PC",
    sprintJql: "sprint in openSprints() AND project = PC ORDER BY rank ASC",
  },
  github: {
    owner: "bergfreunde",
    repo: "shop",
    useGhCli: true,
  },
  argo: {
    app: "shop",
    devContext: "dev",
  },
  repoPath: path.join(homedir(), "devenv", "src"),
  onboardingComplete: false,
};

/**
 * Self-contained settings store. Non-secret config lives in a plain JSON file
 * in userData; secrets are encrypted at rest with Electron safeStorage and are
 * never returned to the renderer (only their presence is reported).
 */
export class ConfigService {
  private readonly configPath: string;
  private readonly secretsDir: string;
  private config: AppConfig;

  constructor() {
    const base = app.getPath("userData");
    this.configPath = path.join(base, "bfd-config.json");
    this.secretsDir = path.join(base, "secrets");
    if (!existsSync(this.secretsDir)) {
      mkdirSync(this.secretsDir, { recursive: true });
    }
    this.config = this.load();
  }

  private load(): AppConfig {
    try {
      if (existsSync(this.configPath)) {
        const raw = JSON.parse(readFileSync(this.configPath, "utf8"));
        return this.merge(DEFAULT_CONFIG, raw);
      }
    } catch (error) {
      console.error("Failed to read config, using defaults:", error);
    }
    return structuredClone(DEFAULT_CONFIG);
  }

  /** Shallow-per-section merge so new default keys appear for old configs. */
  private merge(base: AppConfig, override: Partial<AppConfig>): AppConfig {
    const jira = { ...base.jira, ...(override.jira ?? {}) };
    if (jira.baseUrl === OLD_DEFAULT_JIRA_BASE_URL) {
      jira.baseUrl = DEFAULT_JIRA_BASE_URL;
    }

    return {
      jira,
      github: { ...base.github, ...(override.github ?? {}) },
      argo: { ...base.argo, ...(override.argo ?? {}) },
      repoPath: override.repoPath ?? base.repoPath,
      onboardingComplete:
        override.onboardingComplete ?? base.onboardingComplete,
    };
  }

  get(): AppConfig {
    return structuredClone(this.config);
  }

  update(patch: Partial<AppConfig>): AppConfig {
    this.config = this.merge(this.config, patch);
    writeFileSync(
      this.configPath,
      JSON.stringify(this.config, null, 2),
      "utf8"
    );
    return this.get();
  }

  private secretPath(key: SecretKey): string {
    return path.join(this.secretsDir, `${key}.enc`);
  }

  setSecret(key: SecretKey, value: string): void {
    if (!value) {
      this.clearSecret(key);
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "Secret storage encryption is not available on this system. Token was not saved."
      );
    }

    const encrypted = safeStorage.encryptString(value);
    writeFileSync(this.secretPath(key), encrypted);
  }

  /** Main-process only. Never expose the return value to the renderer. */
  getSecret(key: SecretKey): string | null {
    const file = this.secretPath(key);
    if (!existsSync(file)) {
      return null;
    }
    try {
      const buf = readFileSync(file);
      if (buf.length === 0 || !safeStorage.isEncryptionAvailable()) {
        return null;
      }
      return safeStorage.decryptString(buf);
    } catch (error) {
      console.error(`Failed to decrypt secret ${key}:`, error);
      return null;
    }
  }

  clearSecret(key: SecretKey): void {
    const file = this.secretPath(key);
    if (existsSync(file)) {
      writeFileSync(file, Buffer.alloc(0));
    }
  }

  secretStatus(): SecretStatus {
    return {
      jiraToken: Boolean(this.getSecret("jiraToken")),
      githubToken: Boolean(this.getSecret("githubToken")),
    };
  }
}
