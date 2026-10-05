# Upstream attribution

This project derives its footer rendering, icons, project runtime detection, usage aggregation, and formatting helpers from **pi-open-tui 0.3.1**, distributed as `npm:pi-open-tui`.

- Repository: https://github.com/OldSuns/pi-open-tui
- Original directory: `extensions/open-tui/`
- Original files: `footer.ts`, `state.ts`, `runtime.ts`, `icons.ts`, and footer-related portions of `utils.ts`.
- License: MIT; the upstream copyright and license text are preserved in `LICENSE`.

The standalone footer view has its own lifecycle, fixed display constants, deployment, and tests. Git metadata uses porcelain v2. Usage caching is isolated by session manager; width fitting preserves segment positions and terminates when a segment cannot be shortened further.

The upstream npm package is not a runtime dependency. To bring in future changes, review the relevant upstream files and adapt them to the footer API boundary, then run `npm run verify`.
