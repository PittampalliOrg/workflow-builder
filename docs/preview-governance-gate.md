# Preview governance gate

`preview/gate` is the only preview status that branch protection should require.
It is emitted for every pull request head, including changes for which preview
evidence is not applicable. Subordinate contexts are evidence inputs, not
separate merge requirements.

## Trust model

The always-on `pull_request_target` workflow checks out only the exact base SHA.
It never checks out, imports, or executes PR-head code. It obtains a short-lived
installation token for GitHub App `2970091`, restricted to the
`workflow-builder` repository and `contents:read`, `pull_requests:read`, and
`statuses:write`. The workflow's built-in token has no status-write permission.

The initializer re-reads the open, same-repository `main` PR and its complete
changed-file list. It then reads the schema-v3 service catalog from the trusted
base checkout and publishes one of these states on the exact head:

| Classification                           | Aggregate            | Subordinate evidence              |
| ---------------------------------------- | -------------------- | --------------------------------- |
| No catalog-backed runtime change         | `success`            | none                              |
| Fully mapped runtime change              | `pending`            | required contexts start `pending` |
| Unmapped runtime path or invalid catalog | `failure` or `error` | none can bypass it                |

Fork PRs fail closed. This lane runs trusted development dependencies and does
not provide an untrusted-source sandbox.

The catalog also owns the changed-path policy used by both the initializer and
physical reconciler. It lists narrow documentation/repository metadata prefixes
that are ignored, privileged governance prefixes that are unsupported, and an
`unsupported` default for every unmatched path. The same exact-base policy is
therefore applied before and after subordinate evidence; a mixed runtime and
governance PR cannot turn an initializer failure into aggregate success.

## Evidence contexts

- `preview/immutable-acceptance` proves that catalog-derived services were
  built from the exact PR head, replayed in a throwaway vCluster, verified as a
  functioning system, and cleaned up with proof.
- `preview/activation-images` proves that catalog-derived host activation
  artifacts were built by the purpose-specific hub Tekton profile from the
  exact PR head and returned the expected `:git-<full-sha>` image plus digest.

The physical broker re-reads the PR tuple immediately before every terminal
publication. Terminal subordinate statuses carry an HMAC attestation in their
target URL binding repository, PR number, base SHA, head SHA, context, state,
description, exact-base catalog digest, canonical subject set, and durable
evidence receipt. The receipt itself has a purpose-derived broker HMAC, so a
database writer cannot manufacture provenance. New and resumed receipts are
verified before a terminal status is signed; aggregate reconciliation and
post-merge image reuse verify the HMAC again. The reconciler ignores legacy v1
or otherwise unbound terminal evidence, fetches and recomputes the schema-v3
catalog digest at the exact PR base SHA, and refuses evidence unless that digest
equals the deployed catalog. It derives the complete context and subject union
again from current PR paths and succeeds only when every applicable subordinate
succeeds. A force-push or catalog version skew leaves old evidence unusable.

The activation command is available only on the physical broker at
`POST /api/internal/preview-control/activation-images`. Its body contains only
`requestId`, `catalogDigest`, and the exact PR tuple. Artifacts, changed paths,
build profile, image name, and status context are server-derived.

## Branch protection bootstrap

Do not add a required check before the workflow exists on the default branch.

### Current deployment blockers

The repository settings are not yet the architecture described here. Live
inspection on 2026-07-10 found `checks` and `orchestrator-tests` required on
`main`, strict up-to-date enforcement disabled, and no repository ruleset. The
`PREVIEW_CONTROL_GITHUB_APP_PRIVATE_KEY` Actions secret returned 404 and is
absent; expected App source binding and required code-owner review are also not
configured. `@vpittamp` does resolve to a repository admin and is eligible for
CODEOWNERS. Until the missing controls are installed and proven, the governance
gate is implemented code, not an operational merge guarantee.

Bootstrap is deliberately ordered so no secret or branch-setting mutation occurs
until both repositories have their trusted workflow, CODEOWNERS, gate code, and
tests on remote `main`. Merge one isolated bootstrap PR per repository under the
rules already present, update a stacks checkout, and use its idempotent GitHub
adapter:

```bash
cd /home/vpittamp/repos/PittampalliOrg/stacks/main
git fetch origin main

# Read-only. Exit 2 is expected until secrets and protection are installed.
node scripts/gitops/preview-governance-bootstrap.mjs audit --json \
  | tee /tmp/preview-governance-preflight.json

KEY_FILE=/run/user/$UID/preview-control-github-app.pem
KEY_MODE="$(stat -c '%a' "$KEY_FILE")"
(( (8#$KEY_MODE & 8#077) == 0 ))
node scripts/gitops/preview-governance-bootstrap.mjs install-secrets \
  --private-key-file "$KEY_FILE" --json
node scripts/gitops/preview-governance-bootstrap.mjs install-secrets \
  --private-key-file "$KEY_FILE" --apply --json
shred -u "$KEY_FILE"
```

