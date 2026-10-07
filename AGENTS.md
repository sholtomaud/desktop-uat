# AGENTS.md

The standard for this repository. Read it before changing anything.

## 1. What this is

Agentic user-acceptance testing for a Windows desktop application. When a release
lands in Artifactory, a GHES workflow stages it, starts an Amazon WorkSpaces
Applications fleet, and has a Bedrock agent drive the app on a fresh Windows desktop
per scenario. FlaUI checks the exact parts. A human signs off. The
[README](README.md) has the architecture and the deployment steps.

The repository has four parts, which never run in the same place:

| Part | Language | Where it runs |
|---|---|---|
| [`infra/`](infra/) | TypeScript, CDK | `cdk deploy`, from a laptop or a pipeline |
| [`cdktn/`](cdktn/) + [`image/ec2/`](image/ec2/) | TypeScript, cdktn → committed HCL; PowerShell | `terraform`/`tofu apply` of [`cdktn/terraform/`](cdktn/terraform/) (not yet applied); the scripts **inside the EC2 Windows image** |
| [`harness/`](harness/) | Python 3.11 | the GHES runner (Amazon Linux 2023), driven by the workflow |
| [`scripts/`](scripts/) + [`.github/workflows/desktop-uat.yml`](.github/workflows/desktop-uat.yml), [`desktop-uat-ec2.yml`](.github/workflows/desktop-uat-ec2.yml) | bash | the GHES runner |
| [`image/flaui-mcp-server/`](image/flaui-mcp-server/) | C#, .NET 8 | **inside the Windows desktop**, baked into the WorkSpaces image |

There are two ways to deploy, for two ways of testing. `infra/` is the agent-driven
one: AppStream agent access, a Bedrock agent, isolated desktops. `cdktn/` is the
minimal one: ephemeral Windows EC2 instances, from an image baked by `image/ec2/`, in
an existing VPC. They run scripted walkthroughs, and testers RDP in with their AD
accounts. Its HCL is committed, so teams that run Terraform can review and apply it
without Node.

They meet only at a few contracts (§6). Most cross-part bugs are a break in one of
those contracts.

## 2. Built to last

### Few dependencies, and each one justified

- **CDK:** `aws-cdk-lib` and `constructs`. Lambda code stays inline and uses only
  the AWS SDK that the runtime already provides. No bundling, so synth needs no Docker.
- **cdktn:** `cdktn`, `constructs` and the prebuilt `@cdktn/provider-aws`, all pinned
  exactly (cdktn is pre-1.0). No `cdktn-cli`: the library writes HCL itself.
- **EC2 image scripts:** Windows PowerShell 5.1 and the AWS Tools for PowerShell that
  AWS's Windows images ship with. Nothing installed for them.
- **Harness:** `strands-agents`, `mcp-proxy-for-aws`, `boto3`, `pydantic`, `PyYAML`.
  Everything else comes from the standard library.
- **FlaUI server:** `FlaUI.UIA3`, `ModelContextProtocol`, `Microsoft.Extensions.Hosting`.
- **Scripts:** bash, `aws`, `curl`, `jq`, coreutils. These are what the runner has.

Adding a runtime dependency needs a reason in the PR: what it does that the existing
ones cannot, and what happens when it is abandoned. Build and test tooling is exempt:
jest, ts-jest, pytest, actionlint, shellcheck.

### Test first

**Every change begins with a failing test.** Red, then green, then refactor. A bug
fix starts by reproducing the bug in a test.

Test behaviour from the outside. The shell scripts run unmodified as subprocesses.
The harness runs its real code against a fake desktop. The janitor test runs the
Lambda code taken from the synthesized template, which is the exact code Lambda
would run.

## 3. Everything runs in the container

Do not assume the host has Node, a Python that matches the runner, .NET, shellcheck,
or GNU coreutils. Everything goes through the [`Makefile`](Makefile) and the Apple
`container` images:

| Image | Used for |
|---|---|
| `desktop-uat` ([`Containerfile`](Containerfile)): Node `.node-version` on Debian bookworm, Python 3.11, harness deps, `curl`/`jq`/`shellcheck`, OpenTofu (pinned, checksum-verified) | CDK, cdktn and `tofu`, harness, scripts |
| `mcr.microsoft.com/dotnet/sdk:8.0` | building the FlaUI server, which targets `net8.0-windows` via `EnableWindowsTargeting` |
| `rhysd/actionlint` | the workflows |

