import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, parse, resolve } from 'node:path';
import { safePath } from './core';
// Файлы starter встраиваются в bundle текстом: /huimem init работает при установке плагина
// из GitHub и при прямой загрузке dist/index.js, без поиска каталога starter на диске.
// scripts/check-package.ts сверяет этот список с содержимым starter/.
import gitignore from '../../starter/.gitignore' with { type: 'text' };
import makefile from '../../starter/Makefile' with { type: 'text' };
import agents from '../../starter/AGENTS.md' with { type: 'text' };
import config from '../../starter/.omp/config.yml' with { type: 'text' };
import rules from '../../starter/.omp/RULES.md' with { type: 'text' };
import readme from '../../starter/.memory/README.md' with { type: 'text' };
import design from '../../starter/.memory/DESIGN.md' with { type: 'text' };
import projectMd from '../../starter/.memory/PROJECT.md' with { type: 'text' };
import todo from '../../starter/.memory/todo.json' with { type: 'text' };
import architecture from '../../starter/.memory/architecture.json' with { type: 'text' };
import adrReadme from '../../starter/.memory/adr/README.md' with { type: 'text' };
import memoryMd from '../../starter/.memory/MEMORY.md' with { type: 'text' };

// Файлы starter хранятся с LF (.gitattributes), и тест запрещает CR в рабочей копии: иначе dist,
// собранный на Windows, отличался бы от сборки CI. Здесь LF лишь для сравнения с файлами проекта.
const lf = (s: string) => s.replace(/\r\n/g, '\n');
// Маркер включения MEMORY.md последним: при сбое посреди записи память не включается наполовину.
export const STARTER: [string, string][] = ([
  ['AGENTS.md', agents], ['Makefile', makefile], ['.omp/config.yml', config], ['.omp/RULES.md', rules],
  ['.memory/README.md', readme], ['.memory/DESIGN.md', design], ['.memory/PROJECT.md', projectMd],
  ['.memory/todo.json', todo], ['.memory/architecture.json', architecture], ['.memory/adr/README.md', adrReadme],
  ['.memory/MEMORY.md', memoryMd],
] as [string, string][]).map(([p, t]) => [p, lf(t)]);

// differs — пропущенные файлы, чьё содержимое не совпадает со starter: в них могут отсутствовать правила памяти.
// ompMemory — нативная память OMP в .omp/config.yml проекта: set — выключена этим init, already — уже
// была выключена, manual — форму файла не поправить одной строкой, init его не трогал.
export type NativeMemory = { state: 'set' | 'already' | 'manual'; previous: string | null };
export type InitResult = { root: string; created: string[]; skipped: string[]; differs: string[]; gitignoreAdded: string[]; ompMemory: NativeMemory };

