#!/usr/bin/env bash
# One UAT run on an ephemeral EC2 desktop (cdktn/): launch, wait for the domain
# join, run the scenarios through the `run` document, fetch the reports, then tear
# down, or hold the instance for testers to RDP into until its expiry.
#
#   ec2-uat.sh discover     bucket and staging_prefix -> $GITHUB_OUTPUT (for staging the build)
#   ec2-uat.sh run --build-s3-uri s3://<bucket>/staging/... --build-sha256 <hex>
#                  --scenarios <dir> --run-id <id> --state-root <path> --out <dir>
#                  [--tags a,b] [--git-ref <ref>] [--git-sha <sha>] [--hold-minutes N]
#   ec2-uat.sh teardown <instance-id>   leave the domain, terminate
#
# Env:  UAT_EC2_PARAMETER (the discovery parameter, e.g. /desktop-uat/uat/ec2-operator),
#       AWS_REGION; EC2_UAT_POLL_SECONDS (15) and EC2_UAT_READY_TIMEOUT (1800) pace `run`.
# Out:  instance_id, computer_name, private_ip, verdict, held_until -> $GITHUB_OUTPUT
# Exit: 0 when the run passed, 1 when it failed or could not finish, 2 for bad input.
set -euo pipefail
: "${UAT_EC2_PARAMETER:?}" "${AWS_REGION:?}"

POLL=${EC2_UAT_POLL_SECONDS:-15}
READY_TIMEOUT=${EC2_UAT_READY_TIMEOUT:-1800}
RUN_SECONDS=7200            # the run document's timeoutSeconds (cdktn/lib/documents.ts)
MAX_HOLD_MINUTES=1200       # with the run, within the image's 24 h lifetime cap (UatEc2.psm1)
STAGING=staging/
OUTPUT=${GITHUB_OUTPUT:-/dev/null}

out() { echo "$1=$2" >> "$OUTPUT"; }
die() { echo "::error::$1"; exit "${2:-1}"; }
bad() { echo "::error::$1" >&2; exit 2; }

# Everything else comes from the discovery parameter cdktn writes (cdktn/lib/operator.ts).
D="" BUCKET=""
discover() {
  D=$(aws ssm get-parameter --name "$UAT_EC2_PARAMETER" --query Parameter.Value --output text)
  BUCKET=$(d Bucket)
}
d() { jq -r ".$1" <<<"$D"; }

# ---------------------------------------------------------------- polling SSM
# A command's terminal state, and the response code once it has one.
wait_command() {  # <command-id> <instance-id> <timeout seconds>
  local deadline=$(( $(date +%s) + $3 )) status code
  while :; do
    read -r status code < <(aws ssm get-command-invocation --command-id "$1" --instance-id "$2" \
      --query '[Status,ResponseCode]' --output text 2>/dev/null || echo "Pending -1")
    case "$status" in
      Pending|InProgress|Delayed) ;;
      *) echo "$status $code"; return 0 ;;
    esac
    [ "$(date +%s)" -gt "$deadline" ] && { echo "TimedOut -1"; return 0; }
    sleep "$POLL"
  done
}

teardown() {  # <instance-id>
  local id=$1 cmd result
  echo "Leaving the domain: $id"
  if cmd=$(aws ssm send-command --instance-ids "$id" --document-name "$(d LeaveDocument)" \
        --query Command.CommandId --output text) \
     && result=$(wait_command "$cmd" "$id" 600) && [ "${result%% *}" = Success ]; then
    echo "Computer object deleted"
  else
    echo "::warning::$id did not leave the domain; its stale computer object stays in the OU until clean-up"
  fi
  aws ec2 terminate-instances --instance-ids "$id" >/dev/null
  echo "Terminated $id"
}

