# The host is not assumed to have Node or a matching Python. The CDK (npm, tsc,
# jest, cdk synth), cdktn with OpenTofu, and the harness (Python) run in here,
# driven by the Makefile.
#
# Bookworm, not the default Debian, because bookworm's python3 is 3.11 — the
# version the GHES runner uses (UAT_PYTHON, default python3.11). Testing the
# harness on a different minor than CI runs it would test the wrong thing.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim

WORKDIR /app

ENV CI=true

# curl, jq and sha256sum are what scripts/stage-from-artifactory.sh calls; the
# runner has them, macOS lacks sha256sum, so the script is exercised in here.
# g++ tests the example app's logic natively; MinGW-w64 cross-compiles the app
# itself to a Windows .exe, and zip packages it for install_build.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 python3-venv ca-certificates curl jq shellcheck \
        make g++ g++-mingw-w64-x86-64-posix binutils-mingw-w64-x86-64 zip unzip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# OpenTofu formats and validates the HCL that cdktn/ synthesizes. Pinned, and
# checked against the release's SHA256SUMS. The image is arm64 under Apple
# `container` and amd64 under Docker in CI, and dpkg names the arch as tofu does.
# Bumping it: new version, and both sums from tofu_<v>_SHA256SUMS.
ARG TOFU_VERSION=1.13.1
ARG TOFU_SHA256_AMD64=8ccbc6f8ee21d2827715f3c6e08a9b3e0209b1e62057c05067ef117e047c1a80
ARG TOFU_SHA256_ARM64=b9614df40575cc3fc10a8a25025b7245d961da279f715ea3efff4ddae8e6938a
RUN arch=$(dpkg --print-architecture) && \
    case "$arch" in \
        amd64) sum=$TOFU_SHA256_AMD64 ;; \
        arm64) sum=$TOFU_SHA256_ARM64 ;; \
        *) echo "no OpenTofu checksum for $arch" >&2; exit 1 ;; \
    esac && \
    zip=tofu_${TOFU_VERSION}_linux_${arch}.zip && \
    curl -fsSL -o /tmp/$zip https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/$zip && \
    echo "$sum  /tmp/$zip" | sha256sum -c - && \
    unzip -q /tmp/$zip tofu -d /usr/local/bin && \
    rm /tmp/$zip && \
    tofu version

# The harness's dependencies live in the image, not the checkout, so a Linux
# venv never lands in the working tree beside a macOS one. Changing
# harness/requirements*.txt means `make image` again.
COPY harness/requirements.txt harness/requirements-dev.txt /tmp/
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --quiet --upgrade pip && \
    /opt/venv/bin/pip install --quiet -r /tmp/requirements-dev.txt
ENV PATH=/opt/venv/bin:$PATH

CMD ["bash"]
