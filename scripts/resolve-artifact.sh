#!/usr/bin/env bash
# Resolve the release under test from whatever triggered the workflow, and refuse
# anything that is not a plain Artifactory repo key and path.
#
# Every input arrives through the environment, never interpolated into the
# script, because all of it is outside the repository's control: a webhook
# payload, a dispatch form, a branch name.
#
# Env: EVENT_NAME, and per event
#        repository_dispatch  DISPATCH_REPO, DISPATCH_PATH
#        workflow_dispatch    INPUT_REPO, INPUT_PATH
#        push                 REF_NAME (release/<semver>), DEFAULT_REPO, PATH_TEMPLATE ({version})
# Out: repo, path -> $GITHUB_OUTPUT
set -euo pipefail

case "${EVENT_NAME:-}" in
  repository_dispatch) REPO="${DISPATCH_REPO:-}"; ART="${DISPATCH_PATH:-}" ;;
  workflow_dispatch)   REPO="${INPUT_REPO:-}";    ART="${INPUT_PATH:-}" ;;
  push)
    VERSION="${REF_NAME#release/}"
    [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?$ ]] || { echo "::error::bad version '$VERSION'"; exit 1; }
    REPO="${DEFAULT_REPO:-}"; ART="${PATH_TEMPLATE//\{version\}/$VERSION}" ;;
  *) echo "::error::unsupported event ${EVENT_NAME:-}"; exit 1 ;;
esac
[[ "$REPO" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "::error::bad repo key"; exit 1; }
[[ "$ART" =~ ^[A-Za-z0-9._/+-]+$ && "$ART" != *..* ]] || { echo "::error::bad artifact path"; exit 1; }
echo "repo=$REPO" >> "$GITHUB_OUTPUT"
echo "path=$ART"  >> "$GITHUB_OUTPUT"
echo "Testing $REPO/$ART"
