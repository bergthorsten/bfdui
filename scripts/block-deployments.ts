const message = [
  "Deployment blocker is active.",
  "Deployments are intentionally disabled until all other MVP work is complete.",
  "Remove this blocker only when the final human-run deployment validation starts.",
].join("\n");

console.error(message);
process.exitCode = 1;
