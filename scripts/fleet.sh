#!/usr/bin/env bash
# Fleet lifecycle for the UAT workflow.
#   fleet.sh start            start the on-demand fleet and wait until RUNNING
#   fleet.sh stop             stop it (idempotent)
#   fleet.sh lease <seconds>  tell the janitor not to stop the fleet until now+seconds
#   fleet.sh release          drop the lease
# Env:  FLEET_POLL_SECONDS (20) and FLEET_START_TIMEOUT (1500) pace `start`.
set -euo pipefail
: "${UAT_SSM_PREFIX:?}" "${AWS_REGION:?}"
param() { aws ssm get-parameter --name "$UAT_SSM_PREFIX/$1" --query Parameter.Value --output text; }
FLEET=$(param fleet-name)
state() { aws appstream describe-fleets --names "$FLEET" --query 'Fleets[0].State' --output text; }

case "${1:-}" in
  start)
    deadline=$(( $(date +%s) + ${FLEET_START_TIMEOUT:-1500} ))
    while :; do
      s=$(state)
      case "$s" in
        RUNNING) echo "fleet $FLEET RUNNING"; exit 0 ;;
        STOPPED) echo "starting $FLEET"; aws appstream start-fleet --name "$FLEET" ;;
        STARTING|STOPPING) echo "fleet $FLEET is $s, waiting" ;;
        *) echo "::error::unexpected fleet state $s"; exit 1 ;;
      esac
      [ "$(date +%s)" -gt "$deadline" ] && { echo "::error::fleet did not reach RUNNING"; exit 1; }
      sleep "${FLEET_POLL_SECONDS:-20}"
    done ;;
  stop)
    s=$(state)
    if [ "$s" = RUNNING ] || [ "$s" = STARTING ]; then aws appstream stop-fleet --name "$FLEET"; echo "stop requested"; else echo "fleet is $s"; fi ;;
  lease)
    until=$(( $(date +%s) + ${2:?seconds} ))
    aws ssm put-parameter --name "$UAT_SSM_PREFIX/fleet-lease" --value "$until" --type String --overwrite >/dev/null
    echo "lease held until $(date -u -d "@$until" +%FT%TZ)" ;;
  release)
    aws ssm put-parameter --name "$UAT_SSM_PREFIX/fleet-lease" --value 0 --type String --overwrite >/dev/null
    echo "lease released" ;;
  *) echo "usage: $0 start|stop|lease <seconds>|release" >&2; exit 2 ;;
esac
