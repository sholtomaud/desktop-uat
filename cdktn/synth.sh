#!/usr/bin/env bash
# Synthesizes the cdktn app to HCL and formats it into terraform/<stack>/main.tf:
# the files that are committed, reviewed, and applied with Terraform or OpenTofu.
#
#   synth.sh          write terraform/
#   synth.sh --check  write nothing; fail if terraform/ is not what the code synthesizes
#
# Run in the dev container (make tf-synth / make tf-check): it needs node and tofu.
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
done
tofu fmt -recursive "$work/terraform" >/dev/null

if $check; then
  # Only main.tf is generated; the lock files beside it are committed by hand (make tf-lock).
  if ! diff -ru --exclude=.terraform --exclude=.terraform.lock.hcl --exclude=.build \
       --exclude='*.tfstate*' terraform "$work/terraform"; then
    echo "cdktn/terraform/ is not what cdktn/ synthesizes. Run 'make tf-synth' and commit the result." >&2
    exit 1
  fi
  echo "cdktn/terraform/ is up to date"
  exit 0
fi

# Stacks that no longer exist lose their main.tf; the rest are replaced.
rm -f terraform/*/main.tf
mkdir -p terraform
for dir in "$work"/terraform/*/; do
  stack=$(basename "$dir")
  mkdir -p "terraform/$stack"
  cp "$dir/main.tf" "terraform/$stack/main.tf"
  echo "terraform/$stack/main.tf"
done
