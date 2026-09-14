import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { STARTER, initProject } from '../src/memory/starter';

const STARTER_DIR = join(import.meta.dir, '../starter');
const walk = (d: string): string[] => readdirSync(d).flatMap(n => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : [relative(STARTER_DIR, p).split('\\').join('/')];
});

test('the embedded starter matches starter/ file for file, byte for byte, with LF line ends', () => {
  const onDisk = walk(STARTER_DIR).filter(p => p !== '.gitignore').sort();
  expect(STARTER.map(([p]) => p).sort()).toEqual(onDisk);
  for (const [path, text] of STARTER) {
    const raw = readFileSync(join(STARTER_DIR, path), 'utf8');
    // CR в рабочей копии сделал бы dist на Windows отличным от сборки CI на Linux.
    expect(raw.includes(String.fromCharCode(13))).toBe(false);
    expect(text).toBe(raw);
  }
  expect(STARTER.at(-1)![0]).toBe('.memory/MEMORY.md');
});

test('init refuses a home folder before writing anything', () => {
  expect(() => initProject(homedir())).toThrow('INIT_REFUSED');
});

test('init never writes through a directory link that leaves the project', () => {
  const root = mkdtempSync(join(import.meta.dir, 'starter-test-'));
  const outside = mkdtempSync(join(import.meta.dir, 'starter-outside-'));
  try {
    symlinkSync(outside, join(root, '.memory'), 'junction');
    expect(() => initProject(root)).toThrow('PATH');
    expect(readdirSync(outside)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

// Файловые ссылки на Windows без привилегий дают EPERM; тогда проверка идёт в CI на Linux.
const canLinkFiles = (() => {
  const dir = mkdtempSync(join(import.meta.dir, 'starter-link-probe-'));
  try { writeFileSync(join(dir, 'a'), ''); symlinkSync(join(dir, 'a'), join(dir, 'b'), 'file'); return true; }
  catch { return false; }
  finally { rmSync(dir, { recursive: true, force: true }); }
})();

test.skipIf(!canLinkFiles)('init refuses a .gitignore link leaving the project, dangling or not, and leaves memory off', () => {
  const root = mkdtempSync(join(import.meta.dir, 'starter-test-'));
  const outside = mkdtempSync(join(import.meta.dir, 'starter-outside-'));
  try {
    const target = join(outside, 'external.gitignore');
    writeFileSync(target, '# external\n');
    symlinkSync(target, join(root, '.gitignore'), 'file');
    expect(() => initProject(root)).toThrow('PATH');
    expect(readFileSync(target, 'utf8')).toBe('# external\n');
    expect(existsSync(join(root, '.memory/MEMORY.md'))).toBe(false);
    rmSync(join(root, '.gitignore'));
    symlinkSync(join(outside, 'not-there'), join(root, '.gitignore'), 'file');
    expect(() => initProject(root)).toThrow();
    expect(existsSync(join(outside, 'not-there'))).toBe(false);
    expect(existsSync(join(root, '.memory/MEMORY.md'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('a failure while updating .gitignore leaves memory off: the marker is written last', () => {
  const root = mkdtempSync(join(import.meta.dir, 'starter-test-'));
  try {
    mkdirSync(join(root, '.gitignore'));
    expect(() => initProject(root)).toThrow();
    expect(existsSync(join(root, '.memory/todo.json'))).toBe(true);
    expect(existsSync(join(root, '.memory/MEMORY.md'))).toBe(false);
    rmSync(join(root, '.gitignore'), { recursive: true, force: true });
    const retry = initProject(root);
    expect(retry.created).toEqual(['.memory/MEMORY.md']);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.memory/runtime/');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init keeps existing files byte-exact, appends only missing ignore lines, and is idempotent', () => {
  const root = mkdtempSync(join(import.meta.dir, 'starter-test-'));
  const NL = String.fromCharCode(10);
  try {
    writeFileSync(join(root, 'AGENTS.md'), 'my rules');
    writeFileSync(join(root, '.gitignore'), 'node_modules/' + NL + '.memory/runtime/');
    const first = initProject(root);
    expect(first.skipped).toEqual(['AGENTS.md']);
    expect(first.differs).toEqual(['AGENTS.md']);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('my rules');
    expect(existsSync(join(root, '.memory/MEMORY.md'))).toBe(true);
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(ignore.startsWith('node_modules/' + NL + '.memory/runtime/' + NL)).toBe(true);
    expect(ignore.split(NL).filter(l => l === '.memory/runtime/')).toHaveLength(1);
    expect(first.gitignoreAdded).not.toContain('.memory/runtime/');
    const second = initProject(root);
    expect(second.created).toEqual([]);
    expect(second.differs).toEqual(['AGENTS.md']);
    expect(second.gitignoreAdded).toEqual([]);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(ignore);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