Bookworm is deliberate: its `python3` is 3.11, the version the runner uses
(`UAT_PYTHON`). Changing `harness/requirements*.txt` means running `make image` again,
because the dependencies are built into the image rather than installed into the
checkout.

`make help` lists the targets. CI ([`ci.yml`](.github/workflows/ci.yml)) runs the same
`make check` with `CONTAINER_BIN=docker`.

## 4. Before pushing

```sh
make check
```

`make check` runs these targets:
- `lint`: actionlint over the workflows (including shellcheck of every `run:` block), and shellcheck over `scripts/`
- `typecheck`: `tsc --noEmit` on the CDK
- `test-infra`: jest on the stacks, the contracts (§6) and the janitor
- `synth`: `cdk synth` of all three stacks, offline
- `cdktn-typecheck`, `cdktn-test`: `tsc` and jest on `cdktn/`, including an HCL snapshot
- `cdktn-check`: the committed `cdktn/terraform/` is exactly what `cdktn/` synthesizes
- `tofu-validate`: `tofu validate` of that HCL against the real provider schemas,
  using the committed lock files (this one downloads providers)
- `harness-validate`: every scenario in `harness/scenarios/`
- `test-py`: pytest on the harness and the scripts
- `flaui-build`: compiles the Windows MCP server

All of them must pass. Run the check on the branch the PR will carry, so the PR's
claim matches what was actually tested.

## 5. What is mocked, and what is not tested at all

There is no AWS account in the loop. Every outside service is replaced at the
boundary, and the code under test is the real code:

| Real thing | Replaced by | Where |
|---|---|---|
| the `aws` CLI | [`tests/fakes/aws`](tests/fakes/aws): a JSON state file plus a call log | `tests/` |
| Artifactory | a stdlib HTTP server serving the storage API and downloads | [`tests/script_support.py`](tests/script_support.py) |
| the agent-access MCP session (computer use + forwarded FlaUI tools) | `FakeDesktop`, built from real strands `MCPAgentTool`s | [`harness/tests/support.py`](harness/tests/support.py) |
| `boto3` clients | `FakeBoto` (S3, AppStream, SSM) | same |
| the Bedrock agent loop | a scripted agent that calls the real `capture_evidence` / `submit_verdict` tools | [`harness/tests/test_agent.py`](harness/tests/test_agent.py) |
| the Lambda AWS SDK | fake clients injected through `require` | [`infra/test/janitor.test.ts`](infra/test/janitor.test.ts) |
| the Windows desktop's screen (local mode) | a fixed PNG in place of the PowerShell capture | [`harness/tests/test_cli.py`](harness/tests/test_cli.py) |
| the EC2 instance (IMDS, the domain, SSM) | nothing: the EC2 image scripts' logic is in [`UatEc2.psm1`](image/ec2/UatEc2.psm1), tested by Pester in CI's `windows` job; the scripts around it only do I/O | [`image/ec2/tests/`](image/ec2/tests/) |

**There are two ways a scenario runs, and they share one code path** (`runner.execute`):
an *agent* run on AWS (`AwsBackend`), and a *walkthrough* run on any Windows machine
(`LocalBackend`, `uat_harness local`). In a walkthrough run the scenario's `walkthrough:`
steps drive the app instead of the agent. A change to setup, assertions, evidence or
reporting therefore reaches both runs. A change that only one of them needs goes in its
backend.

CI's `windows` job runs the real things the containers can't: the live FlaUI tests,
the worked scenario in walkthrough mode with its report published, and Pester on the
EC2 image scripts.

Not tested locally, and only proven by a real run on AWS: whether the model's
judgement is any good, what the agent-access service actually does, the
WorkSpaces image, and the FlaUI server against a live UI. The README's
"Verify before production" list tracks these. When one is proven, tick it there
and, where you can, turn what you learned into a test, for example the real
forwarded-tool naming in `FakeDesktop`.

Fakes go stale silently. **When you change how code calls the outside world (a new
`aws` subcommand, a new MCP tool, a new SDK call), update the fake in the same PR.**
`tests/fakes/aws` fails loudly on anything it does not implement, so it can't let a
new call pass unnoticed.

## 6. The contracts between the parts

The harness and the scripts never see the stacks. They find what they need through
these contracts:

