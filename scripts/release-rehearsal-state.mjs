#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail(`Invalid argument near ${key ?? "end"}`);
    options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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

async function readRelease(repository, tag) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    { headers }
  );
  if (response.status === 404) return null;
  if (!response.ok) fail(`GitHub release read failed for ${tag}: HTTP ${response.status}`);
  const release = await response.json();
  return {
    id: release.id,
    tagName: release.tag_name,
    targetCommitish: release.target_commitish,
    name: release.name,
    draft: release.draft,
    prerelease: release.prerelease,
  };
}

export async function captureState({ repository, plan }) {
  if (repository !== plan.request.repository) {
    fail(`Snapshot repository ${repository} differs from plan repository ${plan.request.repository}`);
  }
  const remote = `https://github.com/${repository}.git`;
  const output = execFileSync("git", ["ls-remote", "--refs", remote, ...plan.proofScope.refs], {
    encoding: "utf8",
    env: gitEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
  });
  const refs = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/);
        return [ref, sha];
      })
      .sort(([left], [right]) => left.localeCompare(right))
  );

  const releaseEntries = await Promise.all(
    plan.proofScope.githubReleases.map(async (tag) => [tag, await readRelease(repository, tag)])
  );
  return {
    schemaVersion: 1,
    repository,
    refs,
    releases: Object.fromEntries(releaseEntries.sort(([left], [right]) => left.localeCompare(right))),
  };
}

export function assertStateUnchanged(before, after) {
  const left = JSON.stringify(before);
  const right = JSON.stringify(after);
  if (left !== right) {
    fail(`Remote refs or releases changed during rehearsal\nbefore=${left}\nafter=${right}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "capture") {
    if (!args.plan || !args.repository || !args.output) {
      fail("capture requires --plan, --repository and --output");
    }
    const state = await captureState({ repository: args.repository, plan: readJson(args.plan) });
    writeFileSync(args.output, `${JSON.stringify(state, null, 2)}\n`);
    return;
  }
  if (args.command === "compare") {
    if (!args.before || !args.after) fail("compare requires --before and --after");
    assertStateUnchanged(readJson(args.before), readJson(args.after));
    console.log("Remote release refs and GitHub Releases are unchanged.");
    return;
  }
  fail(`Expected capture or compare command, received ${args.command ?? "nothing"}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`release rehearsal state proof failed: ${error.message}`);
    process.exit(1);
  });
}
