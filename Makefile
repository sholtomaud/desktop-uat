IMAGE_APP     := desktop-uat
NODE_VERSION  := $(shell cat .node-version)
WORKDIR       := /app

# Apple `container` locally. CI has Docker instead, and runs this same Makefile:
#   make check CONTAINER_BIN=docker START=true RESOURCES=
# (Docker's -c is CPU *shares*, not a CPU count, so the limits are Apple's only.)
CONTAINER_BIN ?= container
START         ?= $(CONTAINER_BIN) system start

# Apple `container` defaults to 1 GiB; aws-cdk-lib under ts-jest wants more.
MEMORY        := 4g
CPUS          := 4
RESOURCES     ?= -m $(MEMORY) -c $(CPUS)

RUN           := $(CONTAINER_BIN) run --rm --init $(RESOURCES) \
	-v $(shell pwd):$(WORKDIR) $(IMAGE_APP)
INFRA         := $(RUN) bash -c 'cd infra && $$0 "$$@"'
HARNESS       := $(RUN) bash -c 'cd harness && $$0 "$$@"'

# The FlaUI MCP server targets net8.0-windows. It builds anywhere with
# EnableWindowsTargeting; it only *runs* on the WorkSpaces Windows image.
# NuGet's cache is kept in the checkout (ignored) so a rebuild does not
# re-download every package.
DOTNET_IMAGE  := mcr.microsoft.com/dotnet/sdk:8.0
FLAUI_DIR     := image/flaui-mcp-server
DOTNET        := $(CONTAINER_BIN) run --rm --init $(RESOURCES) \
	-v $(shell pwd):$(WORKDIR) -w $(WORKDIR)/$(FLAUI_DIR) \
	-e NUGET_PACKAGES=$(WORKDIR)/.cache/nuget $(DOTNET_IMAGE)

# actionlint runs shellcheck over every `run:` block in the workflows too.
ACTIONLINT    := rhysd/actionlint:1.7.7

.PHONY: help start image install typecheck test-infra synth harness-validate \
        test-py lint flaui-build flaui-zip example-test example-build check clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-17s\033[0m %s\n", $$1, $$2}'

# --------------------------------------------------
# Container daemon and image
# --------------------------------------------------

start: ## Start the Apple container system daemon
	$(START)

image: start ## Build the dev image (node:$(NODE_VERSION)-bookworm-slim + Python 3.11 + harness deps)
	$(CONTAINER_BIN) build -f Containerfile -t $(IMAGE_APP) --build-arg NODE_VERSION=$(NODE_VERSION) .

# --------------------------------------------------
# infra/ — the CDK app
# --------------------------------------------------

# The touch is inside the container: under Docker (CI) the directory is root's,
# and a touch from the host is refused.
infra/node_modules: infra/package-lock.json
	$(INFRA) sh -c 'npm ci --no-audit --no-fund && touch node_modules'

install: start infra/node_modules ## npm ci for infra/, inside the container

typecheck: start infra/node_modules ## tsc --noEmit on the CDK app
	$(INFRA) npx tsc --noEmit

# In band: each jest worker loads all of aws-cdk-lib, and three of them in
# parallel are OOM-killed inside the container's 4 GiB.
test-infra: start infra/node_modules ## Jest: the stacks, their contracts with the scripts/harness, the janitor
	$(INFRA) npx jest --runInBand

# Offline: needs no AWS credentials. The one lookup the app makes (the region's
# availability zones) is answered from infra/cdk.context.json, which is committed.
synth: start infra/node_modules ## cdk synth all stacks into infra/cdk.out/
	$(INFRA) npx cdk synth --quiet

# --------------------------------------------------
# harness/ — the Python UAT harness
# --------------------------------------------------

harness-validate: start ## Validate every scenario in harness/scenarios/
	$(HARNESS) python -m uat_harness.cli validate --scenarios scenarios

# The harness against a fake desktop, and the workflow's scripts against a fake
# `aws` and a stub Artifactory. See pytest.ini, harness/tests/ and tests/.
test-py: start ## pytest: the harness and the workflow's shell scripts, all mocked
	$(RUN) python -m pytest -p no:cacheprovider

lint: start ## actionlint (+ shellcheck of run: blocks) and shellcheck of scripts/
	$(CONTAINER_BIN) run --rm -v $(shell pwd):/repo -w /repo $(ACTIONLINT) -no-color
	$(RUN) shellcheck scripts/*.sh

# --------------------------------------------------
# image/flaui-mcp-server — built here, run on Windows
# --------------------------------------------------

flaui-build: start ## Compile the FlaUI MCP server (Release, win-x64)
	$(DOTNET) dotnet build -c Release -p:EnableWindowsTargeting=true

flaui-zip: start ## Publish it self-contained to dist/flaui-mcp-server.zip, for Install-UatImage.ps1
	$(RUN) rm -rf dist/flaui-mcp-server dist/flaui-mcp-server.zip
	$(DOTNET) dotnet publish -c Release -p:EnableWindowsTargeting=true -o $(WORKDIR)/dist/flaui-mcp-server
	$(RUN) sh -c 'cd dist/flaui-mcp-server && zip -qr ../flaui-mcp-server.zip .'
	@echo "dist/flaui-mcp-server.zip"

# --------------------------------------------------
# example-app/ — UAT Demo, the Win32 app the worked scenario tests
#
# Its logic is tested natively; the app is cross-compiled with MinGW-w64 into a
# static .exe and zipped for install_build. The UI itself is only exercised on
# Windows: tests/windows/, in CI's `windows` job.
# --------------------------------------------------

example-test: start ## Unit tests for the example app's logic (native g++)
	$(RUN) make -C example-app test

example-build: start ## Cross-compile UAT Demo to dist/uat-demo-<version>.zip
	$(RUN) make -C example-app dist

# --------------------------------------------------
# Everything CI runs. Must pass before pushing.
# --------------------------------------------------

check: lint typecheck test-infra synth harness-validate test-py flaui-build example-test example-build ## Everything CI runs. Must pass before pushing

clean: ## Remove build output and dependencies
	rm -rf infra/node_modules infra/cdk.out dist .cache example-app/build \
		$(FLAUI_DIR)/bin $(FLAUI_DIR)/obj
