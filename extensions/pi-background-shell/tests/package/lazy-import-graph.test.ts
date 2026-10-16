import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../..');

function sourcePath(relativePath: string): string {
  return resolve(root, relativePath);
}

function relativeSource(absolutePath: string): string {
  return relative(root, absolutePath).split('\\').join('/');
}

function runtimeImportSpecifier(node: ts.ImportDeclaration): string | undefined {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return undefined;
  const clause = node.importClause;
  if (clause?.isTypeOnly === true) return undefined;
  if (clause === undefined || clause.name !== undefined) return node.moduleSpecifier.text;
  const bindings = clause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return node.moduleSpecifier.text;
  return bindings.elements.some((element) => !element.isTypeOnly)
    ? node.moduleSpecifier.text
    : undefined;
}

function resolveSourceImport(fromPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const requested = resolve(dirname(fromPath), specifier);
  const candidates =
    extname(requested) === '.js'
      ? [`${requested.slice(0, -3)}.ts`, requested]
      : [requested, `${requested}.ts`, join(requested, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate));
}

async function runtimeStaticGraph(entry: string): Promise<Set<string>> {
  const pending = [sourcePath(entry)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    if (extname(current) !== '.ts') continue;
    const source = await readFile(current, 'utf8');
    const tree = ts.createSourceFile(
      current,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const specifier = runtimeImportSpecifier(statement);
      if (specifier === undefined) continue;
      const target = resolveSourceImport(current, specifier);
      if (target !== undefined) pending.push(target);
    }
  }
  return new Set([...visited].map(relativeSource));
}

async function sourceTree(path: string): Promise<ts.SourceFile> {
  const absolutePath = sourcePath(path);
  return ts.createSourceFile(
    absolutePath,
    await readFile(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

async function runtimeBareImports(path: string): Promise<Set<string>> {
  const tree = await sourceTree(path);
  const out = new Set<string>();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = runtimeImportSpecifier(statement);
    if (specifier !== undefined && !specifier.startsWith('.') && !specifier.startsWith('node:')) {
      out.add(specifier);
    }
  }
  return out;
}

async function dynamicImports(path: string): Promise<Set<string>> {
  const tree = await sourceTree(path);
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    const argument = ts.isCallExpression(node) ? node.arguments[0] : undefined;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      argument !== undefined &&
      ts.isStringLiteral(argument)
    ) {
      out.add(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}

void describe('lazy shell runtime import graph', () => {
  void it('keeps the process task manager out of static startup with a deferred import', async () => {
    const graph = await runtimeStaticGraph('src/extension.ts');
    assert.equal(graph.has('src/ui/background-tasks-manager.ts'), false);
    assert.equal(graph.has('src/ui/task-log-viewport.ts'), false);
    assert.ok(graph.has('src/core/registry.ts'));
    assert.ok(graph.has('src/core/lazy-module.ts'));
    assert.deepEqual([...await dynamicImports('src/extension.ts')], ['./ui/background-tasks-manager.js']);
  });
  void it('closes every literal deferred target inside shipped source/dist and host alias-aware entry', async () => {
    const deferred = await dynamicImports('src/extension.ts');
    for (const spec of deferred) {
      const target = resolveSourceImport(sourcePath('src/extension.ts'), spec);
      assert.ok(target, `missing deferred source ${spec}`);
      assert.match(relativeSource(target), /^src\//u);
      assert.ok(existsSync(sourcePath(`dist/${relativeSource(target).replace(/\.ts$/, '.js')}`)));
    }
    const host = await runtimeBareImports('src/extension.ts');
    assert.ok(host.has('@earendil-works/pi-coding-agent'), 'lazy issuer must use Pi alias-aware host loading');
    const manifest = JSON.parse(await readFile(sourcePath('package.json'), 'utf8')) as { files: string[] };
    assert.ok(manifest.files.includes('src/'));
    assert.ok(manifest.files.includes('dist/'));
  });
  void it('ordinary registry has no model-producer deferred imports or orphan source files', async () => {
    assert.deepEqual([...await dynamicImports('src/core/registry.ts')], []);
    for (const removed of ['src/delegate-extension.ts', 'src/fusion-extension.ts', 'src/core/pi-launch.ts', 'src/core/attested-pi-run.ts', 'src/core/anthropic-attribution.ts', 'src/core/update-check.ts']) assert.equal(existsSync(sourcePath(removed)), false, removed);
  });
});
