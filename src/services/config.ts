import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

  private unsafeSecretPath(key: SecretKey): string {
    return path.join(this.secretsDir, `${key}.unsafe.txt`);
  }

  setSecret(key: SecretKey, value: string): void {
    if (!value) {
      this.clearSecret(key);
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn(secretStorageUnavailableMessage());
      writeFileSync(this.unsafeSecretPath(key), value, "utf8");
      return;
    }

    const encrypted = safeStorage.encryptString(value);
    writeFileSync(this.secretPath(key), encrypted);
    this.deleteIfExists(this.unsafeSecretPath(key));
  }

  /** Main-process only. Never expose the return value to the renderer. */
  getSecret(key: SecretKey): string | null {
    const file = this.secretPath(key);
    if (!existsSync(file)) {
      return this.getUnsafeSecret(key);
    }
    try {
      const buf = readFileSync(file);
      if (buf.length === 0 || !safeStorage.isEncryptionAvailable()) {
        return this.getUnsafeSecret(key);
      }
      return safeStorage.decryptString(buf);
    } catch (error) {
      console.error(`Failed to decrypt secret ${key}:`, error);
    }

    return this.getUnsafeSecret(key);
  }

  clearSecret(key: SecretKey): void {
    const file = this.secretPath(key);
    if (existsSync(file)) {
      writeFileSync(file, Buffer.alloc(0));
    }
    this.deleteIfExists(this.unsafeSecretPath(key));
  }

  secretStatus(): SecretStatus {
    return {
      jiraToken: this.hasSecret("jiraToken"),
      githubToken: this.hasSecret("githubToken"),
    };
  }

  private getUnsafeSecret(key: SecretKey): string | null {
    const file = this.unsafeSecretPath(key);
    if (!existsSync(file)) {
      return null;
    }
    return readFileSync(file, "utf8") || null;
  }

  private hasSecret(key: SecretKey): boolean {
    return Boolean(this.getSecret(key) ?? this.getUnsafeSecret(key));
  }

  private deleteIfExists(file: string): void {
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }
}

function secretStorageUnavailableMessage(): string {
  if (process.platform === "darwin") {
    return "macOS Keychain is not available to this app right now. Token was not saved.";
  }

  if (process.platform === "linux") {
    return "Linux secret storage is not available. Install and unlock a secret service such as GNOME Keyring or KWallet, then try again.";
  }

  return "Secret storage encryption is not available on this system. Token was not saved.";
}
