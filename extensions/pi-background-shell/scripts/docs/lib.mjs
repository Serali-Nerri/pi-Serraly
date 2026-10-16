import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const MANIFEST_SCHEMA_VERSION = 'pi-background-shell.docs-manifest.v1';
export const TOOL_NAMES = ['bg_kill', 'bg_logs', 'bg_run', 'bg_status'];
export const COMMAND_NAMES = ['bg', 'bg-clear', 'bg-tasks', 'jobs', 'kill', 'logs', 'tasks'];
export const HOST_PEERS = [ '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'];
export const SOURCE_OWNERS = {
  'extensions/background-tasks.ts': 'docs/subsystems/extension-lifecycle.md',
  'src/extension.ts': 'docs/subsystems/extension-lifecycle.md',
  'src/core/common.ts': 'docs/subsystems/background-task-runtime.md',
  'src/core/config.ts': 'docs/operations/configuration.md',
  'src/core/durable-fs.ts': 'docs/subsystems/background-task-runtime.md',
  'src/core/extension-api.ts': 'docs/api/eventbus-v2.md',
  'src/core/lazy-module.ts': 'docs/subsystems/extension-lifecycle.md',
  'src/core/registry.ts': 'docs/subsystems/background-task-runtime.md',
  'src/core/reload-shell-owner.ts': 'docs/subsystems/background-task-runtime.md',
  'src/core/shell-policy.ts': 'docs/operations/configuration.md',
  'src/core/task-durable.ts': 'docs/subsystems/background-task-runtime.md',
  'src/core/windows-taskkill.ts': 'docs/subsystems/background-task-runtime.md',
  'src/ui/background-tasks-manager.ts': 'docs/reference/shortcuts-and-dock.md',
  'src/ui/task-log-viewport.ts': 'docs/reference/shortcuts-and-dock.md',
  'src/ui/tool-cards.ts': 'docs/subsystems/extension-lifecycle.md',
};
const AUTHORED_DOCS = [
  'docs/api/eventbus-v2.md', 'docs/commands/bg.md', 'docs/commands/bg-clear.md',
  'docs/commands/jobs.md', 'docs/commands/logs.md', 'docs/commands/kill.md',
  'docs/commands/task-manager.md', 'docs/concepts/completion-delivery.md',
  'docs/getting-started.md', 'docs/operations/configuration.md',
  'docs/reference/shortcuts-and-dock.md', 'docs/subsystems/background-task-runtime.md',
  'docs/subsystems/extension-lifecycle.md', 'docs/subsystems/docs-freshness-gate.md',
];
const GENERATED_DOCS = [
  'docs/INDEX.md', 'docs/read-before-edit.md', 'docs/reference/runtime-contracts.md',
  ...TOOL_NAMES.map((name) => `docs/tools/${name}.md`), 'docs/manifest.json',
];
export const SHELL_SUFFIX_RULE = 'BG_RUN_DESCRIPTION + shellPolicyDescription(shellPolicy): append the activation-selected executable, argv and command syntax; never extract a local shell path or execute extension code.';

export class DocsGateError extends Error {
  constructor(message) { super(message); this.name = 'DocsGateError'; }
}
function check(condition, message) { if (!condition) throw new DocsGateError(message); }
export function sha256(text) { return createHash('sha256').update(text).digest('hex'); }
const posixPath = (path) => path.split(sep).join('/');
const read = (root, path) => readFileSync(join(root, path), 'utf8');
const json = (root, path) => JSON.parse(read(root, path));
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
function sortedSame(actual, expected, label) {
  check(JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()), `${label}: expected ${[...expected].sort().join(', ')}; got ${[...actual].sort().join(', ')}`);
}
export function walkFiles(root, dir) {
  if (!existsSync(join(root, dir))) return [];
  return readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walkFiles(root, path) : [path];
  });
}
function sourceFile(root, path) {
  const sf = ts.createSourceFile(path, read(root, path), ts.ScriptTarget.Latest, true, path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  check(sf.parseDiagnostics.length === 0, `${path}: TypeScript syntax error`);
  return sf;
}
function visit(node, fn) { fn(node); ts.forEachChild(node, (child) => visit(child, fn)); }
function at(sf, node) { return `${sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`; }
function unwrap(node) {
  while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node))) node = node.expression;
  return node;
}
function properties(node, sf) {
  node = unwrap(node);
  check(node && ts.isObjectLiteralExpression(node), `${sf.fileName}: expected explicit object literal`);
  const out = new Map();
  for (const prop of node.properties) {
    check(ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop), `${at(sf, prop)}: public metadata must not use spread or shorthand`);
    check(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name), `${at(sf, prop)}: computed public property unsupported`);
    const key = prop.name.text;
    check(!out.has(key), `${at(sf, prop)}: duplicate property ${key}`);
    out.set(key, prop.initializer ?? prop);
  }
  return out;
}
function declarations(sf) {
  const out = new Map();
  for (const stmt of sf.statements) if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) if (ts.isIdentifier(decl.name)) out.set(decl.name.text, decl.initializer);
  }
  return out;
}
// Small data-only grammar. This does NOT import/evaluate the extension or consult process.env.
function literal(node, sf, constants = new Map(), seen = new Set()) {
  node = unwrap(node);
  check(node, `${sf.fileName}: missing static value`);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((item) => literal(item, sf, constants, seen));
  if (ts.isIdentifier(node) && constants.has(node.text)) {
    check(!seen.has(node.text), `${at(sf, node)}: cyclic constant`);
    return literal(constants.get(node.text), sf, constants, new Set([...seen, node.text]));
  }
  if (ts.isBinaryExpression(node)) {
    const left = literal(node.left, sf, constants, seen), right = literal(node.right, sf, constants, seen);
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
    if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken && typeof left === 'number' && typeof right === 'number') return left * right;
  }
  if (ts.isCallExpression(node) && node.expression.getText(sf) === 'Object.freeze' && node.arguments.length === 1) return literal(node.arguments[0], sf, constants, seen);
  if (ts.isCallExpression(node) && node.expression.getText(sf) === 'Math.min') {
    const values = node.arguments.map((arg) => literal(arg, sf, constants, seen));
    check(values.every((v) => typeof v === 'number'), `${at(sf, node)}: Math.min expects numeric literals`);
    return Math.min(...values);
  }
  if (ts.isCallExpression(node) && node.expression.getText(sf) === 'formatSize' && node.arguments.length === 1) {
    const bytes = literal(node.arguments[0], sf, constants, seen);
    check(typeof bytes === 'number', `${at(sf, node)}: formatSize expects numeric constant`);
    return bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => String(literal(span.expression, sf, constants, seen)) + span.literal.text).join('');
  }
  throw new DocsGateError(`${at(sf, node)}: unsupported static expression: ${node.getText(sf).slice(0, 100)}`);
}
function dataObject(node, sf, constants) {
  return Object.fromEntries([...properties(node, sf)].map(([key, value]) => [key, literal(value, sf, constants)]));
}
function schema(node, sf, constants) {
  node = unwrap(node);
  if (ts.isIdentifier(node) && constants.has(node.text)) return schema(constants.get(node.text), sf, constants);
  check(ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(sf) === 'Type', `${at(sf, node)}: unsupported schema expression`);
  const method = node.expression.name.text;
  if (method === 'Optional') return { ...schema(node.arguments[0], sf, constants), optional: true };
  if (method === 'Object') {
    const props = [...properties(node.arguments[0], sf)].map(([key, value]) => [key, schema(value, sf, constants)]);
    const required = props.filter(([, value]) => !value.optional).map(([key]) => key);
    return { type: 'object', properties: Object.fromEntries(props.map(([key, value]) => [key, Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'optional'))])), ...(required.length ? { required } : {}), ...(node.arguments[1] ? dataObject(node.arguments[1], sf, constants) : {}) };
  }
  check(['String', 'Number', 'Boolean'].includes(method), `${at(sf, node)}: unsupported Type.${method}`);
  return { type: method.toLowerCase(), ...(node.arguments[0] ? dataObject(node.arguments[0], sf, constants) : {}) };
}

