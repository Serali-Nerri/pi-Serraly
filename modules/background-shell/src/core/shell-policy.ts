import {
  resolveShellPolicy,
  type ResolvedShellPolicy,
  type ShellPolicySnapshot,
} from './common.js';

export interface ShellPolicyInitializationOptions {
  readonly platform?: NodeJS.Platform | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly activationCwd?: string | undefined;
}

/** Brief, non-secret bg_run description suffix from the actual spawn selection. */
export function shellPolicyDescription(policy: ShellPolicySnapshot): string {
  const args = [...policy.argvPrefix, policy.dialect === 'cmd' ? '"<command>"' : '<command>'];
  const syntax =
    policy.dialect === 'bash'
      ? 'Bash'
      : policy.dialect === 'posix'
        ? 'POSIX shell'
        : policy.dialect === 'cmd'
          ? 'Windows cmd.exe'
          : 'inherited shell (not classified as Bash or POSIX)';
  const login =
    (policy.dialect === 'bash' || policy.dialect === 'posix') &&
    policy.argvPrefix.length === 1 &&
    policy.argvPrefix[0] === '-c'
      ? ' No login-shell flag is requested.'
      : '';
  return ` Shell executable: ${JSON.stringify(policy.executable)}; args: ${JSON.stringify(args)}; command syntax: ${syntax}.${login}`;
}

/** Resolve once at extension activation; the returned object is deeply frozen. */
export function initializeShellPolicy(
  options: ShellPolicyInitializationOptions = {},
): ResolvedShellPolicy {
  return resolveShellPolicy(
    options.platform ?? process.platform,
    options.env ?? process.env,
    options.activationCwd ?? process.cwd(),
  );
}
