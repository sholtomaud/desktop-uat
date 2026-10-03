# The host is not assumed to have Node or a matching Python. The CDK (npm, tsc,
# jest, cdk synth) and the harness (Python) run in here, driven by the Makefile.
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
        make g++ g++-mingw-w64-x86-64-posix binutils-mingw-w64-x86-64 zip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# The harness's dependencies live in the image, not the checkout, so a Linux
# venv never lands in the working tree beside a macOS one. Changing
# harness/requirements*.txt means `make image` again.
COPY harness/requirements.txt harness/requirements-dev.txt /tmp/
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --quiet --upgrade pip && \
    /opt/venv/bin/pip install --quiet -r /tmp/requirements-dev.txt
ENV PATH=/opt/venv/bin:$PATH

CMD ["bash"]