export function extractRegistrations(text, { logConstants = {} } = {}) {
  const sf = ts.createSourceFile('src/extension.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  check(sf.parseDiagnostics.length === 0, 'src/extension.ts: syntax error');
  const constants = declarations(sf);
  for (const [key, value] of Object.entries(logConstants)) constants.set(key, ts.factory.createNumericLiteral(value));
  const entry = sf.statements.find((stmt) => ts.isFunctionDeclaration(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
  check(entry?.body && entry.parameters[0]?.name.getText(sf) === 'pi', 'extension default export must have direct identifier Pi parameter');
  const out = { tools: [], commands: [], shortcuts: [], renderers: [] };
  const seen = new Set();
  for (const [name, module] of [['Type', 'typebox'], ['formatSize', '@earendil-works/pi-coding-agent']]) {
    check(sf.statements.some((stmt) => ts.isImportDeclaration(stmt) && stmt.moduleSpecifier.text === module && stmt.importClause?.namedBindings?.elements?.some((spec) => spec.name.text === name && !spec.propertyName && !spec.isTypeOnly)), `${name} must be the direct ${module} import`);
  }
  for (const [name, initializer] of [['config', 'parseBackgroundTasksConfig()'], ['shellPolicy', 'initializeShellPolicy()']]) {
    check(entry.body.statements.some((stmt) => ts.isVariableStatement(stmt) && (stmt.declarationList.flags & ts.NodeFlags.Const) && stmt.declarationList.declarations.some((decl) => decl.name.getText(sf) === name && decl.initializer?.getText(sf) === initializer)), `${name} must be the direct activation const ${initializer}`);
  }
  visit(sf, (node) => {
    if (ts.isPropertyAssignment(node) && ['promptSnippet', 'promptGuidelines'].includes(node.name.getText(sf).replaceAll("'", '').replaceAll('"', ''))) throw new DocsGateError(`${at(sf, node)}: tools must be description-only`);
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) && node.name && ['Type', 'formatSize', 'shellPolicyDescription', 'BG_RUN_DESCRIPTION'].includes(node.name.getText(sf))) {
      const baseDeclaration = ts.isVariableDeclaration(node) && node.name.getText(sf) === 'BG_RUN_DESCRIPTION' && node.parent.parent.parent === sf && (node.parent.flags & ts.NodeFlags.Const);
      check(baseDeclaration, `${at(sf, node)}: controlled description/schema binding shadowed`);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && unwrap(node.initializer).getText(sf) === 'pi') throw new DocsGateError(`${at(sf, node)}: registration host alias unsupported`);
    if (ts.isElementAccessExpression(node) && node.expression.getText(sf) === 'pi') throw new DocsGateError(`${at(sf, node)}: computed Pi access unsupported`);
    if (!ts.isPropertyAccessExpression(node) || !/^register(?:Tool|Command|Shortcut|MessageRenderer|Provider)$/.test(node.name.text)) return;
    check(ts.isCallExpression(node.parent) && node.parent.expression === node && node.expression.getText(sf) === 'pi', `${at(sf, node)}: registration must be a direct Pi call`);
    const call = node.parent, method = node.name.text;
    check(method !== 'registerProvider', `${at(sf, node)}: provider registration removed`);
    const statement = call.parent;
    check(ts.isExpressionStatement(statement), `${at(sf, node)}: nested registration unsupported`);
    let availability = 'always';
    if (statement.parent !== entry.body) {
      const branch = statement.parent.parent;
      check(method === 'registerShortcut' && ts.isBlock(statement.parent) && ts.isIfStatement(branch) && branch.thenStatement === statement.parent && !branch.elseStatement && branch.parent === entry.body, `${at(sf, node)}: conditional/nested public registration unsupported`);
      const match = /^config\.dockShortcut === ['"](shift\+down|ctrl\+alt\+b)['"]$/.exec(branch.expression.getText(sf));
      check(match, `${at(sf, node)}: unsupported shortcut condition`);
      availability = `dock:${match[1]}`;
    }
    if (method === 'registerTool') {
      const props = properties(call.arguments[0], sf);
      const name = literal(props.get('name'), sf, constants);
      const descriptionNode = unwrap(props.get('description'));
      let description, description_suffix;
      if (name === 'bg_run') {
        const base = constants.get('BG_RUN_DESCRIPTION');
        check(base && (ts.isStringLiteral(unwrap(base)) || ts.isNoSubstitutionTemplateLiteral(unwrap(base))), 'BG_RUN_DESCRIPTION must be a static literal');
        check(sf.statements.some((stmt) => ts.isVariableStatement(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && stmt.declarationList.declarations.some((decl) => decl.name.getText(sf) === 'BG_RUN_DESCRIPTION')), 'BG_RUN_DESCRIPTION must be exported');
        check(descriptionNode?.getText(sf) === 'BG_RUN_DESCRIPTION + shellPolicyDescription(shellPolicy)', 'bg_run description must use the controlled base + shellPolicyDescription(shellPolicy) combination');
        check(sf.statements.some((stmt) => ts.isImportDeclaration(stmt) && stmt.moduleSpecifier.text === './core/shell-policy.js' && stmt.importClause?.namedBindings?.elements?.some((spec) => spec.name.text === 'shellPolicyDescription' && !spec.propertyName)), 'shellPolicyDescription must be the direct shell-policy import');
        description = literal(base, sf, constants);
        description_suffix = SHELL_SUFFIX_RULE;
      } else description = literal(descriptionNode, sf, constants);
      check(typeof name === 'string' && typeof description === 'string', `${at(sf, call)}: name/description must be strings`);
      const tool = { id: `tool:${name}`, name, label: literal(props.get('label'), sf, constants), description, ...(description_suffix ? { description_suffix } : {}), parameters: schema(props.get('parameters'), sf, constants), availability, source: at(sf, call) };
      out.tools.push(tool);
    } else {
      const name = literal(call.arguments[0], sf, constants);
      const kind = { registerCommand: 'command', registerShortcut: 'shortcut', registerMessageRenderer: 'renderer' }[method];
      const record = { id: `${kind}:${name}`, name, availability, source: at(sf, call) };
      if (method !== 'registerMessageRenderer') {
        const props = properties(call.arguments[1], sf);
        record.description = literal(props.get('description'), sf, constants);
        check(typeof record.description === 'string', `${at(sf, call)}: description must be a string`);
      }
      if (availability !== 'always') check(availability === `dock:${name}`, `${at(sf, call)}: shortcut key/condition mismatch`);
      out[{ command: 'commands', shortcut: 'shortcuts', renderer: 'renderers' }[kind]].push(record);
    }
    // Independently check the newly extracted id (array insertion order is not global).
    const id = method === 'registerTool' ? out.tools.at(-1).id : `${{ registerCommand: 'command', registerShortcut: 'shortcut', registerMessageRenderer: 'renderer' }[method]}:${literal(call.arguments[0], sf, constants)}`;
    check(!seen.has(id), `${at(sf, call)}: duplicate public registration ${id}`);
    seen.add(id);
  });
  visit(sf, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 'pi.on') {
      const event = literal(node.arguments[0], sf, constants);
      check(['session_start', 'session_shutdown'].includes(event), `${at(sf, node)}: unsupported lifecycle/system prompt injection hook ${event}`);
    }
  });
  for (const values of Object.values(out)) values.sort((a, b) => a.id < b.id ? -1 : 1);
  return out;
}

export function checkManifest(pkg) {
  check(pkg.private === true, 'module must remain private');
  check(pkg.name === 'pi-background-shell', 'fork package identity must be pi-background-shell');
  check(/^\d+\.\d+\.\d+$/.test(pkg.version), 'package version must be a concrete semantic version');
  sortedSame(pkg.pi?.extensions ?? [], ['./dist/extensions/background-tasks.js'], 'manifest compiled entry');
  check(pkg.type === 'module' && pkg.license === 'ISC' && pkg.engines?.node === '>=22.19.0', 'package module/license/Node contract drift');
  sortedSame(pkg.files ?? [], ['dist/', 'extensions/', 'src/', 'README.md', 'TESTING.md', 'LICENSE', 'UPSTREAM.md', 'CHANGELOG.md', 'docs/'], 'package files');
  check(Object.keys(pkg.dependencies ?? {}).length === 0 && !pkg.bundledDependencies && !pkg.bundleDependencies, 'no private runtime dependencies/bundled host peers');
  sortedSame(Object.keys(pkg.peerDependencies ?? {}), HOST_PEERS, 'host peers');
  for (const peer of HOST_PEERS) {
    check(pkg.peerDependencies[peer] === '*', `${peer} must be host-provided peer '*'`);
    check(pkg.devDependencies[peer] === (peer === 'typebox' ? '1.3.27' : '1.3.0'), `${peer} verified dev version drift`);
  }
}
function interfaceFields(sf, name) {
  const node = sf.statements.find((stmt) => ts.isInterfaceDeclaration(stmt) && stmt.name.text === name);
  check(node, `${sf.fileName}: missing interface ${name}`);
  return node.members.map((member) => {
    check(ts.isPropertySignature(member) && ts.isIdentifier(member.name), `${at(sf, member)}: unsupported interface field`);
    return { name: member.name.text, type: member.type.getText(sf), required: !member.questionToken };
  });
}
function eventBus(root) {
  const sf = sourceFile(root, 'src/core/extension-api.ts'), constants = declarations(sf);
  const names = ['BG_REQUEST_CHANNEL', 'BG_RESPONSE_CHANNEL', 'BG_TERMINAL_CHANNEL', 'BG_REQUEST_SCHEMA', 'BG_RESPONSE_SCHEMA', 'BG_TERMINAL_SCHEMA'];
  const expected = ['pi-background-shell:request:v2', 'pi-background-shell:response:v2', 'pi-background-shell:terminal:v2', 'pi-background-shell.extension-request.v2', 'pi-background-shell.extension-response.v2', 'pi-background-shell.extension-terminal.v2'];
  const channels = Object.fromEntries(names.map((name, i) => {
    const value = literal(constants.get(name), sf, constants);
    check(value === expected[i], `${name} must use fork v2 identity`);
    return [name, value];
  }));
  const capabilities = interfaceFields(sf, 'BackgroundTaskExtensionCapabilities');
  check(capabilities.find((field) => field.name === 'api_version')?.type === '2', 'EventBus api_version must be 2');
  check(!capabilities.some((field) => field.name === 'run_is_agent'), 'EventBus run_is_agent removed');
  const capNode = unwrap(constants.get('BG_EXTENSION_CAPABILITIES'));
  check(ts.isCallExpression(capNode) && capNode.expression.getText(sf) === 'Object.freeze', 'capabilities must be immutable literal');
  const capValues = dataObject(capNode.arguments[0], sf, constants);
  check(capValues.api_version === 2 && !Object.hasOwn(capValues, 'run_is_agent'), 'capabilities literal must be v2');
  const run = interfaceFields(sf, 'BackgroundTaskExtensionRunPayload');
  sortedSame(run.filter((field) => field.required).map((field) => field.name), ['name', 'command', 'notifyOnCompletion', 'triggerOnCompletion'], 'EventBus run required fields');
  sortedSame(run.filter((field) => !field.required).map((field) => field.name), ['timeoutSeconds'], 'EventBus run optional fields');
  const parser = sf.statements.find((stmt) => ts.isFunctionDeclaration(stmt) && stmt.name?.text === 'parseRunPayload');
  check(parser, 'EventBus run parser missing');
  let closed;
  visit(parser, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 'assertClosed') closed = literal(node.arguments[1], sf, constants);
  });
  sortedSame(closed ?? [], run.map((field) => field.name), 'EventBus closed run validator/interface');
  return { ...channels, capabilities: capValues, run };
}
export function extractCodeFacts({ packageRoot = PACKAGE_ROOT } = {}) {
  const pkg = json(packageRoot, 'package.json');
  checkManifest(pkg);
  const sources = [...walkFiles(packageRoot, 'src'), ...walkFiles(packageRoot, 'extensions')].sort();
  sortedSame(sources, Object.keys(SOURCE_OWNERS), 'pure shell source inventory');
  check(read(packageRoot, 'extensions/background-tasks.ts').trim() === "export { default } from '../src/extension.js';", 'source entry must reexport src/extension.ts');
  const common = sourceFile(packageRoot, 'src/core/common.ts'), constants = declarations(common);
  // Pi 1.3.0's exported DEFAULT_MAX_BYTES is 50 * 1024. Data-only extraction;
  // actual registered schema parity is additionally tested against the host.
  constants.set('DEFAULT_MAX_BYTES', ts.factory.createNumericLiteral(50 * 1024));
  const logConstants = Object.fromEntries(['MAX_LOG_BYTES', 'DEFAULT_LOG_BYTES'].map((name) => [name, literal(constants.get(name), common, constants)]));
  const maxTimeoutSeconds = literal(constants.get('MAX_TIMEOUT_SECONDS'), common, constants);
  const public_surfaces = extractRegistrations(read(packageRoot, 'src/extension.ts'), {
    logConstants: { ...logConstants, MAX_TIMEOUT_SECONDS: maxTimeoutSeconds },
  });
  sortedSame(public_surfaces.tools.map((tool) => tool.name), TOOL_NAMES, 'four shell tools');
  sortedSame(public_surfaces.commands.map((cmd) => cmd.name), COMMAND_NAMES, 'seven shell commands');
  sortedSame(public_surfaces.shortcuts.map((item) => item.name), ['shift+down', 'ctrl+alt+b', 'ctrl+alt+c'], 'dock/clear shortcuts');
  sortedSame(public_surfaces.renderers.map((item) => item.name), ['background-task-notification'], 'completion renderer');
  const run = public_surfaces.tools.find((tool) => tool.name === 'bg_run');
  sortedSame(Object.keys(run.parameters.properties), ['name', 'command', 'description', 'timeoutSeconds', 'notifyOnCompletion', 'triggerOnCompletion', 'surviveReload'], 'bg_run fields');
  sortedSame(run.parameters.required, ['name', 'command'], 'bg_run required fields');
  check(run.parameters.additionalProperties === false, 'bg_run must reject unknown/removed arguments');
  const cfg = sourceFile(packageRoot, 'src/core/config.ts'), cfgConsts = declarations(cfg);
  const dock = literal(cfgConsts.get('PI_BG_DOCK_SHORTCUT_VALUES'), cfg, cfgConsts);
  sortedSame(dock, ['shift+down', 'ctrl+alt+b', 'off'], 'dock config values');
  check(literal(cfgConsts.get('PI_BG_DEFAULT_DOCK_SHORTCUT'), cfg, cfgConsts) === 'shift+down', 'dock default drift');
  const statuses = literal(constants.get('TASK_STATUS_VALUES'), common, constants);
  sortedSame(statuses, ['running', 'completed', 'failed', 'killed'], 'task states');
  const environment = new Set();
  for (const path of sources) visit(sourceFile(packageRoot, path), (node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^(PI_BG_[A-Z_]+|SHELL|ComSpec|PATH|Path|path|SystemRoot|WINDIR)$/.test(node.text)) environment.add(node.text);
    if (ts.isPropertySignature(node) && node.name.getText() === 'isAgent') throw new DocsGateError(`${path}: removed isAgent task field`);
  });
  const owner = sourceFile(packageRoot, 'src/core/reload-shell-owner.ts');
  check(literal(declarations(owner).get('RELOAD_SHELL_OWNER_PROTOCOL'), owner) === 'pi-background-shell.reload-shell-owner.v1', 'reload owner fork identity drift');
  check(read(packageRoot, 'src/core/common.ts').includes("schemaVersion: 'pi-background-shell.reload-shell.v1'"), 'reload audit fork identity drift');
  return {
    package: { name: pkg.name, version: pkg.version, entry: pkg.pi.extensions[0], node: pkg.engines.node, verified_host: '1.3.0', typebox: '1.3.27' },
    public_surfaces,
    public_surface_ids: Object.values(public_surfaces).flat().map((item) => item.id).sort(),
    eventbus: eventBus(packageRoot),
    contracts: { statuses, log_bytes: logConstants, max_timeout_seconds: maxTimeoutSeconds, dock_shortcuts: dock, default_dock_shortcut: 'shift+down', environment: [...environment].sort(), reload_owner: 'pi-background-shell.reload-shell-owner.v1', reload_audit: 'pi-background-shell.reload-shell.v1' },
    governed_sources: sources.map((path) => ({ path, owner: SOURCE_OWNERS[path], sha256: sha256(read(packageRoot, path)) })),
  };
}

