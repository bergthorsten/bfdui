import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

type PackageJson = {
  version: string;
};

function run(command: string, args: string[]) {
  execFileSync(command, args, { stdio: "inherit" });
}

function output(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as PackageJson;
const tag = `v${packageJson.version}`;

if (output("git", ["status", "--porcelain"])) {
  console.error("Working tree is not clean. Commit or stash changes first.");
  process.exit(1);
}

try {
  output("git", ["rev-parse", "--verify", tag]);
  console.error(`Tag ${tag} already exists locally.`);
  process.exit(1);
} catch {
  // Expected when the release tag does not exist yet.
}

console.log(`Creating release tag ${tag}`);
run("git", ["tag", tag]);

console.log("Pushing main and tags");
run("git", ["push", "origin", "main"]);
run("git", ["push", "origin", tag]);

console.log("Publishing signed macOS release assets");
run("npm", ["run", "publish:mac"]);
