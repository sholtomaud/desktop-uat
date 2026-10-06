# cdktn: desktop UAT as Terraform

The same deployment as [`infra/`](../infra/), written with
[CDK Terrain](https://cdktn.io) (cdktn, the community fork of CDKTF) and committed
as plain HCL in [`terraform/`](terraform/). Terraform and OpenTofu users can read,
review and apply `terraform/<stack>/main.tf` without Node or cdktn.

**Do not edit `terraform/` by hand.** It is generated from `lib/`, and `make check`
fails if the two disagree.

## What is in it

One root module per environment: `terraform/desktop-uat-<env>/`, today `-prod`.
It holds `infra/`'s three stacks as one state:

| Construct | Resources prefix | What |
|---|---|---|
| [`lib/network.ts`](lib/network.ts) | `network_` | VPC; public (NAT only), runners (NAT egress) and fleet (no route out) tiers; S3 gateway and interface endpoints; flow logs |
| [`lib/desktop.ts`](lib/desktop.ts) | `desktop_` | KMS key, evidence/builds/access-log buckets, the AppStream fleet and agent-access stack, SSM discovery parameters, the fleet janitor Lambda |
| [`lib/runners.ts`](lib/runners.ts) | `runners_` | GHES runner role, launch template (with the boot script as `local.runners_user_data`) and autoscaling group |

The settings are `infra/`'s: the `uat` context in
[`infra/cdk.json`](../infra/cdk.json), checked by `infra/`'s own loader, and the AZs
in [`infra/cdk.context.json`](../infra/cdk.context.json). Change them there.

Providers: `hashicorp/aws` for everything except the AppStream stack, which is
`hashicorp/awscc`. Only awscc has `agent_access_config`. `hashicorp/archive` packs
the janitor's inline code at plan time.

## Working on it

Everything runs in the dev container, through `make`:

```sh
make cdktn-test        # jest: constructs, contracts with the harness/scripts, janitor, HCL snapshot
make cdktn-snapshots   # after an intended change: rewrite the HCL snapshot (read the diff)
make cdktn-synth       # regenerate terraform/ (formatted with tofu fmt); commit it
make tofu-validate     # tofu validate against the real provider schemas
make tofu-lock         # after a provider version changes; commit .terraform.lock.hcl
```

Test first: the tests in [`test/`](test/) synthesize the stack and assert on it. The
contract tests read the harness, the scripts and the workflow, and fail if this
configuration stops providing what they use (see [AGENTS.md §6](../AGENTS.md#6-the-contracts-between-the-parts)).

## State

Nothing is applied yet, so the backend is `local` (`terraform.tfstate` beside
`main.tf`, ignored by git). When it is applied for real, state will live in
Artifactory, which serves a Terraform backend. That will be a change to the
`LocalBackend` in [`lib/uat-stack.ts`](lib/uat-stack.ts).

The lock files are OpenTofu's (`registry.opentofu.org/...`). Running `terraform
init` adds entries for `registry.terraform.io`, which is harmless.

## cdktn's HCL renderer

cdktn 0.24 writes three things wrongly in HCL (JSON output is unaffected).
[`lib/hcl.ts`](lib/hcl.ts) works around each one, `test/hcl.test.ts` pins the
workarounds, and `tofu validate` checks the result:

- awscc's nested attributes come out as blocks (`agent_access_config { }`); awscc
  needs `agent_access_config = { }`.
- `depends_on` and `ignore_changes` entries come out quoted, which Terraform has
  deprecated.
- Multi-line locals come out as quoted strings with raw newlines in them, which is
  not valid HCL. They are rewritten as heredocs.

Multi-line strings are written verbatim into `<<EOF` heredocs. A line reading `EOF`,
a `${` or a `%{` would change what is deployed, so `heredocSafe` refuses those at
synth time.
