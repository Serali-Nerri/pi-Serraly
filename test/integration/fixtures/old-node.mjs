/**
 * Force a below-baseline Node version for the entry-point gate probe. Preloaded
 * with `--import` so the real entry point still runs as the main module.
 */
Object.defineProperty(process.versions, "node", { value: "22.18.0", configurable: true });
