#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRehearsal } from "./scan-release-rehearsal-safety.mjs";

function fail(message) {
  throw new Error(message);
}

function requireText(source, expected, path) {
  if (!source.includes(expected)) fail(`${path} no longer contains expected release contract: ${expected}`);
}

function read(root, path) {
  return readFileSync(join(root, path), "utf8");
}

export function validateWorkflowSafety(path) {
  const source = readFileSync(path, "utf8");
  requireText(source, "workflow_dispatch:", path);
  for (const input of ["version:", "public_sha:", "public_ref:", "mode:", "idempotency_key:"]) {
    requireText(source, input, path);
  }
  requireText(source, "permissions:\n  contents: read", path);
  requireText(source, "vars.REHEARSAL_ENABLE_RELEASE_REHEARSAL == 'true'", path);
  requireText(source, "--no-recurse-submodules", path);
  requireText(source, 'git remote set-url origin "https://github.com/${GITHUB_REPOSITORY}.git"', path);

  const usesPublicationApp = source.includes("secrets.PUBLICATION_APP_PRIVATE_KEY");
  if (usesPublicationApp) {
    requireText(source, "uses: actions/create-github-app-token@", path);
    requireText(source, "permission-contents: read", path);
  }
  const safetySource = source.replaceAll(
    "secrets.PUBLICATION_APP_PRIVATE_KEY",
    "allowed-read-only-app-key"
  );
  const forbidden = [
    [/\b(?:contents|packages|actions|attestations|checks|deployments|pull-requests):\s*write\b/, "write permission"],
    [/\bid-token:\s*write\b/, "OIDC permission"],
    [/\bsecrets\./, "secret reference"],
    [/^\s*environment:\s*/m, "GitHub environment"],
    [/^\s*(?:push|pull_request|repository_dispatch):\s*$/m, "non-manual trigger"],
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(safetySource)) fail(`${path} contains forbidden ${label}`);
  }
}

export function validatePublicationContracts(publicRoot) {
  const releasePath = ".github/workflows/release.yml";
  const release = read(publicRoot, releasePath);
  requireText(release, "changesets/action@", releasePath);
  requireText(release, "createGithubReleases: false", releasePath);
  requireText(release, 'v.docker.${STEPS_GET_VERSION_OUTPUTS_PACKAGE_VERSION}', releasePath);
  requireText(release, 'helm-v${STEPS_GET_VERSION_OUTPUTS_PACKAGE_VERSION}', releasePath);
  requireText(release, "scripts/generate-github-release.mjs", releasePath);

  const publishPath = ".github/workflows/publish.yml";
  const publish = read(publicRoot, publishPath);
  requireText(publish, "./.github/workflows/publish-webapp.yml", publishPath);
  requireText(publish, "./.github/workflows/publish-worker-v4.yml", publishPath);

  const webappPath = ".github/workflows/publish-webapp.yml";
  const webapp = read(publicRoot, webappPath);
  requireText(webapp, "./docker/Dockerfile", webappPath);
  requireText(webapp, "github.event.repository.name", webappPath);
  requireText(webapp, ":v4,$REF_WITHOUT_TAG:latest", webappPath);

  const workerPath = ".github/workflows/publish-worker-v4.yml";
  const worker = read(publicRoot, workerPath);
  requireText(worker, "matrix:\n        package: [supervisor]", workerPath);
  requireText(worker, ":v4,$ref_without_tag:latest", workerPath);

  const helmPath = ".github/workflows/release-helm.yml";
  const helm = read(publicRoot, helmPath);
  requireText(helm, "CHART_NAME: trigger", helmPath);
  requireText(helm, 'tag_name: helm-v${{ steps.version.outputs.version }}', helmPath);

  const docsPath = ".github/workflows/publish-docs.yml";
  const docs = read(publicRoot, docsPath);
  requireText(docs, '"docs-release-*"', docsPath);
  requireText(docs, "git/refs/heads/docs-live", docsPath);

  const changesets = JSON.parse(read(publicRoot, ".changeset/config.json"));
  const fixed = changesets.fixed ?? [];
  if (!fixed.some((group) => group.includes("@trigger.dev/*") && group.includes("trigger.dev"))) {
    fail("Changesets fixed package group no longer matches release planner assumptions");
  }
}

export function validateRehearsal(root) {
  const absoluteRoot = resolve(root);
  const publicRoot = existsSync(join(absoluteRoot, "oss", "package.json"))
    ? join(absoluteRoot, "oss")
    : absoluteRoot;
  const workflows = [join(publicRoot, ".github", "workflows", "release-rehearsal.yml")];
  const privateWorkflow = join(absoluteRoot, ".github", "workflows", "release-rehearsal.yml");
  if (privateWorkflow !== workflows[0] && existsSync(privateWorkflow)) workflows.push(privateWorkflow);
  for (const workflow of workflows) validateWorkflowSafety(workflow);
  scanRehearsal(absoluteRoot);
  validatePublicationContracts(publicRoot);
  return { workflows: workflows.length, publicRoot };
}

function main() {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex === -1 ? "." : process.argv[rootIndex + 1];
  if (!root) fail("--root requires a value");
  const result = validateRehearsal(root);
  console.log(
    `Static release rehearsal validation passed (${result.workflows} rehearsal workflow(s), publication contracts under ${result.publicRoot}).`
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`release rehearsal validation failed: ${error.message}`);
    process.exit(1);
  }
}
