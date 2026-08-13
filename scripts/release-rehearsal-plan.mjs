#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const PUBLIC_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith("--")) fail(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (key === "verify-remote") {
      result.verifyRemote = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined) fail(`Missing value for --${key}`);
    result[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return result;
}

function gitEnvironment() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) return process.env;
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: gitEnvironment() }).trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function workspaceManifestPaths(root) {
  const workspacePatterns = readJson(join(root, "package.json")).workspaces;
  if (!Array.isArray(workspacePatterns)) fail("package.json workspaces must be an array");

  const paths = [];
  for (const pattern of workspacePatterns) {
    const match = pattern.match(/^([^*]+)\/\*$/);
    if (!match) fail(`Unsupported workspace pattern in rehearsal planner: ${pattern}`);
    const parent = join(root, match[1]);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(parent, entry.name, "package.json");
      if (existsSync(manifest)) paths.push(manifest);
    }
  }
  return paths.sort();
}

function extractVersionSection(changelog, version) {
  const lines = changelog.split("\n");
  const heading = `## ${version}`;
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^## \S/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const section = lines.slice(start + 1, end).join("\n").trim();
  return section || null;
}

function collectPackages(root, version) {
  const ignored = new Set(readJson(join(root, ".changeset", "config.json")).ignore ?? []);
  const packages = [];

  for (const manifestPath of workspaceManifestPaths(root)) {
    const manifest = readJson(manifestPath);
    const isReleasePackage =
      manifest.private !== true &&
      !ignored.has(manifest.name) &&
      (manifest.name === "trigger.dev" || manifest.name?.startsWith("@trigger.dev/"));
    if (!isReleasePackage) continue;
    if (manifest.version !== version) {
      fail(`${relative(root, manifestPath)} is ${manifest.version}, expected exact release version ${version}`);
    }

    const changelogPath = join(dirname(manifestPath), "CHANGELOG.md");
    if (!existsSync(changelogPath)) fail(`Missing changelog for ${manifest.name}`);
    const section = extractVersionSection(readFileSync(changelogPath, "utf8"), version);
    if (!section) fail(`Missing ${version} changelog section for ${manifest.name}`);

    packages.push({
      name: manifest.name,
      version,
      manifest: relative(root, manifestPath),
      npmTag: `${manifest.name}@${version}`,
      gitTag: `${manifest.name}@${version}`,
      changelog: {
        path: relative(root, changelogPath),
        sha256: sha256(section),
        content: section,
      },
    });
  }

  packages.sort((left, right) => left.name.localeCompare(right.name));
  if (packages.length === 0) fail("No releasable Trigger.dev packages found");
  return packages;
}

function collectDeletedServerChanges(root, publicSha) {
  let parent;
  try {
    parent = git(root, ["rev-parse", `${publicSha}^`]);
  } catch {
    return [];
  }

  let deleted;
  try {
    deleted = git(root, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "--diff-filter=D",
      parent,
      publicSha,
      "--",
      ".server-changes",
    ]);
  } catch {
    return [];
  }

  return deleted
    .split("\n")
    .filter((path) => path.endsWith(".md") && !path.endsWith("/README.md"))
    .sort()
    .map((path) => {
      const content = git(root, ["show", `${parent}:${path}`]);
      return { path, sourceCommit: parent, sha256: sha256(content), content };
    });
}

function parseChart(root, version) {
  const path = "hosting/k8s/helm/Chart.yaml";
  const chart = readFileSync(join(root, path), "utf8");
  const chartVersion = chart.match(/^version:\s*(\S+)$/m)?.[1];
  const appVersion = chart.match(/^appVersion:\s*(\S+)$/m)?.[1];
  const chartName = chart.match(/^name:\s*(\S+)$/m)?.[1];
  if (chartVersion !== version || appVersion !== `v${version}`) {
    fail(`${path} must have version ${version} and appVersion v${version}`);
  }
  if (!chartName) fail(`${path} has no chart name`);
  return { path, chartName, chartVersion, appVersion };
}