Use the idempotent `create_preview_governance_canary` helper in the stacks
`docs/preview-governance-gate.md` to open one same-repository documentation-only
PR from the current `main` in each repository. After App `2970091` emits the
exact N/A success on both exact heads, use the returned numbers to install
protection:

```bash
WFB_CANARY_PR=<workflow-builder-docs-pr>
STACKS_CANARY_PR=<stacks-docs-pr>

node scripts/gitops/preview-governance-bootstrap.mjs protect \
  --workflow-builder-canary-pr "$WFB_CANARY_PR" \
  --stacks-canary-pr "$STACKS_CANARY_PR" --json
node scripts/gitops/preview-governance-bootstrap.mjs protect \
  --workflow-builder-canary-pr "$WFB_CANARY_PR" \
  --stacks-canary-pr "$STACKS_CANARY_PR" --apply --json
node scripts/gitops/preview-governance-bootstrap.mjs audit --json
```

The adapter retains `checks`, `orchestrator-tests`, and every other required
context with its current App binding; adds only `preview/gate` bound to App
`2970091`; enables strict up-to-date checks; requires one approval plus
code-owner review; dismisses stale reviews; and requires approval after the last
push. Subordinate preview contexts remain evidence, not direct requirements.
GitHub documents code-owner review as independently requiring an owner approval
even when the general approval count is zero, so zero would still deadlock an
owner-authored CODEOWNERS change. `enforce_admins` is deliberately disabled as
the solo-maintainer escape; the audit fails unless `vpittamp` remains the only
repository administrator. A merge queue is unsupported because the workflow has
no `merge_group` trigger.

The GitHub API cannot update two repositories transactionally. If one write
succeeds before a transport failure, fix the error and rerun the same idempotent
command. The adapter re-reads both remote `main` SHAs, trusted artifacts,
administrators, secrets, canaries, and existing checks before mutation and
verifies both repositories afterward. Do not merge the broader architecture PR
until the final audit reports ready.

### Governance changes after bootstrap

The base classifier intentionally reports changes to any Actions workflow or
reusable action, the gate classifier, catalog, HMAC receipt/status code,
CODEOWNERS, and physical broker wiring as unsupported. A PR head cannot
authorize a change to its own trust root or add a workflow that reads the
repository-level App key.

For an administrator-authored PR that cannot obtain an independent approval,
the administrator is the explicit human trust root. Keep the change isolated,
run the base-owned tests, and record the exact head and reason before using the
GitHub administrator bypass:

```bash
REPOSITORY=PittampalliOrg/workflow-builder
PR=<pull-request-number>
HEAD_SHA="$(gh pr view "$PR" --repo "$REPOSITORY" --json headRefOid --jq .headRefOid)"
gh pr comment "$PR" --repo "$REPOSITORY" --body \
  "PREVIEW-GOVERNANCE-ADMIN-BYPASS head=${HEAD_SHA} reason=<reason>"
gh pr merge "$PR" --repo "$REPOSITORY" --admin --merge
```

The comment, immutable head, merge actor, and PR timeline are the bypass audit
record. Immediately rerun the documentation-only and mapped-runtime canaries and
the stacks bootstrap audit. Never expose the App private key to PR-head code,
relax the trusted-base checkout, or remove the App-bound gate to merge a feature.

## Delivery boundary

The mutable inner loop uses isolated workspaces and authenticated live sync; it
does not own deployment state. A pull request and immutable acceptance are the
handoff into shared GitOps. Before terminal subordinate success, the physical
broker persists a content-addressed, purpose-HMAC-attested image receipt. After
merge, the existing outer loop may reuse that exact digest only when the merged
tree and catalog-derived path subjects remain identical and GHCR still resolves
the recorded tag and immutable ref. Otherwise it rebuilds. In both cases the
release-pin, Source Hydrator, GitOps Promoter, and ArgoCD path remains
authoritative for dev and staging. `preview/gate` is evidence for merging, not
another Promoter stage.

A Gitea instance per vCluster is therefore unnecessary and undesirable. It
would duplicate source authority, require credential and backup lifecycle in
every ephemeral environment, and make tested commits difficult to relate to the
GitHub PR and Promoter history. Mutable source belongs in the agent workspace;
reconciled candidate state belongs at an immutable GitHub PR SHA.

## Validation

```bash
node --test scripts/governance/preview-gate.node-test.mjs
pnpm check:boundaries:ratchet
pnpm check
```

The ratchet compares exact dependency-cruiser violation identities with the
committed `main` baseline. New or changed violations fail CI; removed legacy
debt is reported and passes. `pnpm check:boundaries` remains the raw debt audit.
