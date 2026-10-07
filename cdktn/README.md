# cdktn: desktop UAT on EC2, as Terraform

The minimal way to run desktop UAT: **ephemeral Windows instances**, from a baked
image, in an **existing VPC**. A script launches one, runs the scenarios in its
desktop session, and leaves it up for testers to RDP into **with their AD
accounts**. Then it terminates. There is no agent here: runs are scripted
walkthroughs plus human checks. The AppStream, agent-driven setup is
[`infra/`](../infra/).

It is written with [CDK Terrain](https://cdktn.io) (cdktn) and committed as plain
HCL in [`terraform/desktop-uat/`](terraform/desktop-uat/). Terraform and OpenTofu
users can read, review and apply it without Node or cdktn. **Don't edit
`terraform/` by hand**: it is generated from `lib/`, and `make check` fails if the
two disagree.

## How a run works

```
 GHES job or a laptop: scripts/ec2-uat.sh            (next PR)
  1. stage     build + scenarios ──► s3://<bucket>/staging/<run>/
  2. launch    from the launch template; tags the instance desktop-uat-expires-at
  3. boot      Uat-Boot.ps1: join the domain, autologon the runner account,
               let the tester group RDP in, schedule shutdown at the expiry
  4. run       SSM `run` document ──► Uat-Run.ps1 (SYSTEM) ──► the autologon
               session's task runs Uat-Session.ps1: `uat_harness local`
               ──► reports ──► s3://<bucket>/runs/<run>/
  5. people    testers RDP in from the corporate network, as themselves; the
               build is installed machine-wide in C:\UatInstall
  6. go        SSM `leave` document deletes the computer object; terminate.
               Missed that? The shutdown at the expiry terminates it anyway.
```

The app needs a real desktop, and SSM commands run as SYSTEM in session 0, which
has none. So the run is handed to a scheduled task in the autologon account's
session. Testers get their own RDP sessions, so they and the scripted runs never
share a desktop.

## What is in the module

| File | What |
|---|---|
| `variables.tf` | The inputs: region and accounts, the VPC and subnets, RDP and AD CIDRs, the domain join, the tester group, the image parameter, sizes and retention. See [`example.tfvars`](example.tfvars) |
| `storage.tf` | One private bucket: `staging/` (builds, scenarios) and `runs/` (reports), each expiring |
| `desktop.tf` | The launch template (baked image via `resolve:ssm:`, IMDSv2, terminate on shutdown), its role, its security group (RDP in from `rdp_cidrs` only; HTTPS out; all traffic to `ad_cidrs`), and the settings the boot script reads |
| `run.tf` | The two SSM documents, `run` and `leave` |
| `operator.tf` | A managed policy for whatever runs `ec2-uat.sh` (attach it to the GHES runner role), and the discovery parameter the script finds everything from |
| `outputs.tf`, `providers.tf`, `versions.tf`, `main.tf` | The usual |

One provider (`hashicorp/aws`). No network, NAT, AppStream or Lambda.

## Before it can be applied

- **The image.** On a Windows Server 2022 builder, run
  [`image/ec2/Build-UatEc2Image.ps1`](../image/ec2/Build-UatEc2Image.ps1). Then
  sysprep, `create-image`, `enable-fast-launch`, and put the AMI id in
  `/desktop-uat/ami/windows` (the script's help has the commands).
- **AD:**
  - a join account that may only create and delete computer objects in the UAT OU,
    with its credentials in Secrets Manager as `{"username","password"}`;
  - the tester group;
  - on the UAT OU, Group Policy that allows autologon, with no interactive-logon
    banner and no screen lock for the runner account. Any of these blocks the
    scripted session;
  - a stale-computer clean-up on the OU, for instances that reach their expiry
    without leaving.
- **State.** The backend is `local` for now. It will move to Artifactory, which
  serves a Terraform backend, when this is applied for real.

Not proven until a real run on AWS: the domain join, autologon, the session
task, and the GPO interplay. Pester tests in CI's Windows job cover the scripts'
logic: computer names, expiry, the harness command line and passwords.

## Working on it

Everything runs in the dev container, through `make`:

```sh
make cdktn-test        # jest: resources, documents, contracts with image/ec2/, HCL snapshot, file split
make cdktn-snapshots   # after an intended change: rewrite the HCL snapshot (read the diff)
make cdktn-synth       # regenerate terraform/ (formatted, split into files); commit it
make tofu-validate     # tofu validate against the real provider schema
make tofu-lock         # after the provider version changes; commit .terraform.lock.hcl
```

Write the test first. The contract tests read `image/ec2/`'s scripts. They fail
if the config keys, document parameters, script paths or instance-role
permissions drift apart. See [AGENTS.md §6](../AGENTS.md#6-the-contracts-between-the-parts).

## cdktn's HCL renderer

cdktn 0.24 writes HCL with a few faults (its JSON output is fine). The ones this
module would hit are handled in [`lib/hcl.ts`](lib/hcl.ts) and pinned by
`test/hcl.test.ts`:

- `depends_on` entries come out quoted, which Terraform has deprecated. They are
  unquoted.
- Multi-line strings become `<<EOF` heredocs, copied verbatim. A line reading
  `EOF`, a `${` or a `%{` would change what is deployed, so `heredocSafe` refuses
  those at synth time.
- Backslashes are not escaped, so HCL would read `C:\Uat` as an escape sequence.
  Paths in the configuration use forward slashes, and a test checks the HCL has
  no stray backslash.
