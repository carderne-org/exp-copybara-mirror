import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildPlan } from "./release-rehearsal-plan.mjs";
import { assertStateUnchanged } from "./release-rehearsal-state.mjs";
import { scanFile, scanRehearsal } from "./scan-release-rehearsal-safety.mjs";
import { validatePublicationContracts, validateWorkflowSafety } from "./validate-release-rehearsal.mjs";

const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const monoRoot = resolve(publicRoot, "..");
const publicSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: publicRoot, encoding: "utf8" }).trim();
const version = JSON.parse(readFileSync(join(publicRoot, "packages/cli-v3/package.json"), "utf8")).version;
const options = {
  root: publicRoot,
  version,
  publicSha,
  publicRef: "refs/heads/main",
  mode: "stable",
  idempotencyKey: `${version}:${publicSha}`,
  repository: "carderne-org/exp-super-mirror",
};

test("builds a deterministic and realistic stable release plan", () => {
  const first = buildPlan(options);
  const second = buildPlan(options);
  assert.deepEqual(first, second);
  assert.equal(first.safety.mutationsPerformed, false);
  assert.ok(first.packageRelease.packages.length >= 5);
  assert.ok(first.packageRelease.packages.every((pkg) => pkg.version === version));
  assert.ok(first.packageRelease.packages.some((pkg) => pkg.name === "trigger.dev"));
  assert.deepEqual(first.images.map((image) => image.component), ["webapp", "supervisor"]);
  assert.equal(first.helm.chartVersion, version);
  assert.equal(first.helm.appVersion, `v${version}`);
  assert.equal(first.releases.unified.targetSha, publicSha);
  assert.match(first.releases.unified.notes.deterministicInputSha256, /^[0-9a-f]{64}$/);
  assert.ok(first.proofScope.refs.includes(`refs/tags/v${version}`));

  const rendered = JSON.stringify(first);
  for (const unsafeCommand of ["npm publish", "git push", "git tag", "helm push", "gh release create"]) {
    assert.equal(rendered.includes(unsafeCommand), false);
  }
});

test("rejects anything except the exact stable request identity", () => {
  assert.throws(() => buildPlan({ ...options, version: `${version}-rc.1` }), /Invalid exact stable version/);
  assert.throws(() => buildPlan({ ...options, mode: "prerelease" }), /Only stable mode/);
  assert.throws(() => buildPlan({ ...options, idempotencyKey: "retry-me" }), /must be exactly/);
  assert.throws(() => buildPlan({ ...options, publicSha: publicSha.slice(0, 12) }), /full lowercase/);
  assert.throws(() => buildPlan({ ...options, publicRef: "main" }), /Invalid public ref/);
});

test("state proof compares all captured refs and releases", () => {
  const state = {
    schemaVersion: 1,
    repository: options.repository,
    refs: { "refs/heads/main": publicSha },
    releases: { [`v${version}`]: null },
  };
  assert.doesNotThrow(() => assertStateUnchanged(state, structuredClone(state)));
  const changed = structuredClone(state);
  changed.refs["refs/heads/main"] = "0".repeat(40);
  assert.throws(() => assertStateUnchanged(state, changed), /changed during rehearsal/);
});

test("denylist catches release mutation commands", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-rehearsal-denylist-"));
  const workflow = join(directory, "unsafe.yml");
  writeFileSync(
    workflow,
    "jobs:\n  unsafe:\n    steps:\n      - run: |\n          git push origin HEAD:refs/heads/main\n"
  );
  assert.match(scanFile(workflow).join("\n"), /remote git ref write/);
});

test("real rehearsal files pass the denylist and static contracts", () => {
  assert.doesNotThrow(() => scanRehearsal(monoRoot));
  assert.doesNotThrow(() =>
    validateWorkflowSafety(join(publicRoot, ".github/workflows/release-rehearsal.yml"))
  );
  assert.doesNotThrow(() => validatePublicationContracts(publicRoot));
});
