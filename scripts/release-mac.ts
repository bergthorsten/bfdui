import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

interface PackageJson {
  productName: string;
  version: string;
}

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
const dmgPath = `out/make/${packageJson.productName}-${packageJson.version}-arm64.dmg`;
const zipPath = `out/make/zip/darwin/arm64/${packageJson.productName}-darwin-arm64-${packageJson.version}.zip`;

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

try {
  output("git", ["ls-remote", "--exit-code", "--tags", "origin", tag]);
  console.error(`Tag ${tag} already exists on origin.`);
  process.exit(1);
} catch {
  // Expected when the remote release tag does not exist yet.
}

console.log("Building signed macOS release assets");
run("npm", ["run", "make:mac"]);

for (const artifact of [dmgPath, zipPath]) {
  if (!existsSync(artifact)) {
    console.error(`Expected release artifact missing: ${artifact}`);
    process.exit(1);
  }
}

console.log(`Creating release tag ${tag}`);
run("git", ["tag", tag]);

console.log("Pushing main and tags");
run("git", ["push", "origin", "main"]);
run("git", ["push", "origin", tag]);

console.log("Creating GitHub Release and uploading macOS assets");
run("gh", [
  "release",
  "create",
  tag,
  dmgPath,
  zipPath,
  "--verify-tag",
  "--title",
  tag,
  "--generate-notes",
]);
