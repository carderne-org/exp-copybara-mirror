# Fake stable release rehearsal

`.github/workflows/release-rehearsal.yml` is a deliberately read-only stable release rehearsal. It validates an exact public SHA/ref pair, creates a deterministic local plan, fake-publishes every channel into local state with an injected failure and retry, checks static contracts around the real release workflows, and proves that relevant refs and GitHub Releases did not change.

It cannot publish packages, images, charts, docs, releases, tags, attestations, or downstream events. It has only `contents: read`, does not use secrets or environments, and never calls a reusable publication workflow.

## Safe invocation

Set `REHEARSAL_ENABLE_RELEASE_REHEARSAL=true`. Choose a version already present in all releasable package manifests and `hosting/k8s/helm/Chart.yaml`. The branch ref must resolve exactly to the supplied SHA and the SHA must be on public `main`. Reset the gate to `false` after testing.

```bash
PUBLIC_SHA="$(gh api repos/carderne-org/exp-super-mirror/git/ref/heads/main --jq .object.sha)"
VERSION="$(gh api "repos/carderne-org/exp-super-mirror/contents/packages/cli-v3/package.json?ref=$PUBLIC_SHA" --jq .content | base64 --decode | jq -r .version)"

gh workflow run release-rehearsal.yml \
  --repo carderne-org/exp-super-mirror \
  --ref main \
  -f version="$VERSION" \
  -f public_sha="$PUBLIC_SHA" \
  -f public_ref=refs/heads/main \
  -f mode=stable \
  -f idempotency_key="$VERSION:$PUBLIC_SHA"
```

This creates an Actions run only. The run does not modify repository state.

## Local checks

From the public repository root at the exact SHA:

```bash
node scripts/scan-release-rehearsal-safety.mjs --root .
node scripts/validate-release-rehearsal.mjs --root .
node --test scripts/release-rehearsal.test.mjs
node scripts/release-rehearsal-plan.mjs \
  --root . \
  --version "$VERSION" \
  --public-sha "$PUBLIC_SHA" \
  --public-ref refs/heads/main \
  --mode stable \
  --idempotency-key "$VERSION:$PUBLIC_SHA" \
  --repository carderne-org/exp-super-mirror \
  --remote origin \
  --verify-remote
```

## Coverage and gaps

The plan and local fake state cover package versions and Changesets-style tags, release/image tags, image repository names, Helm chart and OCI identity, release-note source digests, docs ref intent, downstream event payloads, interrupted-run resumption, and byte-for-byte idempotent retries. Package packing, image builds, Helm dependency/build/package checks, trusted publication, real registry conflict checks, attestations, downstream receiver execution, and docs rendering are intentionally not executed.
