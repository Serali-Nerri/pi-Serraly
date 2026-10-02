import { join } from 'node:path';

export const isolatedTestEnv = {
  PI_OFFLINE: '1',
  PI_SKIP_VERSION_CHECK: '1',
  PI_TELEMETRY: '0',
  CI: '1',
} as const;

// Never expose ambient model credentials to integration fixtures or child CLIs.
const CREDENTIAL_ENV = /(?:API_KEY|TOKEN|PASSWORD|SECRET_ACCESS_KEY|CREDENTIALS|^AWS_|^AZURE_|^GOOGLE_|^ANTHROPIC_|^OPENAI_|^PI_API_KEY$|^PI_PROVIDER$|^PI_MODEL$)/i;

export function isolatedPiEnv(
  agentDir: string,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!CREDENTIAL_ENV.test(key)) env[key] = value;
  }
  return {
    ...env,
    ...isolatedTestEnv,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
    NPM_CONFIG_CACHE: join(agentDir, 'npm-cache'),
    ...overrides,
  };
}

/** Serial SDK fixtures need the process-global Pi directory isolated as well. */
export function isolatePiEnvironment(
  agentDir: string,
  overrides: NodeJS.ProcessEnv = {},
): () => void {
  const previous = { ...process.env };
  const next = isolatedPiEnv(agentDir, overrides);
  const changed = new Set([
    ...Object.keys(overrides),
    ...[...Object.keys(previous), ...Object.keys(next)].filter((key) => previous[key] !== next[key]),
  ]);
  for (const key of changed) {
    if (next[key] === undefined) delete process.env[key];
    else process.env[key] = next[key];
  }
  return () => {
    for (const key of changed) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}

const ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'g');

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

export function normalizeVolatile(value: string): string {
  return value
    .replace(/b[0-9a-f]{8}(?:[0-9a-f]{24})?/g, '<TASK_ID>')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<UUID>')
    .replace(/pid=?\s*\d+/gi, 'pid=<PID>')
    .replace(/\.pi\/tasks\/[^\s)]+/g, '.pi/tasks/<RUN>/<FILE>')
    .replace(/\/tmp\/[^\s)]+/g, '/tmp/<TEMP>');
}
