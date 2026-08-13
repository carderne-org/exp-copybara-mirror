#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STEP_NAMES = ["npm", "images", "helm", "releases", "docs", "downstream"];

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail(`Invalid argument near ${key ?? "end"}`);
    options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function emptyState() {
  return {
    schemaVersion: 1,
    kind: "local-fake-release-state",
    operations: {},
    npm: { versions: {}, distTags: {}, gitTags: {} },
    images: { tags: {} },
    helm: { artifacts: {}, gitTags: {}, githubReleases: {} },
    releases: { gitTags: {}, githubReleases: {}, dockerTriggerTags: {} },
    docs: { releaseTags: {}, refs: {} },
    downstream: { events: {} },
  };
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function put(map, key, value, surface) {
  if (Object.hasOwn(map, key) && JSON.stringify(map[key]) !== JSON.stringify(value)) {
    fail(`${surface} conflict for ${key}`);
  }
  map[key] = value;
}

function writeState(path, state) {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

function validatePlan(plan) {
  if (plan.schemaVersion !== 1 || plan.kind !== "fake-stable-release-rehearsal") {
    fail("Unsupported release rehearsal plan");
  }
  if (
    plan.safety?.localOnly !== true ||
    plan.safety?.mutationsPerformed !== false ||
    plan.request?.idempotencyKey !== `${plan.request?.version}:${plan.request?.publicSha}`
  ) {
    fail("Plan does not satisfy the local-only stable release contract");
  }
}

export function applyFakeRelease({ plan, state: suppliedState, failAfter }) {
  validatePlan(plan);
  if (failAfter && !STEP_NAMES.includes(failAfter)) {
    fail(`fail-after must be one of: ${STEP_NAMES.join(", ")}`);
  }

  const state = suppliedState ?? emptyState();
  if (state.schemaVersion !== 1 || state.kind !== "local-fake-release-state") {
    fail("Unsupported fake release state");
  }

  const operationKey = plan.request.idempotencyKey;
  const planDigest = digest(plan);
  const existingOperation = state.operations[operationKey];
  if (existingOperation && existingOperation.planDigest !== planDigest) {
    fail(`Idempotency key ${operationKey} is already bound to another plan`);
  }
  const operation = existingOperation ?? {
    planDigest,
    status: "in-progress",
    completedSteps: [],
  };
  state.operations[operationKey] = operation;

  const applyStep = (name, apply) => {
    apply();
    if (!operation.completedSteps.includes(name)) operation.completedSteps.push(name);
    if (failAfter === name) {
      operation.status = "in-progress";
      return false;
    }
    return true;
  };

  if (
    !applyStep("npm", () => {
      for (const pkg of plan.packageRelease.packages) {
        put(
          state.npm.versions,
          `${pkg.name}@${pkg.version}`,
          { manifest: pkg.manifest, changelogSha256: pkg.changelog.sha256, sourceSha: plan.request.publicSha },
          "npm version"
        );
        put(state.npm.distTags, `${pkg.name}:${plan.packageRelease.distTag}`, pkg.version, "npm dist-tag");
        put(state.npm.gitTags, pkg.gitTag, plan.request.publicSha, "package git tag");
      }
    })
  ) return { state, failedAfter: "npm" };

  if (
    !applyStep("images", () => {
      for (const image of plan.images) {
        for (const tag of image.tags) {
          put(state.images.tags, `${image.repository}:${tag}`, image.sourceSha, "image tag");
        }
      }
    })
  ) return { state, failedAfter: "images" };

  if (
    !applyStep("helm", () => {
      put(state.helm.artifacts, plan.helm.ociArtifact, plan.helm.sourceSha, "Helm artifact");
      put(state.helm.gitTags, plan.helm.gitTag, plan.helm.sourceSha, "Helm git tag");
      put(
        state.helm.githubReleases,
        plan.helm.githubRelease,
        { targetSha: plan.helm.sourceSha, artifact: plan.helm.ociArtifact },
        "Helm GitHub Release"
      );
    })
  ) return { state, failedAfter: "helm" };

  if (
    !applyStep("releases", () => {
      const release = plan.releases.unified;
      put(state.releases.gitTags, release.gitTag, release.targetSha, "release git tag");
      put(
        state.releases.githubReleases,
        release.gitTag,
        { title: release.title, targetSha: release.targetSha, notesSha256: release.notes.deterministicInputSha256 },
        "GitHub Release"
      );
      put(
        state.releases.dockerTriggerTags,
        plan.releases.dockerTriggerTag,
        plan.request.publicSha,
        "Docker trigger tag"
      );
    })
  ) return { state, failedAfter: "releases" };

  if (
    !applyStep("docs", () => {
      put(state.docs.releaseTags, plan.docs.releaseTag, plan.docs.sourceSha, "docs release tag");
      put(state.docs.refs, plan.docs.targetRef, plan.docs.sourceSha, "docs ref");
    })
  ) return { state, failedAfter: "docs" };

  if (
    !applyStep("downstream", () => {
      for (const event of plan.downstreamDispatches) {
        const eventKey = `${event.repository}:${event.eventType}:${operationKey}`;
        put(
          state.downstream.events,
          eventKey,
          { payload: event.payload, ordering: event.ordering },
          "downstream event"
        );
      }
    })
  ) return { state, failedAfter: "downstream" };

  operation.status = "complete";
  return { state, failedAfter: null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.plan || !args.state) fail("--plan and --state are required");
  const plan = readJson(args.plan);
  const state = existsSync(args.state) ? readJson(args.state) : emptyState();
  const result = applyFakeRelease({ plan, state, failAfter: args.failAfter });
  writeState(args.state, result.state);
  if (result.failedAfter) {
    fail(`Injected local failure after ${result.failedAfter}`);
  }
  process.stdout.write(
    `${JSON.stringify({ idempotencyKey: plan.request.idempotencyKey, status: result.state.operations[plan.request.idempotencyKey].status, stateSha256: digest(result.state) })}\n`
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`fake release application failed: ${error.message}`);
    process.exit(1);
  });
}
