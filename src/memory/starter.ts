import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
export type InitResult = { root: string; created: string[]; skipped: string[]; differs: string[]; gitignoreAdded: string[] };

// Создаёт только отсутствующие файлы и никогда не перезаписывает существующие:
// в готовом проекте свои AGENTS.md и .omp/config.yml остаются как есть.
export function initProject(root: string): InitResult {
  const base = resolve(root);
  if (base === resolve(homedir()) || base === parse(base).root)
    throw new Error(`INIT_REFUSED: ${base} is a home or drive root, not a project. Start omp in the project folder.`);
  const created: string[] = [], skipped: string[] = [], differs: string[] = [];
  for (const [path, text] of STARTER) {
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
  }
  // .gitignore дополняется, а не заменяется: база со стенограммой не должна попасть в git.
  const ignore = resolve(base, '.gitignore');
  const current = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  const have = new Set(current.split(/\r?\n/).map(l => l.trim()));
  const missing = lf(gitignore).split(/\r?\n/).map(l => l.trim()).filter(l => l && !have.has(l));
  if (missing.length) appendFileSync(ignore, (current && !current.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
  return { root: base, created, skipped, differs, gitignoreAdded: missing };
}