# ---------------------------------------------------------------- run
run() {
  local build="" sha="" scenarios="" run_id="" state_root="" tags="" git_ref="" git_sha="" hold=0 dest=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --build-s3-uri) build=$2 ;;   --build-sha256) sha=$2 ;;   --scenarios) scenarios=$2 ;;
      --run-id) run_id=$2 ;;        --state-root) state_root=$2 ;;  --tags) tags=$2 ;;
      --git-ref) git_ref=$2 ;;      --git-sha) git_sha=$2 ;;    --hold-minutes) hold=$2 ;;
      --out) dest=$2 ;;
      *) bad "unknown option $1" ;;
    esac
    shift 2
  done

  # The run document's patterns would refuse these too, but only after an instance
  # had been launched and joined; fail before spending anything.
  [[ $run_id =~ ^[A-Za-z0-9._-]{1,64}$ ]] || bad "run id must be 1-64 of [A-Za-z0-9._-]"
  [[ $sha =~ ^[a-f0-9]{64}$ ]] || bad "build sha256 must be 64 lower-case hex digits"
  [[ $tags =~ ^[A-Za-z0-9,_-]*$ ]] || bad "tags must be a comma-separated list of [A-Za-z0-9_-]"
  [[ $state_root =~ ^[A-Za-z0-9%:/\ ._-]{1,200}$ ]] || bad "state root must be 1-200 of [A-Za-z0-9%:/ ._-]"
  [[ $git_ref =~ ^[A-Za-z0-9/._-]{0,200}$ ]] || bad "git ref has characters the run document refuses"
  [[ $git_sha =~ ^[a-f0-9]{0,40}$ ]] || bad "git sha must be hex"
  if ! [[ $hold =~ ^[0-9]+$ ]] || [ "$hold" -gt "$MAX_HOLD_MINUTES" ]; then bad "hold minutes must be 0-$MAX_HOLD_MINUTES"; fi
  # The operator may presign only what is under the bucket's staging/.
  [[ $build == "s3://$BUCKET/$STAGING"* ]] || bad "the build must be staged under s3://$BUCKET/$STAGING (stage-from-artifactory.sh with STAGE_BUCKET)"
  [ -d "$scenarios" ] || bad "no scenarios directory: $scenarios"
  [ -n "$dest" ] || bad "--out is required"

  # 1. Stage the scenarios beside the build, and presign both for the instance.
  local work; work=$(mktemp -d)
  python3 - "$scenarios" "$work/scenarios.zip" <<'PY'
import sys, zipfile
from pathlib import Path
src, dst = Path(sys.argv[1]), sys.argv[2]
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(p for p in src.rglob("*") if p.is_file()):
        z.write(f, f.relative_to(src).as_posix())