- **SSM parameters under `/desktop-uat/<env>/`**, written by the Desktop stack and
  read by `HarnessConfig.from_ssm`, `fleet.sh` and `stage-from-artifactory.sh`.
- **`/etc/desktop-uat-runner.env`**, written by the runner user data and loaded by
  the workflow.
- **Runner labels**: `runner.labels` in `infra/cdk.json` must match `runs-on` in the
  workflow.
- **The runner role**, which must grant every call the scripts and the harness make.
- **The FlaUI tool names and their JSON replies** (`{"ok": ...}` for setup,
  `{"pass", "message", "actual"}` for assertions), shared by the C# server, the
  harness and `FakeDesktop`.

[`infra/test/contracts.test.ts`](infra/test/contracts.test.ts) reads the consumers'
source and checks the first four against the synthesized templates.

The EC2 path has its own contracts, between `cdktn/` and `image/ec2/`:

- **The config parameter** (`/desktop-uat/<env>/ec2-config`): its keys are what the
  boot, run and leave scripts read.
- **The SSM documents**: the `run` document's parameters are `Uat-Run.ps1`'s, passed
  single-quoted under patterns that admit no quote.
- **The script paths**: `C:/Uat/...` in user data and the documents is where
  `Build-UatEc2Image.ps1` installs them.
- **The instance role**, which must allow every AWS cmdlet the scripts call, and no more.

- **The discovery parameter** (`/desktop-uat/<env>/ec2-operator`) and the operator
  policy: what `scripts/ec2-uat.sh` reads and calls, and the `run` document's
  parameters and patterns, which the script sends and checks.

[`cdktn/test/contracts.test.ts`](cdktn/test/contracts.test.ts) checks those against
the synthesized Terraform. Change both
sides of a contract in the same PR. If a contract test breaks, read it as a missing
change on the other side, not as a test to loosen.

## 7. Changing things

- **The workflow:** keep logic out of `run:` blocks. Put it in `scripts/` and test it
  there, as with [`resolve-artifact.sh`](scripts/resolve-artifact.sh). Pass event data
  in through `env:`, never as `${{ }}` inside a script: webhook payloads, form inputs
  and branch names are all attacker-controlled. Stay on `actions/upload-artifact@v3` in the GHES workflows,
  because GHES does not support v4. That is the one actionlint finding that is
  suppressed, per workflow, in [`.github/actionlint.yaml`](.github/actionlint.yaml).
- **The CDK:** synth must stay offline. A new context lookup (`fromLookup`, AZs for a
  new account or region) needs its answer committed in
  [`infra/cdk.context.json`](infra/cdk.context.json).
- **cdktn:** change `cdktn/lib/`, then `make cdktn-synth` and commit the regenerated
  `cdktn/terraform/`. Never edit the HCL by hand: `make cdktn-check` rejects it.
  Environment-specific values are Terraform variables, never constants; see
  [`cdktn/example.tfvars`](cdktn/example.tfvars). After an intended change, `make
  cdktn-snapshots` rewrites the snapshot; read its diff, it is the HCL diff. After the
  provider version changes, `make tofu-lock` too. cdktn 0.24's HCL renderer has
  faults: see [`cdktn/README.md`](cdktn/README.md). Its main rules are that a
  multi-line string must be one `heredocSafe` accepts, and that strings use forward
  slashes, never backslashes.
- **The EC2 image scripts** (`image/ec2/`): logic goes in `UatEc2.psm1`, with a
  Pester test; the scripts stay I/O. Write them for Windows PowerShell 5.1, which the
  instances run. Only a run on AWS proves the domain join, autologon and session task.
- **The harness:** tools the LLM must never call go in `AGENT_DENYLIST`. A visual
  criterion counts only if the agent cites evidence. Do not relax that to make a
  scenario pass.
- **Scenarios** (`harness/scenarios/*.yaml`): anything that must be exact belongs in
  a `deterministic` criterion, not a `visual` one. `make harness-validate` checks the
  schema.
- **The FlaUI server:** `make flaui-build` proves it compiles. Only a session on the
  image proves it works. `make flaui-zip` produces the zip that
  `Install-UatImage.ps1` takes.

## 8. Push *and* open a PR

CI runs on `pull_request` against any base branch. A pushed branch with no PR has
been tested by nothing. Don't stop at the push, and don't merge your own PR: hand over
a green one.

Branch names: `feat/`, `fix/`, `docs/`, `chore/`.

A task is done when it is **merged**, not when it is written.