export function loadDocsModel({ packageRoot = PACKAGE_ROOT } = {}) {
  const paths = walkFiles(packageRoot, 'docs');
  for (const path of paths) check([...AUTHORED_DOCS, ...GENERATED_DOCS].includes(path), `unknown/retired documentation artifact ${path}`);
  sortedSame(paths.filter((path) => !GENERATED_DOCS.includes(path)), AUTHORED_DOCS, 'authored shell documentation inventory');
  const docs = paths.filter((path) => AUTHORED_DOCS.includes(path)).map((path) => {
    const text = read(packageRoot, path), match = /^---\n([\s\S]*?)\n---\n/.exec(text);
    check(match, `${path}: missing JSON frontmatter`);
    let fm;
    try { fm = JSON.parse(match[1]); } catch { throw new DocsGateError(`${path}: malformed JSON frontmatter`); }
    check(fm.doc_id === path.slice(5, -3) && Array.isArray(fm.covers_sources) && Array.isArray(fm.covers_surfaces), `${path}: invalid ownership metadata`);
    return { path, frontmatter: fm, body: text.slice(match[0].length), sha256: sha256(text) };
  });
  return { docs, root_docs: ['README.md', 'TESTING.md', 'UPSTREAM.md', 'CHANGELOG.md'].map((path) => ({ path, sha256: sha256(read(packageRoot, path)) })) };
}
export function assertCoverage(facts, model) {
  const sourceCounts = new Map(), surfaceCounts = new Map();
  for (const doc of model.docs) {
    for (const path of doc.frontmatter.covers_sources) {
      check(SOURCE_OWNERS[path] === doc.path, `${doc.path}: unknown/wrong source owner ${path}`);
      sourceCounts.set(path, (sourceCounts.get(path) ?? 0) + 1);
    }
    for (const id of doc.frontmatter.covers_surfaces) {
      check(facts.public_surface_ids.includes(id), `${doc.path}: unknown public surface ${id}`);
      surfaceCounts.set(id, (surfaceCounts.get(id) ?? 0) + 1);
    }
  }
  for (const { path } of facts.governed_sources) check(sourceCounts.get(path) === 1, `missing/duplicate primary source owner ${path}`);
  for (const id of facts.public_surface_ids.filter((id) => !id.startsWith('tool:'))) check(surfaceCounts.get(id) === 1, `missing/duplicate primary surface owner ${id}`);
}
const banner = '<!-- Generated by scripts/docs/generate.mjs; do not edit. -->\n';
const table = (headers, rows) => `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map((row) => `| ${row.map((cell) => String(cell).replaceAll('|', '\\|').replaceAll('\n', ' ')).join(' | ')} |`).join('\n')}\n`;
export function generateDocTexts(facts, model) {
  const output = {};
  for (const tool of facts.public_surfaces.tools) {
    output[`docs/tools/${tool.name}.md`] = `${banner}# ${tool.name}\n\n${tool.description}\n\n${tool.description_suffix ? `**Dynamic shell suffix:** ${tool.description_suffix}\n\nThe suffix describes the actual spawn policy; it is not a system-prompt hook.\n\n` : ''}${table(['Parameter', 'Required', 'Type', 'Description'], Object.entries(tool.parameters.properties).map(([key, prop]) => [`\`${key}\``, (tool.parameters.required ?? []).includes(key) ? 'yes' : 'no', prop.type, prop.description ?? '']))}\n## Extracted JSON schema\n\n\`\`\`json\n${pretty(tool.parameters)}\`\`\`\n\nSource: \`${tool.source}\`. See [runtime](../subsystems/background-task-runtime.md) and [completion delivery](../concepts/completion-delivery.md).\n`;
  }
  const inventory = [...model.docs.map((doc) => doc.path), ...Object.keys(output), 'docs/read-before-edit.md', 'docs/reference/runtime-contracts.md'].sort();
  output['docs/INDEX.md'] = `${banner}# Background shell documentation\n\nLocal fork \`${facts.package.name}@${facts.package.version}\`; verified host Pi ${facts.package.verified_host} only.\n\n${inventory.map((path) => `- [${path.slice(5, -3)}](${path.slice(5)})`).join('\n')}\n\n## Public registrations\n\n${table(['Surface', 'Availability', 'Source'], Object.values(facts.public_surfaces).flat().map((item) => [`\`${item.id}\``, item.availability, `\`${item.source}\``]))}\nDock \`off\` registers no dock shortcut; tools and commands remain available.\n`;
  output['docs/read-before-edit.md'] = `${banner}# Read before editing\n\nRead the source owner's page and the relevant generated tool schema before changing runtime contracts. Regenerate after reviewing source/prose changes; byte freshness is not semantic certification. No archived attestation receipts are used.\n\n${table(['Source', 'Primary documentation'], facts.governed_sources.map(({ path, owner }) => [`\`${path}\``, `[${owner.slice(5, -3)}](${owner.slice(5)})`]))}\nRun \`npm run docs:generate\`, \`npm run docs:verify\`, \`npm run test:docs\`, and the targeted runtime tests. See [gate design](subsystems/docs-freshness-gate.md).\n`;
  output['docs/reference/runtime-contracts.md'] = `${banner}# Extracted runtime contracts\n\nThese are source facts, not an environment snapshot. Only Pi ${facts.package.verified_host} has been verified; wildcard peers do not promise other versions.\n\n\`\`\`json\n${pretty({ package: facts.package, contracts: facts.contracts, eventbus: facts.eventbus })}\`\`\`\n\nSource hashes and ownership: [manifest](../manifest.json). Behavior: [runtime](../subsystems/background-task-runtime.md), [configuration](../operations/configuration.md), [EventBus v2](../api/eventbus-v2.md).\n`;
  output['docs/manifest.json'] = pretty({ schema_version: MANIFEST_SCHEMA_VERSION, ...facts, authored_docs: [...model.docs.map(({ path, sha256 }) => ({ path, sha256 })), ...model.root_docs] });
  return output;
}
function anchors(text) {
  return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1].toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-')));
}
export function verifyLinks(root) {
  const paths = ['README.md', 'TESTING.md', 'UPSTREAM.md', 'CHANGELOG.md', ...walkFiles(root, 'docs').filter((path) => path.endsWith('.md'))];
  const edges = new Map();
  for (const path of paths) {
    const text = read(root, path).replace(/```[\s\S]*?```/g, '');
    const links = [...text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)].map((match) => match[1]);
    edges.set(path, []);
    for (const link of links) {
      if (/^(https?:|mailto:)/.test(link)) continue;
      const [target, anchor] = link.split('#');
      const file = posixPath(relative(root, resolve(root, dirname(path), target || '')) || path);
      check(!file.startsWith('../') && existsSync(join(root, file)), `${path}: broken local link ${link}`);
      if (anchor && file.endsWith('.md')) check(anchors(read(root, file)).has(anchor), `${path}: broken anchor ${link}`);
      if (file.endsWith('.md')) edges.get(path).push(file);
    }
  }
  const reachable = new Set(), pending = ['README.md'];
  while (pending.length) { const path = pending.pop(); if (reachable.has(path)) continue; reachable.add(path); pending.push(...(edges.get(path) ?? [])); }
  for (const path of paths) check(reachable.has(path), `unreachable documentation ${path}`);
}
export async function generate({ packageRoot = PACKAGE_ROOT } = {}) {
  const codeFacts = extractCodeFacts({ packageRoot }), docsModel = loadDocsModel({ packageRoot });
  assertCoverage(codeFacts, docsModel);
  const texts = generateDocTexts(codeFacts, docsModel);
  for (const [path, text] of Object.entries(texts)) { mkdirSync(dirname(join(packageRoot, path)), { recursive: true }); writeFileSync(join(packageRoot, path), text); }
  verifyLinks(packageRoot);
  return { codeFacts, docsModel };
}
export async function verify({ packageRoot = PACKAGE_ROOT } = {}) {
  const codeFacts = extractCodeFacts({ packageRoot }), docsModel = loadDocsModel({ packageRoot });
  assertCoverage(codeFacts, docsModel);
  const texts = generateDocTexts(codeFacts, docsModel);
  check(JSON.stringify(texts) === JSON.stringify(generateDocTexts(codeFacts, docsModel)), 'docs generation is nondeterministic');
  for (const [path, text] of Object.entries(texts)) check(existsSync(join(packageRoot, path)) && read(packageRoot, path) === text, `${path}: stale generated contract/source hash; review and run npm run docs:generate`);
  verifyLinks(packageRoot);
  return { codeFacts, docsModel };
}