PY
  local scenarios_uri="s3://$BUCKET/${STAGING}runs/$run_id/scenarios.zip"
  aws s3 cp "$work/scenarios.zip" "$scenarios_uri" --only-show-errors
  rm -rf "$work"
  local expires_in=$(( READY_TIMEOUT + RUN_SECONDS ))
  local build_url scenarios_url
  build_url=$(aws s3 presign "$build" --expires-in "$expires_in")
  scenarios_url=$(aws s3 presign "$scenarios_uri" --expires-in "$expires_in")

  # 2. Launch. The expiry covers the join, the run, and the hold; the instance
  #    schedules its own shutdown, and so termination, from it at every boot.
  local expires_at=$(( $(date +%s) + READY_TIMEOUT + RUN_SECONDS + hold * 60 ))
  local tag_spec subnet id=""
  tag_spec=$(jq -nc --arg purpose "$(d Purpose)" --arg run "$run_id" --arg exp "$expires_at" \
    '[{ResourceType: "instance", Tags: [
        {Key: "Name", Value: ("desktop-uat-" + $run)}, {Key: "Purpose", Value: $purpose},
        {Key: "desktop-uat-run", Value: $run}, {Key: "desktop-uat-expires-at", Value: $exp}]}]')
  for subnet in $(jq -r '.SubnetIds[]' <<<"$D"); do
    if id=$(aws ec2 run-instances --launch-template "LaunchTemplateId=$(d LaunchTemplateId),Version=\$Latest" \
          --subnet-id "$subnet" --tag-specifications "$tag_spec" \
          --query 'Instances[0].InstanceId' --output text); then
      break
    fi
    echo "::warning::could not launch in $subnet; trying the next subnet"
    id=""
  done
  [ -n "$id" ] || die "could not launch an instance in any subnet"
  out instance_id "$id"
  echo "Launched $id, expiring at $(date -u -d "@$expires_at" +%FT%TZ)"
  # Expanded now: $id is local, and gone by the time a normal exit runs the trap.
  # shellcheck disable=SC2064
  if [ "$hold" -eq 0 ]; then trap "teardown '$id'" EXIT; fi

  # 3. Wait until it has joined the domain. The join restarts it, and a command
  #    sent before the restart would die with it; after the join, the instance
  #    reports its new name (UAT-<end of the instance id>, see UatEc2.psm1).
  local hex=${id#i-} expected ping name
  expected="UAT-$(tr '[:lower:]' '[:upper:]' <<<"${hex: -11}")"
  local deadline=$(( $(date +%s) + READY_TIMEOUT ))
  while :; do
    read -r ping name < <(aws ssm describe-instance-information \
      --filters "Key=InstanceIds,Values=$id" \
      --query 'InstanceInformationList[0].[PingStatus,ComputerName]' --output text 2>/dev/null || echo "None None")
    if [ "$ping" = Online ] && [[ ${name^^} == "$expected".* || ${name^^} == "$expected" ]]; then break; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      out verdict FAIL
      die "$id did not join the domain within ${READY_TIMEOUT}s (SSM: $ping $name); see C:\\UatRun\\boot.log"
    fi
    sleep "$POLL"
  done
  out computer_name "$name"
  echo "$id is $name"

  # 4. Run the scenarios in its desktop session.
  local params cmd status code
  params=$(jq -nc --arg run "$run_id" --arg build "$build_url" --arg sha "$sha" --arg scen "$scenarios_url" \
    --arg tags "$tags" --arg root "$state_root" --arg ref "$git_ref" --arg gsha "$git_sha" \
    '{RunId: [$run], BuildUrl: [$build], BuildSha256: [$sha], ScenariosUrl: [$scen],
      Tags: [$tags], StateRoot: [$root], GitRef: [$ref], GitSha: [$gsha]}')
  cmd=$(aws ssm send-command --instance-ids "$id" --document-name "$(d RunDocument)" \
    --parameters "$params" --query Command.CommandId --output text)
  echo "Running scenarios: $cmd"
  read -r status code < <(wait_command "$cmd" "$id" $(( RUN_SECONDS + 300 )))
  echo "Run finished: $status (exit $code)"

  # 5. Whatever happened, fetch what the run reported.
  mkdir -p "$dest"
  aws s3 cp "s3://$BUCKET/runs/$run_id/" "$dest" --recursive --only-show-errors || true

  local verdict=FAIL
  [ "$status" = Success ] && [ "$code" = 0 ] && verdict=PASS
  out verdict "$verdict"

  # 6. Hold it for testers, or (the EXIT trap) tear it down.
  if [ "$hold" -gt 0 ]; then
    local ip
    ip=$(aws ec2 describe-instances --instance-ids "$id" \
      --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text)
    out private_ip "$ip"
    out held_until "$expires_at"
    local until; until=$(date -u -d "@$expires_at" +%FT%TZ)
    echo "Held for testers until $until: RDP to $name ($ip)"
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      {
        echo "### Desktop held for testers"
        echo ""
        echo "| | |"
        echo "|---|---|"
        echo "| RDP to | \`$name\` (\`$ip\`), with your AD account |"
        echo "| Until | $until, when it terminates itself |"
        echo "| Build | installed in \`C:\\UatInstall\` |"
      } >> "$GITHUB_STEP_SUMMARY"
    fi
  fi

  [ "$verdict" = PASS ] || exit 1
}

case "${1:-}" in
  discover)
    discover
    out bucket "$BUCKET"
    out staging_prefix "$STAGING"
    echo "Stage into s3://$BUCKET/$STAGING" ;;
  run) shift; discover; run "$@" ;;
  teardown) discover; teardown "${2:?instance id}" ;;
  *) echo "usage: $0 discover | run --build-s3-uri ... | teardown <instance-id>" >&2; exit 2 ;;
esac
