# Desktop UAT: agentic beta testing on Amazon WorkSpaces Applications

Agentic UAT for a C++ Windows desktop app. Releases come from Artifactory. Tests run on
WorkSpaces Applications agent access, orchestrated from GitHub Enterprise Server runners in
private subnets. Humans sign off.

```
Artifactory --webhook--> GHES workflow --> ephemeral runner (private subnet, NAT egress)
                                             |  1. pull release, verify sha256, stage to S3
                                             |  2. start fleet, CreateStreamingURL per scenario
                                             |  3. Strands agent (Bedrock) <-SigV4-> agentaccess-mcp.<region>.api.aws
                                             v
                       WorkSpaces desktop (isolated subnet, no internet, S3 gateway endpoint only)
                         FlaUI MCP server (forwarded tools): install_build, launch_app, assert_element ...
                                             |
                       report.json (schema'd) + junit.xml + screenshots -> S3 (KMS) + job artifact
                                             v
                       `uat-signoff` environment: required human reviewers approve the release
```

## Layout

| Path | What |
|---|---|
| `infra/` | CDK (TypeScript): Network, Desktop (fleet, agent-access stack, buckets, janitor), Runners |
| `scripts/stage-from-artifactory.sh` | Pull release, verify against Artifactory's SHA-256, stage to S3 |
| `scripts/fleet.sh` | Start/stop fleet, hold/release the janitor lease |
| `harness/` | Python harness: sessions, agent, deterministic assertions, reporting |
| `harness/scenarios/*.yaml` | UAT scenarios (visual criteria judged by the agent, deterministic by FlaUI) |
| `harness/report.schema.json` | JSON Schema of `report.json` |
| `image/flaui-mcp-server/` | .NET 8 MCP server (FlaUI UIA3), forwarded into the session |
| `image/Install-UatImage.ps1` | Prepares the image builder and creates the image |
| `.github/workflows/desktop-uat.yml` | GHES workflow |
| `scripts/resolve-artifact.sh` | Turns the triggering event into a validated Artifactory repo and path |
| `tests/`, `harness/tests/`, `infra/test/` | The tests, all offline (see [AGENTS.md §5](AGENTS.md#5-what-is-mocked-and-what-is-not-tested-at-all)) |
| `Makefile`, `Containerfile` | Every build and check, in containers: `make help` |

## Developing

The host needs only Apple `container` (CI uses Docker). Everything else runs in images:

```bash
make image   # once, and after changing harness/requirements*.txt
make check   # lint, typecheck, CDK tests, offline synth, scenario validation, pytest, FlaUI build
```

[AGENTS.md](AGENTS.md) is the contributor standard.

## Network design

- **Fleet:** `PRIVATE_ISOLATED` subnets, `enableDefaultInternetAccess: false`. The only route is
  the S3 gateway endpoint, used to pull the staged build via a 15-minute presigned URL. The builds
  bucket denies `GetObject` from anywhere except that endpoint. Streaming and agent traffic use the
  service-managed network interface, not your subnet.
- **Runners:** `PRIVATE_WITH_EGRESS` with NAT. Agent access does **not** support VPC endpoints,
  so the MCP endpoint `agentaccess-mcp.<region>.api.aws` is reached over NAT. Everything else
  uses interface endpoints (STS, Bedrock runtime, SSM, Logs, Secrets Manager, KMS, AppStream API).
  To lock NAT egress down further, put AWS Network Firewall in front of NAT with a domain
  allow-list: the MCP endpoint, your GHES host, Artifactory, and your PyPI mirror.
- **Credentials:** runners use an instance profile, not GHES OIDC. STS must reach the OIDC
  issuer's JWKS over the internet, which a private GHES usually can't offer.

## Prerequisites

1. **Region with an MCP endpoint.** `ap-southeast-2` is supported. Bedrock model access is
   enabled for the configured model. The default `global.` inference profile can route
   cross-region; use an `au.` profile instead if you need data residency.
2. **Secrets Manager** (created by you, not CDK):
   - `desktop-uat/ghes-runner-token`, value `{"token":"<PAT with admin:org (org scope) or repo admin>"}`.
     A GitHub App installation token is preferable for production.
   - `desktop-uat/artifactory-token`, value `{"token":"<read-only access token for the release repo>"}`.
3. **Network paths:** runner subnets to GHES and to Artifactory (TGW/Direct Connect for
   on-prem, or JFrog PrivateLink/NAT for JFrog Cloud).
4. **Artifactory:** SHA-256 checksums must exist on release artifacts. The script fails if they don't.
5. **Installer:** WorkSpaces session users are **not local administrators**. Ship either an MSI
   that supports per-user install (`ALLUSERS=2 MSIINSTALLPERUSER=1`) or a portable `.zip`. Bake
   machine-wide prerequisites (VC++ runtime, drivers) into the image.

## Deploy

```bash
make check
# edit infra/cdk.json: account, region, GHES URL/org, Artifactory URL, fleet.imageName, labels
# and, for a new account or region, its AZs in infra/cdk.context.json (synth stays offline)
cd infra && npx cdk deploy DesktopUat-prod-Network DesktopUat-prod-Desktop
```

The fleet needs an image, so build that first:

1. Set `createImageBuilder: true` and deploy the Desktop stack. Connect to the image builder
   from the WorkSpaces Applications console.
2. Build the server: `make flaui-zip` writes `dist/flaui-mcp-server.zip` (a self-contained
   win-x64 publish, built in the .NET SDK container, so no Windows machine is needed).
3. On the image builder:
   `.\Install-UatImage.ps1 -ServerZip ... -BuildsBucketHost <BuildsBucket>.s3.<region>.amazonaws.com -VcRedist ... -ImageName desktop-uat-base-YYYY-MM-DD -CreateImage`
4. Put the image name in `fleet.imageName`, set `createImageBuilder: false`, then:

```bash
npx cdk deploy DesktopUat-prod-Desktop DesktopUat-prod-Runners
```

## GHES configuration

- **Environment `uat-signoff`:** add required reviewers (your UAT leads).
- **Repository variables** (optional): `PIP_INDEX_URL` for an internal mirror; and, for the
  `push` trigger, `UAT_ARTIFACTORY_REPO` and `UAT_ARTIFACT_PATH_TEMPLATE`, e.g.
  `app/{version}/App-{version}.msi`.
- **Artifactory webhook** (deploy or promotion event on the release repo), calling
  `POST https://<ghes>/api/v3/repos/<owner>/<repo>/dispatches` with a token that can dispatch:
  ```json
  {"event_type":"artifactory-release","client_payload":{"repo":"desktop-releases","path":"app/1.4.0/App-1.4.0.msi"}}
  ```
- **Actions:** `actions/upload-artifact@v4` is not supported on GHES, so the workflow uses `@v3`.
  Make sure `actions/checkout@v4` and `upload-artifact@v3` are available on your instance.

## Writing scenarios

Each scenario runs in a fresh desktop: install, then setup, then launch, then agent, then deterministic assertions.

- **`visual` criteria** are judged by the agent. It must cite screenshot evidence IDs, or the
  harness rejects the verdict and counts the criterion as failed.
- **`deterministic` criteria** call FlaUI tools (`assert_element`, `assert_window_title`) after the
  agent finishes. Use these for anything that must be exact: text, enabled state, values.
- `explore: true` asks the agent to also report beta findings with a severity.
- To discover AutomationIds, call `dump_ui_tree` in a session, or use FlaUInspect. Set
  AutomationIds explicitly in your C++ UI code (MFC/Win32 control IDs, or `UIA_AutomationIdPropertyId`
  providers). That is the single biggest reliability win.
- Validate locally: `make harness-validate`

## Reports

Each run writes `reports/`. The workflow uploads it as the job artifact
`desktop-uat-<run>-<attempt>`, which keeps it for 30 days.

| File | For |
|---|---|
| `summary.md` | the run's job summary page: results table, failed criteria, findings |
| `report.json` | machine-readable, validated by `harness/report.schema.json` |
| `junit.xml` | any JUnit-aware tool. GitHub itself does not render JUnit |
| `evidence/<scenario>/E###-*.png` | the screenshots the agent and harness cited |
| `logs/<scenario>.log` | each scenario subprocess's output |

Every non-passing criterion also becomes an **error annotation** on the run and on
the PR's checks, and every finding becomes a warning (critical, major) or a notice
(minor, cosmetic). These are GitHub's native workflow commands, so they need no extra
action and work on GHES. GitHub shows at most 10 annotations of each level per step,
which is why errors come first. The summary cites screenshots by their path in the
artifact. Every screenshot and report is also kept, KMS-encrypted, in the evidence
bucket under `runs/<run_id>/` for the audit trail.

## Watching an agent (VIEW_STOP)

Run with `observe: true`. For each scenario the job log prints an `aws ssm get-parameter` command.
That command returns a short-lived streaming URL (a SecureString, so it stays out of CI logs).
Open the URL to watch, and press Stop to revoke the agent's access.

## Cost controls

- On-demand fleet, started per run and stopped in an `always()` step.
- Janitor Lambda stops the fleet when it has no sessions and no valid lease (safety net for
  cancelled jobs).
- Release-only triggers. `fleet.maxConcurrentSessions` caps parallel desktops.
- One subprocess per scenario with a hard timeout. Killing it closes the MCP connection,
  which ends the session.

## Verify before production

These parts were built against AWS docs and the aws-samples repo but **not executed end to end**:

- [ ] `AgentAccessConfig` deploys through CloudFormation in your region. It is set via
      `addPropertyOverride`, so it works regardless of aws-cdk-lib's typed support.
- [ ] Forwarded tool naming (e.g. `flaui.assert_element`). The harness matches on suffix; check
      the names with a test session.
- [ ] Observer semantics: whether a second `CreateStreamingURL` for the same user joins the
      agent's session as a VIEW_STOP observer.
- [x] FlaUI server compiles with the pinned `ModelContextProtocol` and `FlaUI.UIA3` versions
      (`make flaui-build`, in CI). Still to do: update to current releases, and run it on the image.
- [ ] Image Assistant CLI flags (`image-assistant.exe help create-image`).
- [ ] The CDK uses `appstream:Describe*` on `*`. Narrow it if your SCPs require.
- [ ] Lock Python dependencies (`pip-compile --generate-hashes`) and NuGet packages.

What *is* verified offline, on every PR: the CDK typechecks, synthesizes and passes its
assertions, including contract tests that hold the stacks to what the harness, the scripts
and the workflow expect, and a run of the janitor's own code. The harness runs end to end
against a fake desktop and a scripted agent. The workflow's scripts run against a fake `aws`
and a stub Artifactory. See [AGENTS.md §5](AGENTS.md#5-what-is-mocked-and-what-is-not-tested-at-all)
for what each fake stands in for.
