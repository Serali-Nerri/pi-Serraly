# Imagegen upstream

## Fixed source

- Repository: https://github.com/IgorWarzocha/howaboua-pi-stuff
- Package: `packages/pi-codex-imagegen`, version **0.0.11**.
- Imported commit: `d7564b7fc903590fd8d08b587cce2bb4707e4eef`.
- `index.ts` and `src/` retain upstream relative paths. There is one executable
  copy, no nested Git repository, submodule, duplicate pristine tree, or automatic
  package download at runtime.
- Upstream `LICENSE` (MIT, Igor Warzocha) is retained verbatim. The OpenAI Codex
  reference is `b545c94041017d000e2c8b2f6272705d21b85dfb`; its retained Apache-2.0
  text is `licenses/openai-codex-Apache-2.0.txt`. No Rust source is bundled.

## Local differences

- Workspace packaging: private `pi-codex-imagegen`, strict TypeScript, sealed ESM
  bundle, exact development dependencies, repository test/release tools. Pi peers
  remain external; undici and proxy-from-env are bundled with their license texts.
- `src/openai.ts` owns OpenAI model selection, registry authentication and the
  Responses image tool adapter. API Key Images requests reuse upstream execution.
  Entry wiring prefers this route before requesting PCC's legacy resolver.
- Small changes in `src/execute.ts`, `src/codex-runtime/types.ts` and
  `src/codex-runtime/headers.ts` carry OpenAI route metadata and headers.
  `src/codex-runtime/config.ts` also accepts a provider-only model mapping lookup.
  The HTTP transport drops provider credentials on cross-origin redirects and
  passes header tuples to undici's typed fetch boundary.
- `src/pcc.ts` implements the optional versioned Code Mode registration protocol
  from `packages/pi-codex-conversion/src/code-mode-extension-tools.ts` at the same
  pinned repository revision (MIT, Igor Warzocha). It dispatches through Pi's
  nested executor, preserving admission and hooks without bundling PCC or
  resolving a peer from outside the immutable release. The native `imagegen`
  name is reserved by this projection and the result uses upstream's image mapper.
- Upstream image request validation, history selection, artifacts and renderers
  are retained. The upstream package update popup is not registered: local
  distribution and provenance are owned by this workspace, not its npm package.
  PCC uses the tool description and image projection usage rather than importing
  its optional model-specific prompt-mode helpers.
- Tests cover the registered tool and local auth/transport behavior using isolated
  fixtures, plus the existing real-host release/packed-package seams. They do not
  duplicate the host's OAuth implementation or upstream image codec algorithms.

## Following upstream

Use a temporary clone, not the installed npm tree. Fetch and inspect a chosen
upstream revision, then compare only this package from the pin above:

```sh
git -C /tmp/howaboua-pi-stuff fetch origin
git -C /tmp/howaboua-pi-stuff diff \
  d7564b7fc903590fd8d08b587cce2bb4707e4eef <new-revision> \
  -- packages/pi-codex-imagegen
```

Apply reviewed source changes at matching local paths. Keep workspace manifests,
README, provenance, tests, `src/openai.ts` and `src/pcc.ts` local; explicitly
reconcile the entry and transport changes listed above. Review dependency/license
changes before updating the exact pins and lock. Record the new imported revision here
and in root `UPSTREAM.md`, update this difference list to the current contract,
then run focused tests and one `npm run verify`. Do not overwrite the local tree
from an npm install or turn the fixed-source record into an update log.
