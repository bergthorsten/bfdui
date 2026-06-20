import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EXTRA_CLI_PATHS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  path.join(homedir(), ".local", "bin"),
  path.join(homedir(), "bin"),
];

let shellEnvRequest: Promise<NodeJS.ProcessEnv> | null = null;

export async function cliEnv(): Promise<NodeJS.ProcessEnv> {
  const shellEnv = await readShellEnv();
  const delimiter = path.delimiter;
  const existingPath = shellEnv.PATH ?? process.env.PATH ?? "";
  const paths = [
    ...new Set([...EXTRA_CLI_PATHS, ...existingPath.split(delimiter)]),
  ]
    .filter(Boolean)
    .join(delimiter);

  return {
    ...process.env,
    ...shellEnv,
    PATH: paths,
  };
}

export async function execCli(
  command: string,
  args: string[],
  options: { timeout: number }
) {
  return execFileAsync(command, args, {
    ...options,
    env: await cliEnv(),
  });
}

function readShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return Promise.resolve({});
  }

  shellEnvRequest ??= loadShellEnv().catch(() => ({}));
  return shellEnvRequest;
}

async function loadShellEnv(): Promise<NodeJS.ProcessEnv> {
  const shell = process.env.SHELL || defaultShell();
  const { stdout } = await execFileAsync(shell, ["-ilc", "env"], {
    env: process.env,
    timeout: 3000,
  });

  return Object.fromEntries(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        if (index < 0) {
          return ["", ""];
        }
        return [line.slice(0, index), line.slice(index + 1)];
      })
      .filter(([key]) => Boolean(key))
  );
}

function defaultShell(): string {
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}