function runtimeImports(sf) {
  const imports = [];
  visit(sf, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (node.isTypeOnly || node.importClause?.isTypeOnly) return;
      if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && !node.importClause.name && node.importClause.namedBindings.elements.every((item) => item.isTypeOnly)) return;
      check(ts.isStringLiteral(node.moduleSpecifier), `${at(sf, node)}: nonliteral static import`);
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      check(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]), `${at(sf, node)}: nonliteral deferred import`);
      imports.push(node.arguments[0].text);
    }
  });
  return imports;
}
export function runtimeGraph(root, entry, { source = false, dynamic = true, distPrefix = 'dist', allowedBare = new Map() } = {}) {
  const pending = [entry], visited = new Set();
  while (pending.length) {
    const path = pending.pop(); if (visited.has(path)) continue;
    check(existsSync(join(root, path)), `runtime import closure missing ${path}`);
    visited.add(path);
    const sf = sourceFile(root, path);
    let imports = runtimeImports(sf);
    if (!dynamic) {
      const staticSpecs = sf.statements.filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node)).flatMap((node) => runtimeImports(node));
      imports = staticSpecs;
    }
    for (const spec of imports) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) {
        // Only a declared bundle leaf may still name its inlined workspace packages
        // before the shared builder replaces the one-to-one tsc emit.
        const declared = allowedBare.get(path) ?? [];
        check(HOST_PEERS.some((peer) => spec === peer || spec.startsWith(`${peer}/`)) || declared.includes(spec), `${path}: unexpected runtime dependency ${spec}`);
        continue;
      }
      let target = posixPath(relative(root, resolve(root, dirname(path), spec)));
      if (source) target = target.replace(/\.js$/, '.ts');
      check(target.startsWith(source ? 'src/' : `${distPrefix}/src/`) || target === entry, `${path}: import escapes runtime closure ${spec}`);
      pending.push(target);
    }
  }
  return [...visited].sort();
}
export function assertRuntimeClosure(sourceRoot = PACKAGE_ROOT, { distDirectory = join(sourceRoot, 'dist'), preBundle = false } = {}) {
  const pkg = json(sourceRoot, 'package.json'); checkManifest(pkg);
  const prefix = posixPath(relative(sourceRoot, distDirectory));
  const sources = [...walkFiles(sourceRoot, 'src'), ...walkFiles(sourceRoot, 'extensions')].sort();
  sortedSame(sources, Object.keys(SOURCE_OWNERS), 'pure shell source inventory');
  const bundles = declaredBundles(pkg, sources);
  const expected = [`${prefix}/package.json`, ...sources.flatMap((path) => [`${prefix}/${path.replace(/\.ts$/, '.js')}`, `${prefix}/${path.replace(/\.ts$/, '.js.map')}`])];
  // The package seal, the copied license texts and the inlined library licenses are
  // written after this closure is built, so they are known extras rather than orphans.
  const known = new Set([`${prefix}/artifacts.json`, ...(pkg.serraly?.licenses ?? []).map((path) => `${prefix}/${path}`),
    ...[...bundles.values()].flatMap((bundle) => bundle.packages.map((name) => `${prefix}/licenses/${name}/`))]);
  const isKnown = (path) => known.has(path) || [...known].some((entry) => entry.endsWith('/') && path.startsWith(entry));
  sortedSame(walkFiles(sourceRoot, prefix).filter((path) => !isKnown(path)), expected, 'runtime build artifacts (no orphans)');
  const built = json(sourceRoot, `${prefix}/package.json`);
  check(built.name === pkg.name && built.version === pkg.version && built.type === 'module', 'dist package identity drift');
  const graph = runtimeGraph(sourceRoot, `${prefix}/extensions/background-tasks.js`, {
    distPrefix: prefix,
    allowedBare: new Map(preBundle ? [...bundles].map(([source, bundle]) => [`${prefix}/${source.replace(/\.ts$/, '.js')}`, bundle.packages]) : []),
  });
  sortedSame(graph, expected.filter((path) => path.endsWith('.js')), 'reachable compiled runtime closure');
  for (const path of sources) {
    const js = `${prefix}/${path.replace(/\.ts$/, '.js')}`, map = json(sourceRoot, `${js}.map`);
    const bundle = bundles.get(path);
    const mapName = js.split('/').at(-1);
    if (bundle && !preBundle) {
      check(map.file === undefined || map.file === mapName, `${js}: invalid source map file field`);
      check(read(sourceRoot, js).includes(`//# sourceMappingURL=${mapName}.map`), `${js}: missing source map reference`);
      // A declared leaf is an esbuild bundle: several owned sources, host packages
      // external and no bare workspace import left in the compiled closure.
      check(map.sources.length > 1 && map.sourcesContent?.length === map.sources.length, `${js}: bundled leaf needs a multi-source map`);
      for (const [index, entry] of map.sources.entries()) {
        const source = posixPath(relative(sourceRoot, resolve(sourceRoot, dirname(js), map.sourceRoot ?? '', entry)));
        const owned = source === path ? path : source.startsWith('src/') && Object.hasOwn(SOURCE_OWNERS, source) ? source : undefined;
        if (owned) check(map.sourcesContent[index] === read(sourceRoot, owned), `${js}: bundled source content mismatch for ${owned}`);
        else check(bundle.packages.some((name) => entry.includes(name)), `${js}: bundled source ${entry} is not owned or declared`);
      }
      for (const name of bundle.packages) check(!runtimeImports(sourceFile(sourceRoot, js)).includes(name), `${js}: bundled package must not stay a bare import`);
      continue;
    }
    if (bundle) {
      // Before bundling, a declared leaf must at least import only declared packages.
      for (const name of runtimeImports(sourceFile(sourceRoot, path))) {
        if (name.startsWith('.') || name.startsWith('node:') || HOST_PEERS.some((peer) => name === peer || name.startsWith(`${peer}/`))) continue;
        check(bundle.packages.includes(name), `${path}: undeclared bundled import ${name}`);
      }
    }
    check(map.file === mapName && map.sources.length === 1 && map.sourcesContent?.length === 1, `${js}: invalid source map`);
    const source = posixPath(relative(sourceRoot, resolve(sourceRoot, dirname(js), map.sourceRoot ?? '', map.sources[0])));
    check(source === path && map.sourcesContent[0] === read(sourceRoot, path), `${js}: source map stale/mismatched source`);
    check(read(sourceRoot, js).includes(`//# sourceMappingURL=${mapName}.map`), `${js}: missing source map reference`);
    const emitted = ts.transpileModule(read(sourceRoot, path), { fileName: path, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true,
      sourceMap: true, inlineSources: true, verbatimModuleSyntax: true, isolatedModules: true,
    } });
    check(read(sourceRoot, js) === emitted.outputText, `${js}: compiled JavaScript differs from authoritative TypeScript`);
  }
  return expected.sort();
}

