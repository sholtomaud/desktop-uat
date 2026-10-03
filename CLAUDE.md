# CLAUDE.md

**[AGENTS.md](AGENTS.md) is the canonical standard for this repository. Read it first.**

Everything there applies to Claude Code. This file deliberately does **not** restate
it: two copies of a standard drift apart, and then neither can be trusted. Add new
standards to `AGENTS.md`, not here.

## The rules broken most often

1. **The host has no Node.** `node` and `npm` are not installed here. Every command
   goes through `make` and the Apple `container` images. Do not reach for `npx`, a
   local venv, or `dotnet` directly.
2. **Test first, against the fakes.** Nothing here can call AWS. The fakes, and what
   each one stands in for, are listed in [AGENTS.md §5](AGENTS.md#5-what-is-mocked-and-what-is-not-tested-at-all).
   When a change makes a new outside call, update the fake in the same PR.
3. **A contract has two sides.** SSM parameter names, the runner env file, runner
   labels, IAM grants, FlaUI tool replies: change both sides in the same PR. See
   [AGENTS.md §6](AGENTS.md#6-the-contracts-between-the-parts).
4. **Run `make check` before every push**, on the branch the PR will carry.
5. **Push *and* open a PR. Do not merge your own.** A task is done when it is merged.

## The workflow

Logic lives in `scripts/`, where it is tested, not in `run:` blocks. Event data enters
through `env:` and never as `${{ }}` inside a script.