function verifySource({ root, publicSha, publicRef, remote }) {
  const head = git(root, ["rev-parse", "HEAD"]);
  if (head !== publicSha) fail(`Checked out HEAD ${head} does not equal supplied public SHA ${publicSha}`);
  git(root, ["cat-file", "-e", `${publicSha}^{commit}`]);

  const refResult = git(root, ["ls-remote", "--refs", remote, publicRef]);
  const matchingRef = refResult
    .split("\n")
    .filter(Boolean)
    .find((line) => line.endsWith(`\t${publicRef}`));
  if (!matchingRef) fail(`Supplied public ref ${publicRef} does not exist on ${remote}`);
  const refSha = matchingRef.split(/\s+/)[0];
  if (refSha !== publicSha) fail(`Supplied public ref resolves to ${refSha}, not ${publicSha}`);

  const mainResult = git(root, ["ls-remote", "--refs", remote, "refs/heads/main"]);
  const mainSha = mainResult.split(/\s+/)[0];
  if (!FULL_SHA.test(mainSha)) fail(`Could not resolve refs/heads/main on ${remote}`);
  git(root, ["cat-file", "-e", `${mainSha}^{commit}`]);
  try {
    git(root, ["merge-base", "--is-ancestor", publicSha, mainSha]);
  } catch {
    fail(`Supplied public SHA ${publicSha} is not reachable from public main ${mainSha}`);
  }
  return { head, refSha, mainSha, relationship: "ref-equals-sha-and-sha-is-on-main" };
}

export function relevantReleaseRefs(version, packages, publicRef) {
  return [
    "refs/heads/main",
    "refs/heads/docs-live",
    publicRef,
    `refs/tags/v${version}`,
    `refs/tags/v.docker.${version}`,
    `refs/tags/helm-v${version}`,
    ...packages.map((pkg) => `refs/tags/${pkg.gitTag}`),
  ].filter((value, index, all) => all.indexOf(value) === index).sort();
}

