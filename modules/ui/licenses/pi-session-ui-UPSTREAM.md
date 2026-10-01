# Upstream attribution

This project derives its footer rendering, icons, project runtime detection, usage aggregation, and formatting helpers from **pi-open-tui 0.3.1**, distributed as `npm:pi-open-tui`.

- Repository: https://github.com/OldSuns/pi-open-tui
- Original directory: `extensions/open-tui/`
- Original files: `footer.ts`, `state.ts`, `runtime.ts`, `icons.ts`, and footer-related portions of `utils.ts`.
- License: MIT; the upstream copyright and license text are preserved in `LICENSE`.

The startup header in `src/header.ts` derives from **pi-open-tui 0.3.3**, specifically `extensions/open-tui/header.ts` and its layout and command-tip helpers in `utils.ts`. It preserves the rounded panel, settled Pi logo, theme colors, model and directory labels, and responsive command column. Four tips are sampled from available commands; the built-in command pool includes Pi 0.85.0's `/thinking`, and the compact version label is clipped to the terminal width. Pi supplies the running version and current session metadata through its public API.

The standalone extension has its own lifecycle, fixed display constants, deployment, and tests. Git metadata uses porcelain v2. Usage caching is isolated by session manager; width fitting preserves segment positions and terminates when a segment cannot be shortened further.

The upstream npm package is not a runtime dependency. To bring in future changes, review the relevant upstream files and adapt them to the header and footer API boundaries, then run `npm run verify`.
