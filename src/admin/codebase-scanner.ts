import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * Static analysis of the project's own source, used by the super admin's "App info" screen.
 * Deliberately dependency-free and heuristic: it strips comments and string literals, then counts
 * lines, functions and branch points (if / for / while / case / catch / && / || / ?? / ternary).
 * "Complexity" here is the classic cyclomatic estimate (1 + decision points), summed per file.
 * It is an indicator for "where is the logic dense", not a precise tool-grade measurement.
 */

export interface FileMetrics {
  file: string;
  module: string;
  lines: number;
  codeLines: number;
  functions: number;
  branches: number;
  complexity: number;
  perFunction: number;
}

export interface ModuleMetrics {
  module: string;
  files: number;
  lines: number;
  codeLines: number;
  functions: number;
  complexity: number;
  perFunction: number;
}

export interface CodebaseReport {
  source: 'src' | 'dist';
  files: number;
  lines: number;
  codeLines: number;
  functions: number;
  classes: number;
  complexity: number;
  perFunction: number;
  rating: 'Low' | 'Moderate' | 'High' | 'Very high';
  byModule: ModuleMetrics[];
  mostComplexFiles: FileMetrics[];
  largestFiles: FileMetrics[];
  envVars: string[];
  jobProviders: string[];
}

const NOISE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;
const BRANCH = /\b(?:if|for|while|case|catch)\b|&&|\|\||\?\?|\s\?\s/g;
const FUNCTION = /\bfunction\b|=>|^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::\s*[^{;=]+)?\{/gm;
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor']);

function walk(dir: string, out: string[], exts: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out, exts);
    else if (exts.some((e) => name.endsWith(e)) && !name.endsWith('.d.ts') && !/\.(spec|test)\.[tj]s$/.test(name)) out.push(full);
  }
}

export function measure(text: string) {
  const lines = text.split('\n').length;
  const stripped = text.replace(NOISE, ' ');
  const codeLines = stripped.split('\n').filter((l) => l.trim().length > 0).length;
  const branches = (stripped.match(BRANCH) ?? []).length;
  let functions = 0;
  for (const m of stripped.matchAll(FUNCTION)) {
    const head = m[0].trim().match(/^(?:(?:public|private|protected|static|async)\s+)*([A-Za-z_$][\w$]*)/)?.[1];
    if (m[0].includes('function') || m[0].includes('=>') || (head && !NOT_METHODS.has(head))) functions++;
  }
  const classes = (stripped.match(/\bclass\s+[A-Za-z_$]/g) ?? []).length;
  return { lines, codeLines, branches, functions, classes, stripped };
}

const rate = (perFunction: number): CodebaseReport['rating'] =>
  perFunction <= 4 ? 'Low' : perFunction <= 8 ? 'Moderate' : perFunction <= 15 ? 'High' : 'Very high';

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** Scans `<root>/src` (preferred) or `<root>/dist`. Returns null if neither exists. */
export function scanCodebase(root: string): CodebaseReport | null {
  const srcDir = join(root, 'src');
  const distDir = join(root, 'dist');
  const source: 'src' | 'dist' | null = existsSync(srcDir) ? 'src' : existsSync(distDir) ? 'dist' : null;
  if (!source) return null;
  const base = source === 'src' ? srcDir : distDir;

  const paths: string[] = [];
  walk(base, paths, source === 'src' ? ['.ts'] : ['.js']);

  const files: FileMetrics[] = [];
  const envVars = new Set<string>();
  const jobProviders: string[] = [];
  let classes = 0;

  for (const full of paths) {
    const text = readFileSync(full, 'utf8');
    const m = measure(text);
    classes += m.classes;
    const rel = relative(base, full).split(sep).join('/');
    const module = rel.includes('/') ? rel.split('/')[0] : '(root)';
    const complexity = 1 + m.branches;
    files.push({
      file: rel, module, lines: m.lines, codeLines: m.codeLines, functions: m.functions,
      branches: m.branches, complexity, perFunction: round(complexity / Math.max(m.functions, 1)),
    });

    // Environment variable names the code reads (names only - values are never read here).
    for (const e of text.matchAll(/(?:config|configService|this\.config)\.get(?:OrThrow)?(?:<[^>]*>)?\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) envVars.add(e[1]);
    for (const e of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) envVars.add(e[1]);
    for (const e of text.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g)) envVars.add(e[1]);

    const prov = rel.match(/^jobs\/providers\/([a-z0-9-]+)\.provider\.(?:ts|js)$/);
    if (prov) jobProviders.push(prov[1]);
  }

  const sum = (k: 'lines' | 'codeLines' | 'functions' | 'complexity', list: FileMetrics[]) => list.reduce((a, f) => a + f[k], 0);

  const byModuleMap = new Map<string, FileMetrics[]>();
  for (const f of files) byModuleMap.set(f.module, [...(byModuleMap.get(f.module) ?? []), f]);
  const byModule: ModuleMetrics[] = [...byModuleMap.entries()]
    .map(([module, list]) => ({
      module, files: list.length, lines: sum('lines', list), codeLines: sum('codeLines', list),
      functions: sum('functions', list), complexity: sum('complexity', list),
      perFunction: round(sum('complexity', list) / Math.max(sum('functions', list), 1)),
    }))
    .sort((a, b) => b.codeLines - a.codeLines);

  const complexity = sum('complexity', files);
  const functions = sum('functions', files);
  const perFunction = round(complexity / Math.max(functions, 1));

  return {
    source,
    files: files.length,
    lines: sum('lines', files),
    codeLines: sum('codeLines', files),
    functions,
    classes,
    complexity,
    perFunction,
    rating: rate(perFunction),
    byModule,
    mostComplexFiles: [...files].sort((a, b) => b.complexity - a.complexity).slice(0, 10),
    largestFiles: [...files].sort((a, b) => b.codeLines - a.codeLines).slice(0, 10),
    envVars: [...envVars].sort(),
    jobProviders: jobProviders.sort(),
  };
}
