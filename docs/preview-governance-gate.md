# Preview Governance Gate

`preview/gate` is the aggregate preview status intended for branch protection.
It classifies every pull-request head from trusted base code and reconciles the
applicable preview evidence. Subordinate contexts are evidence inputs, not
independent required checks.

## Trust Model

The `pull_request_target` workflow checks out only the exact base SHA. It never
checks out, imports, or executes PR-head code. A scoped GitHub App installation
token permits repository reads and status writes; the workflow's built-in token
does not publish the gate.

The initializer re-reads the canonical open, same-repository `main` PR, its
exact head SHA, and complete changed-file list. It classifies those paths with
the service catalog from the trusted base checkout:

| Classification                                          | `preview/gate`                    | Evidence                                     |
| ------------------------------------------------------- | --------------------------------- | -------------------------------------------- |
| No catalog-backed runtime change                        | `success`                         | none required                                |
| Fully mapped runtime change                             | `pending` until evidence resolves | applicable contexts start pending            |
| Unsupported path, invalid catalog, fork, or stale tuple | `failure` or `error`              | cannot be overridden by subordinate evidence |

The catalog owns ignored documentation/metadata prefixes, unsupported
governance prefixes, runtime subjects, and the fail-closed default. A mixed PR
cannot use valid runtime evidence to authorize a trust-root change.

## Evidence Contexts

- `preview/immutable-acceptance` proves exact-head service images were replayed
  in an immutable throwaway preview, verified, and fully cleaned up.
- `preview/activation-images` proves required host activation artifacts were
  built by the purpose-specific hub profile from the exact head and returned
  expected immutable image references.

Before terminal publication, the physical broker re-reads repository, PR,
base, head, changed paths, catalog digest, and applicable service subjects.
Terminal evidence binds that tuple, state, description, and durable receipt in
a broker-attested target. Force-pushed or catalog-skewed evidence cannot satisfy
the new head.

Activation requests contain only request ID, catalog digest, and canonical PR
tuple. The physical broker derives paths, subjects, build profile, image names,
and status context. Production dispatch uses the purpose-specific
`PREVIEW_GOVERNANCE_DISPATCH_TOKEN`; broad internal, preview-action, and broker
credentials are rejected at that ingress.

## Protected Trust Root

Changes to these areas are deliberately unsupported on their own PR-head
authority:

- Actions workflows and reusable actions;
- gate classifier and GitHub adapter;
- service catalog and path policy;
- attestation, receipt, and status publication code;
- CODEOWNERS and branch-protection bootstrap;
- physical preview-control broker wiring.

Keep a trust-root change isolated, run the base-owned tests, record the exact
head and reason, and use the documented administrator bypass only when the
repository's approval policy makes normal review impossible. Immediately rerun
the documentation-only and mapped-runtime canaries plus the governance audit.
Never expose the GitHub App private key to PR-head code or relax the trusted-base
checkout to make a feature mergeable.

## Branch Protection

Do not require `preview/gate` until the trusted workflow is present on default
branches and can publish a successful documentation-only canary in both
repositories.

The idempotent audit, secret installation, canary creation, and protection
commands are owned by the
[stacks governance runbook](https://github.com/PittampalliOrg/stacks/blob/main/docs/preview-governance-gate.md).
That adapter preserves existing required checks and App bindings, adds only the
App-bound aggregate gate, and verifies the resulting state. It also keeps the
subordinate contexts out of branch protection.

GitHub cannot update two repositories transactionally. After any partial
failure, repair the cause and rerun the same idempotent stacks command, then
require its final audit to report ready.

## Delivery Boundary

The mutable preview loop owns source experimentation and evidence; it does not
write shared deployment state. A pull request plus immutable acceptance is the
handoff into the existing outer loop.

The broker may persist an attested, content-addressed image receipt before
merge. The outer loop may reuse that digest only when the merged tree,
catalog-derived subjects, tag, and immutable GHCR reference still match.
Otherwise it rebuilds. Release pins, Source Hydrator, GitOps Promoter, and
ArgoCD remain the only shared delivery authority.

`preview/gate` is merge evidence, not another promotion stage. Per-preview Git
servers are intentionally absent; mutable source stays in the scoped workspace
and durable source stays in GitHub.

## Validation

Run the repository-owned classifier and boundary checks:

```bash
node --test scripts/governance/preview-gate.node-test.mjs
pnpm check:boundaries:ratchet
pnpm check
```

For a live canary, prove:

1. a documentation-only same-repository PR receives aggregate success with no
   subordinate requirements;
2. a mapped runtime PR remains pending until all applicable attested evidence
   succeeds;
3. an unsupported trust-root path fails before PR-head code executes;
4. a force-push invalidates evidence from the previous head;
5. branch protection requires only the aggregate App-bound context in addition
   to the repository's existing checks.

The executable domain constants are in
`scripts/governance/preview-gate-domain.mjs`; the trusted workflow is
`.github/workflows/preview-governance-gate.yml`.
