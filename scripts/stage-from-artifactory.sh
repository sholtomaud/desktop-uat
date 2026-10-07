#!/usr/bin/env bash
# Pull a release artifact from Artifactory, verify it against Artifactory's own
# SHA-256, and stage an immutable copy in the UAT builds bucket.
#
# Usage: stage-from-artifactory.sh <repo> <path/in/repo/App-1.4.0.msi>
# Env:   ARTIFACTORY_URL, ARTIFACTORY_SECRET_ID, AWS_REGION (set on the runner), and either
#        UAT_SSM_PREFIX (infra/: the builds bucket is in SSM) or
#        STAGE_BUCKET and STAGE_PREFIX (cdktn/'s EC2 path: `ec2-uat.sh discover` names them)
# Out:   build_s3_uri, build_sha256, build_name, artifactory_uri  -> $GITHUB_OUTPUT
set -euo pipefail

REPO="${1:?artifactory repo key required}"
ART_PATH="${2:?artifact path required}"
ART_PATH="${ART_PATH#/}"
: "${ARTIFACTORY_URL:?}" "${ARTIFACTORY_SECRET_ID:?}" "${AWS_REGION:?}"

BASE="${ARTIFACTORY_URL%/}"
if [ -n "${STAGE_BUCKET:-}" ]; then
  BUCKET=$STAGE_BUCKET
else
  : "${UAT_SSM_PREFIX:?UAT_SSM_PREFIX or STAGE_BUCKET is required}"
  BUCKET=$(aws ssm get-parameter --name "$UAT_SSM_PREFIX/builds-bucket" --query Parameter.Value --output text)
fi
TOKEN=$(aws secretsmanager get-secret-value --secret-id "$ARTIFACTORY_SECRET_ID" \
  --query SecretString --output text | jq -r .token)
echo "::add-mask::$TOKEN"
AUTH=(-H "Authorization: Bearer $TOKEN")

# 1. Ask Artifactory for the artifact's recorded checksum (storage API).
INFO=$(curl -fsS "${AUTH[@]}" "$BASE/api/storage/$REPO/$ART_PATH")
EXPECTED=$(jq -r '.checksums.sha256 // empty' <<<"$INFO")
if [ -z "$EXPECTED" ]; then
  echo "::error::Artifactory has no sha256 for $REPO/$ART_PATH (run checksum calculation on the repo)"
  exit 1
fi

# 2. Download and verify locally. A mismatch means corruption or tampering in transit.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
NAME=$(basename "$ART_PATH")
curl -fsS "${AUTH[@]}" -o "$WORK/$NAME" "$BASE/$REPO/$ART_PATH"
unset TOKEN AUTH
ACTUAL=$(sha256sum "$WORK/$NAME" | cut -d' ' -f1)
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "::error::SHA-256 mismatch for $NAME: artifactory=$EXPECTED downloaded=$ACTUAL"
  exit 1
fi

# 3. Stage content-addressed, so a re-run tests exactly the same bytes.
KEY="${STAGE_PREFIX:-}artifactory/$REPO/$ACTUAL/$NAME"
aws s3 cp "$WORK/$NAME" "s3://$BUCKET/$KEY" --only-show-errors \
  --metadata "artifactory-path=$REPO/$ART_PATH,sha256=$ACTUAL"

{
  echo "build_s3_uri=s3://$BUCKET/$KEY"
  echo "build_sha256=$ACTUAL"
  echo "build_name=$NAME"
  echo "artifactory_uri=$BASE/$REPO/$ART_PATH"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"

echo "Staged $REPO/$ART_PATH ($ACTUAL) -> s3://$BUCKET/$KEY"
