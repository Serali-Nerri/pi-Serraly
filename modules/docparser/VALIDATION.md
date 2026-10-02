# Docparser validation

## Commands and baseline

Use the root-installed dependencies: Node >=22.19, Pi **1.0.0**, TypeBox **1.3.27**
and LiteParse **2.10.1**, including the platform optional binding. Do not install a
separate module dependency tree.

From the repository root:

```sh
npm run verify
# Module-only checks and debugging:
npm --prefix modules/docparser run verify
npm --prefix modules/docparser run check
npm --prefix modules/docparser run test:unit
npm --prefix modules/docparser run test:native
npm --prefix modules/docparser run test:package
npm --prefix modules/docparser run check:runtime
```

Module `check` preserves oxfmt, oxlint and strict TypeScript/JavaScript checks.
Module `verify` combines those checks, all unit/native/package tests and an
isolated factory import. Module-only commands do not replace root build, locked
runtime installation, legal closure or six-entry integration verification.

## What tests exercise

- Tool schemas, stable projected JSON, parse/search/screenshot limits and bounded
  previews/results, without prompt metadata or automatic companion-skill discovery.
- FIFO admission, queued/active cancellation, activation-only timeout, disposal,
  descendant cleanup and fail-closed behavior when teardown cannot be confirmed.
- Worker protocol framing, crash/startup containment, parse publication and
  search/screenshot/artifact budgets.
- Real OCR-off native parse/search/screenshot on the local one-page `Hello Pi` PDF.
- Actual Pi workspace discovery and compiled-factory loading through the host
  loader, with exactly three deferred tools and `/docparser:doctor`.
- Plain-JavaScript workers outside the development dependency tree, using a
  physically staged LiteParse/platform-binding dependency closure and no host
  package copies; missing worker/protocol/output files produce contained failures.

To exercise an assembled root runtime package:

```sh
PI_DOCPARSER_RUNTIME_ROOT=/absolute/runtime/package \
  npm --prefix modules/docparser run test:package
```

Tests copy the supplied tree before destructive missing-file cases. The ordinary
physical staging fixture checks worker layout and resolution; it does not by
itself prove that root's locked `npm ci` release installation is valid.

## Isolation

The module runner reconstructs the child environment with temporary HOME, Pi
agent/config/cache/tmp paths and an empty cwd. It uses synthetic/local fixtures,
not real credentials, settings, sessions or user documents. Native integration
calls disable OCR, so these checks do not download language data or contact OCR
servers. No model requests, deployment, dependency installation or system package
installation occurs. Doctor registration is tested; its optional installation
flow is not run. Processes/workers and temporary trees are cleaned up by their
owning fixtures and runner.

## Limits

These suites do not certify OCR quality/downloads/HTTP servers, LibreOffice or
real Office conversion, every native platform, the minimum Node version, or
global installation. Each requires a deliberate check in the target environment;
results on one OS/runtime do not establish another. Windows descendant cleanup
after an instantaneous native crash remains best effort, as documented in the
[README](README.md).

Report actual command results and platform limitations from the run being
submitted. This document describes coverage and commands, not pass counts or
manual certification. See [UPSTREAM](UPSTREAM.md) for provenance and the build
boundary, and the [root development guide](../../docs/development.md) for release
qualification.