// Пользователь 2026-10-26: включая память проекта, выключить нативную память OMP. Иначе работают две
// памяти сразу: mnemopi вставляет свой recall и пишет ходы, local — сводки до 5000 токенов и фоновые
// вызовы моделей (исходники OMP 18.12.6: memories/index.ts:213-239, 387-600). Перекрывается только
// проект: глобальный конфиг остаётся за пользователем. Правится одна строка; результат проверяется
// разбором YAML, и при любом расхождении файл остаётся нетронутым.
function nativeMemoryOff(base: string): NativeMemory {
  const path = safePath(base, '.omp/config.yml');
  const yaml = (globalThis as any).Bun?.YAML;
  const text = readFileSync(path, 'utf8');
  let parsed: any;
  try { parsed = yaml.parse(text) ?? {}; } catch { return { state: 'manual', previous: null }; }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'manual', previous: null };
  const memory = parsed.memory;
  const previous = typeof memory?.backend === 'string' ? memory.backend : null;
  if (previous === 'off') return { state: 'already', previous };
  const manual: NativeMemory = { state: 'manual', previous };
  if (memory != null && (typeof memory !== 'object' || Array.isArray(memory))) return manual;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const head = lines.findIndex(line => /^memory\s*:\s*(#.*)?$/.test(line));
  let next: string;
  if (memory === undefined) {
    if (head !== -1) return manual;
    next = text + (text && !/\r?\n$/.test(text) ? eol : '') + `memory:${eol}  backend: 'off'${eol}`;
  } else {
    if (head === -1) return manual;
    let end = head + 1;
    while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]) || lines[end].startsWith('#'))) end++;
    const indent = lines.slice(head + 1, end).find(line => /^ +[^\s#]/.test(line))?.match(/^ +/)?.[0] ?? '  ';
    const at = lines.findIndex((line, i) => i > head && i < end && line.startsWith(indent + 'backend') && /^ +backend\s*:/.test(line));
    if (at === -1) lines.splice(head + 1, 0, indent + "backend: 'off'");
    else lines[at] = lines[at].replace(/^( +backend\s*:\s*)([^#]*?)(\s*(?:#.*)?)$/, "$1'off'$3");
    next = lines.join(eol);
  }
  let check: any;
  try { check = yaml.parse(next); } catch { return manual; }
  if (!(globalThis as any).Bun.deepEquals(check, { ...parsed, memory: { ...(memory ?? {}), backend: 'off' } })) return manual;
  writeFileSync(path, next);
  return { state: 'set', previous };
}

// Создаёт только отсутствующие файлы и никогда не перезаписывает существующие: в готовом проекте
// свои AGENTS.md и .omp/config.yml остаются как есть. Единственная правка существующего файла —
// строка memory.backend в .omp/config.yml (см. nativeMemoryOff).
export function initProject(root: string): InitResult {
  const base = resolve(root);
  if (base === resolve(homedir()) || base === parse(base).root)
    throw new Error(`INIT_REFUSED: ${base} is a home or drive root, not a project. Start omp in the project folder.`);
  const created: string[] = [], skipped: string[] = [], differs: string[] = [];
  const place = (path: string, text: string) => {
    const full = resolve(base, path);
    // Каждый существующий каталог пути проверяется ДО создания следующего: иначе ссылка
    // .memory -> чужой каталог получила бы вложенные папки раньше, чем проверка сработает.
    let dir = '';
    for (const part of dirname(path).split('/').filter(p => p !== '.')) {
      dir = dir ? dir + '/' + part : part;
      if (existsSync(resolve(base, dir))) safePath(base, dir); else mkdirSync(resolve(base, dir));
    }
    try { writeFileSync(full, text, { flag: 'wx' }); created.push(path); }
    catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      skipped.push(path);
      try { if (lf(readFileSync(full, 'utf8')) !== text) differs.push(path); } catch { differs.push(path); }
    }
  };
  const [markerPath, markerText] = STARTER[STARTER.length - 1];
  for (const [path, text] of STARTER.slice(0, -1)) place(path, text);
  // .gitignore дополняется, а не заменяется: база со стенограммой не должна попасть в git.
  // Ссылка .gitignore проверяется до записи (находка проверки Codex v0.6.1): дописывание через
  // ссылку наружу изменило бы чужой файл. lstat, а не existsSync: висячая ссылка тоже ссылка.
  const ignore = resolve(base, '.gitignore');
  let link = false;
  try { link = lstatSync(ignore).isSymbolicLink(); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  if (link) safePath(base, '.gitignore');
  const current = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  const have = new Set(current.split(/\r?\n/).map(l => l.trim()));
  const missing = lf(gitignore).split(/\r?\n/).map(l => l.trim()).filter(l => l && !have.has(l));
  if (missing.length) appendFileSync(ignore, (current && !current.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
  const ompMemory = nativeMemoryOff(base);
  // Маркер включения — последним: при сбое любого шага выше память не включается.
  place(markerPath, markerText);
  return { root: base, created, skipped, differs, gitignoreAdded: missing, ompMemory };
}
