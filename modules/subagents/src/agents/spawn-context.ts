import { AsyncLocalStorage } from "node:async_hooks";

// Jiti loads fresh module generations for different cwd/reloads. Share only
// the async initialization guard, never session state or tool closures.
const key = Symbol.for("pi-serraly.subagents.spawn-context.v1");
const processState = globalThis as typeof globalThis & {
  [key: symbol]: AsyncLocalStorage<boolean> | undefined;
};
const context = processState[key] ??= new AsyncLocalStorage<boolean>();

export function runInSubagentContext<T>(operation: () => Promise<T>): Promise<T> {
  return context.run(true, operation);
}

export function isInsideSubagentSpawn(): boolean {
  return context.getStore() === true;
}