/** The manifest's declared bundle leaves: source path → output and inlined packages. */
function declaredBundles(pkg, sources) {
  const declared = new Map();
  for (const [source, bundle] of Object.entries(pkg.serraly?.build?.bundles ?? {})) {
    check(sources.includes(source), `declared bundle leaf is not a governed source: ${source}`);
    check(bundle && typeof bundle === 'object' && typeof bundle.output === 'string' && Array.isArray(bundle.packages), `${source}: invalid bundle declaration`);
    check(posixPath(bundle.output) === `dist/${source.replace(/\.ts$/, '.js')}`, `${source}: a bundled leaf must be written to its own compiled path`);
    for (const name of bundle.packages) {
      check(/^pi-[a-z0-9-]+$/.test(name) && pkg.devDependencies?.[name] !== undefined, `${source}: bundled package ${name} must be a workspace devDependency`);
      check(!HOST_PEERS.includes(name), `${source}: host packages stay external`);
    }
    declared.set(source, bundle);
  }
  return declared;
}
export function checkPayloadFiles(files, sourceRoot = PACKAGE_ROOT, { artifactRoot = sourceRoot } = {}) {
  sortedSame(walkFiles(artifactRoot, 'docs'), [...AUTHORED_DOCS, ...GENERATED_DOCS], 'packed docs inventory (no retired evidence)');
  const required = ['package.json', 'README.md', 'TESTING.md', 'UPSTREAM.md', 'LICENSE', 'CHANGELOG.md', ...walkFiles(artifactRoot, 'src'), ...walkFiles(artifactRoot, 'extensions'), ...walkFiles(artifactRoot, 'dist'), ...AUTHORED_DOCS, ...GENERATED_DOCS].sort();
  sortedSame(files, required, 'packed payload');
  check(!files.some((path) => /(^|\/)(node_modules|tests|scripts|artifacts)(\/|$)|\.tgz$/.test(path)), 'packed payload contains nonruntime artifacts or private host SDK');
  assertRuntimeClosure(sourceRoot, { distDirectory: join(artifactRoot, 'dist') });
  return files;
}
export function resolveNpmCli(node = process.execPath, env = process.env, exists = existsSync) {
  const candidates = [env.npm_execpath, resolve(dirname(node), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  const found = candidates.find((path) => exists(path));
  check(found, 'cannot resolve npm-cli.js');
  return found;
}
export function parseNpmPackFiles(stdout) {
  let entries;
  try { entries = JSON.parse(stdout); } catch { throw new DocsGateError('npm pack did not return valid JSON'); }
  check(Array.isArray(entries) && entries.length === 1 && Array.isArray(entries[0].files), 'npm pack must return exactly one package entry');
  return entries[0].files.map((file, index) => { check(typeof file.path === 'string', `npm pack files[${index}].path must be a string`); return file.path; }).sort();
}
export function isolatedNpmEnv(scratch) {
  for (const path of ['home', 'tmp', 'cache', 'config']) mkdirSync(join(scratch, path), { recursive: true });
  for (const file of ['user.npmrc', 'global.npmrc']) writeFileSync(join(scratch, 'config', file), '');
  return { PATH: process.env.PATH ?? '', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}), HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), PI_CODING_AGENT_DIR: join(scratch, 'home', 'agent'), XDG_CONFIG_HOME: join(scratch, 'config'), TMPDIR: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'), TEMP: join(scratch, 'tmp'), npm_config_cache: join(scratch, 'cache'), npm_config_userconfig: join(scratch, 'config/user.npmrc'), npm_config_globalconfig: join(scratch, 'config/global.npmrc'), npm_config_registry: 'http://127.0.0.1.invalid/', GIT_ALLOW_PROTOCOL: 'file', CI: '1' };
}
export function runPayloadCheck({ packageRoot = PACKAGE_ROOT, artifactRoot = packageRoot } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'pi-bg-payload-'));
  try {
    const env = isolatedNpmEnv(scratch), project = join(scratch, 'project');
    mkdirSync(project); writeFileSync(join(project, 'package.json'), '{"name":"payload-check","private":true}\n'); writeFileSync(join(project, '.npmrc'), '');
    const result = spawnSync(process.execPath, [resolveNpmCli(), 'pack', '--dry-run', '--ignore-scripts', '--offline', '--json', artifactRoot], { cwd: project, env, encoding: 'utf8', timeout: 60_000 });
    check(result.status === 0, `npm pack dry-run failed: ${result.stderr || result.error?.message || result.stdout}`);
    return checkPayloadFiles(parseNpmPackFiles(result.stdout), packageRoot, { artifactRoot });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
