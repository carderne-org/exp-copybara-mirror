#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workflowUseRules = [
  [/(?:^|\s)uses:\s*\.\/\.github\/workflows\//m, "local reusable workflow call"],
  [/uses:\s*docker\/login-action@/m, "container registry login action"],
  [/uses:\s*.*repository-dispatch@/m, "cross-repository dispatch action"],
  [/uses:\s*softprops\/action-gh-release@/m, "GitHub Release action"],
  [/uses:\s*actions\/attest-/m, "attestation action"],
  [/uses:\s*.*build-push-action@/m, "container build-and-upload action"],
  [/uses:\s*changesets\/action@/m, "Changesets publication action"],
];

const commandRules = [
  [/(?:^|[;&|]\s*)\s*git\s+(?:-\S+\s+)*push\b/m, "remote git ref write"],
  [/(?:^|[;&|]\s*)\s*git\s+(?:-\S+\s+)*(?:tag\b|update-ref\s+refs\/tags\/)/m, "git tag creation"],
  [/(?:^|[;&|]\s*)\s*(?:(?:npm|pnpm)\s+(?:exec\s+)?publish|(?:npm|pnpm|npx)\s+(?:exec\s+)?changeset\s+publish|(?:npm|pnpm)\s+run\s+changeset:release|yarn\s+npm\s+publish)\b/m, "npm publication"],
  [/(?:^|[;&|]\s*)\s*(?:docker\s+(?:push|login)|helm\s+(?:push|registry\s+login)|oras\s+(?:push|login))\b/m, "registry write or login"],
  [/(?:^|[;&|]\s*)\s*(?:docker\s+buildx\s+build|depot\s+build)[\s\S]*?--push\b/m, "container upload build"],
  [/(?:^|[;&|]\s*)\s*gh\s+release\s+(?:create|edit|delete|upload)\b/m, "GitHub Release mutation"],
  [/(?:^|[;&|]\s*)\s*gh\s+workflow\s+run\b/m, "remote workflow invocation"],
  [/gh\s+api[\s\S]*?(?:-X|--method)\s+(?:POST|PUT|PATCH|DELETE)\b/m, "mutating GitHub API request"],
  [/git\s+update-ref[\s\S]*refs\/heads\/docs-live\b/m, "docs ref mutation"],
  [/repos\/[^\s]+\/dispatches\b/m, "repository dispatch endpoint"],
];

const childProcessRules = [
  /(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*["'](?:git|npm|pnpm|docker|helm|oras|gh)["']\s*,\s*\[[\s\S]*?["'](?:push|tag|publish|login|create|edit|delete|upload|run)["']/m,
  /(?:execSync|exec)\s*\(\s*["'`][\s\S]*?\b(?:git\s+(?:push|tag)|npm\s+publish|docker\s+(?:push|login)|helm\s+push|gh\s+release\s+create)\b/m,
];

function workflowRunBlocks(source) {
  const lines = source.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!match) continue;
    const indentation = match[1].length;
    if (match[2] && match[2] !== "|") {
      blocks.push(match[2]);
      continue;
    }
    const content = [];
    for (index += 1; index < lines.length; index++) {
      const next = lines[index];
      if (next.trim() && next.match(/^\s*/)[0].length <= indentation) {
        index -= 1;
        break;
      }
      content.push(next.slice(indentation + 2));
    }
    blocks.push(content.join("\n"));
  }
  return blocks;
}

export function scanFile(path) {
  const source = readFileSync(path, "utf8");
  const failures = [];
  if (/\.ya?ml$/.test(path)) {
    for (const [rule, label] of workflowUseRules) {
      if (rule.test(source)) failures.push(`${path}: ${label}`);
    }
    for (const block of workflowRunBlocks(source)) {
      for (const [rule, label] of commandRules) {
        if (rule.test(block)) failures.push(`${path}: ${label}`);
      }
    }
  } else {
    if (childProcessRules.some((rule) => rule.test(source))) {
      failures.push(`${path}: forbidden child-process command`);
    }
  }
  return failures;
}

export function rehearsalFiles(root) {
  const files = [];
  const publicRoot = existsSync(join(root, "oss", "package.json")) ? join(root, "oss") : root;
  const workflowCandidates = [
    join(root, ".github", "workflows", "release-rehearsal.yml"),
    join(publicRoot, ".github", "workflows", "release-rehearsal.yml"),
  ];
  for (const candidate of workflowCandidates) {
    if (existsSync(candidate) && !files.includes(candidate)) files.push(candidate);
  }

  const scriptsDirectory = join(publicRoot, "scripts");
  for (const name of readdirSync(scriptsDirectory).sort()) {
    if (
      (name.startsWith("release-rehearsal-") || name === "scan-release-rehearsal-safety.mjs" ||
        name === "validate-release-rehearsal.mjs") &&
      !name.includes(".test.")
    ) {
      files.push(join(scriptsDirectory, name));
    }
  }
  return files;
}

export function scanRehearsal(root) {
  const files = rehearsalFiles(resolve(root));
  if (files.length < 2) throw new Error(`No complete rehearsal surface found under ${root}`);
  const failures = files.flatMap(scanFile);
  if (failures.length) throw new Error(`Unsafe rehearsal content found:\n${failures.join("\n")}`);
  return files;
}

function main() {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex === -1 ? "." : process.argv[rootIndex + 1];
  if (!root) throw new Error("--root requires a value");
  const files = scanRehearsal(root);
  console.log(`Safety denylist passed for ${files.length} rehearsal workflow/script files.`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
