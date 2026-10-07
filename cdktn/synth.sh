#!/usr/bin/env bash
# Synthesizes the cdktn app to HCL, formats it, and splits it into the usual files
# of a root module in terraform/<stack>/ (versions.tf, variables.tf, one file per
# component...): what is committed, reviewed, and applied with Terraform or OpenTofu.
#
#   synth.sh          write terraform/
#   synth.sh --check  write nothing; fail if terraform/ is not what the code synthesizes
#
# Run in the dev container (make cdktn-synth / make cdktn-check): it needs node and tofu.
set -euo pipefail
cd "$(dirname "$0")"

check=false
[ "${1:-}" = "--check" ] && check=true

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

CDKTN_OUTDIR="$work/out" npx ts-node --transpile-only bin/main.ts

mkdir -p "$work/terraform"
for dir in "$work"/out/stacks/*/; do
  stack=$(basename "$dir")
  mkdir -p "$work/terraform/$stack"
  cp "$dir/cdk.tf" "$work/terraform/$stack/main.tf"
  tofu fmt "$work/terraform/$stack" >/dev/null
  npx ts-node --transpile-only bin/split.ts "$work/terraform/$stack"
done
tofu fmt -recursive "$work/terraform" >/dev/null

if $check; then
  # The .tf files are generated; the lock files beside them are committed by hand (make tofu-lock).
  if ! diff -ru --exclude=.terraform --exclude=.terraform.lock.hcl --exclude=.build \
       --exclude='*.tfstate*' terraform "$work/terraform"; then
    echo "cdktn/terraform/ is not what cdktn/ synthesizes. Run 'make cdktn-synth' and commit the result." >&2
    exit 1
  fi
  echo "cdktn/terraform/ is up to date"
  exit 0
fi

# Every generated .tf is replaced; one that is no longer generated goes.
rm -f terraform/*/*.tf
mkdir -p terraform
for dir in "$work"/terraform/*/; do
  stack=$(basename "$dir")
  mkdir -p "terraform/$stack"
  cp "$dir"/*.tf "terraform/$stack/"
  ls "terraform/$stack"/*.tf
done