export function buildPlan(options) {
  const root = resolve(options.root ?? ".");
  const { version, publicSha, publicRef, mode, idempotencyKey, repository } = options;
  if (!STABLE_VERSION.test(version ?? "")) fail(`Invalid exact stable version: ${version ?? ""}`);
  if (!FULL_SHA.test(publicSha ?? "")) fail("public-sha must be a full lowercase 40-character SHA");
  if (!PUBLIC_REF.test(publicRef ?? "") || publicRef.includes("..") || publicRef.endsWith("/")) {
    fail(`Invalid public ref: ${publicRef ?? ""}`);
  }
  if (mode !== "stable") fail(`Only stable mode is accepted, received: ${mode ?? ""}`);
  if (idempotencyKey !== `${version}:${publicSha}`) {
    fail(`idempotency-key must be exactly ${version}:${publicSha}`);
  }
  if (!REPOSITORY.test(repository ?? "")) fail(`Invalid repository: ${repository ?? ""}`);

  const collectedPackages = collectPackages(root, version);
  const packages = collectedPackages.map((pkg) => ({
    ...pkg,
    changelog: { path: pkg.changelog.path, sha256: pkg.changelog.sha256 },
  }));
  const chart = parseChart(root, version);
  const serverChanges = collectDeletedServerChanges(root, publicSha);
  const repositoryOwner = repository.split("/")[0];
  const repositoryName = repository.split("/")[1];
  const major = version.split(".")[0];
  const commitDate = git(root, ["show", "-s", "--format=%cI", publicSha]).slice(0, 10);
  const verification = options.verifyRemote
    ? verifySource({ root, publicSha, publicRef, remote: options.remote ?? "origin" })
    : {
        head: git(root, ["rev-parse", "HEAD"]),
        relationship: "remote-verification-not-requested",
      };

  if (verification.head !== publicSha) {
    fail(`Checked out HEAD ${verification.head} does not equal supplied public SHA ${publicSha}`);
  }

  const releaseNoteSources = collectedPackages.map((pkg) => ({
    package: pkg.name,
    ...pkg.changelog,
  }));
  const noteLines = [`# trigger.dev v${version}`, "", "## Package changelog deltas", ""];
  for (const source of releaseNoteSources) {
    noteLines.push(`### ${source.package}`, "", source.content, "");
  }
  if (serverChanges.length) {
    noteLines.push("## Server changes from the release parent", "");
    for (const change of serverChanges) {
      noteLines.push(`### ${change.path}`, "", change.content, "");
    }
  }
  const releaseNotesPreview = `${noteLines.join("\n").trim()}\n`;
  const releaseNotesDigest = sha256(releaseNotesPreview);
  const releaseNotePlanSources = releaseNoteSources.map(({ content, ...source }) => source);
  const serverChangePlanSources = serverChanges.map(({ content, ...source }) => source);

  const refs = relevantReleaseRefs(version, packages, publicRef);
  return {
    schemaVersion: 1,
    kind: "fake-stable-release-rehearsal",
    safety: {
      localOnly: true,
      mutationsPerformed: false,
      publishingWorkflowsCalled: false,
      optionalBuildsExecuted: false,
    },
    request: { version, publicSha, publicRef, mode, idempotencyKey, repository },
    sourceVerification: verification,
    packageRelease: {
      distTag: "latest",
      packages,
      aggregateTag: `v${version}`,
    },
    images: [
      {
        component: "webapp",
        repository: `ghcr.io/${repositoryOwner}/${repositoryName}`,
        tags: [`v${version}`, `v${major}`, "latest"],
        sourceSha: publicSha,
      },
      {
        component: "supervisor",
        repository: `ghcr.io/${repositoryOwner}/supervisor`,
        tags: [`v${version}`, `v${major}`, "latest"],
        sourceSha: publicSha,
      },
    ],
    helm: {
      ...chart,
      ociArtifact: `oci://ghcr.io/${repositoryOwner}/charts/${chart.chartName}:${version}`,
      gitTag: `helm-v${version}`,
      githubRelease: `helm-v${version}`,
      sourceSha: publicSha,
    },
    releases: {
      unified: {
        gitTag: `v${version}`,
        title: `trigger.dev v${version}`,
        targetSha: publicSha,
        notes: {
          packageChangelogs: releaseNoteSources,
          deletedServerChangesFromReleaseParent: serverChanges,
          deterministicInputSha256: releaseNotesDigest,
        },
      },
      dockerTriggerTag: `v.docker.${version}`,
    },
    docs: {
      releaseTag: `docs-release-${commitDate}`,
      sourceSha: publicSha,
      targetRef: "refs/heads/docs-live",
      operation: "would-fast-forward-after-release",
    },
    downstreamDispatches: [
      {
        repository: "triggerdotdev/trigger.dev-site-v3",
        eventType: "new-release",
        payload: { version, publicSha, idempotencyKey },
        ordering: "last",
      },
    ],
    proofScope: {
      refs,
      githubReleases: [`v${version}`, `helm-v${version}`],
    },
    checks: {
      required: [
        "input-and-ref-verification",
        "publication-workflow-static-contracts",
        "rehearsal-denylist",
        "deterministic-plan",
        "before-after-ref-and-release-snapshot",
        "clean-working-tree",
      ],
      optionalNotRun: ["package-packing", "container-builds", "helm-dependency-build-and-package"],
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildPlan({
    root: args.root,
    version: args.version,
    publicSha: args.publicSha,
    publicRef: args.publicRef,
    mode: args.mode,
    idempotencyKey: args.idempotencyKey,
    repository: args.repository,
    remote: args.remote,
    verifyRemote: args.verifyRemote,
  });
  const rendered = `${JSON.stringify(plan, null, 2)}\n`;
  if (args.output) writeFileSync(args.output, rendered);
  else process.stdout.write(rendered);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`release rehearsal planning failed: ${error.message}`);
    process.exit(1);
  });
}
