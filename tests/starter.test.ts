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

// Пользователь 2026-10-26: включая память в проекте, init должен выключить нативную память OMP, иначе
// на каждом ходу работают две памяти. Глобальный mnemopi проект наследует, если сам ничего не задал.
// Существующий .omp/config.yml правится одной строкой: комментарии и чужие ключи остаются как были.
test('init switches native OMP memory off in an existing project config and never rewrites the rest', () => {
  const root = mkdtempSync(join(import.meta.dir, 'starter-test-'));
  const NL = String.fromCharCode(10);
  const config = join(root, '.omp/config.yml');
  const read = () => readFileSync(config, 'utf8');
  try {
    mkdirSync(join(root, '.omp'));
    const plain = '# мои настройки' + NL + 'edit:' + NL + '  mode: hashline' + NL;
    writeFileSync(config, plain);
    expect(initProject(root).ompMemory).toEqual({ state: 'set', previous: null });
    expect(read().startsWith(plain)).toBe(true);
    expect(Bun.YAML.parse(read())).toEqual({ edit: { mode: 'hashline' }, memory: { backend: 'off' } });
    const after = read();
    expect(initProject(root).ompMemory).toEqual({ state: 'already', previous: 'off' });
    expect(read()).toBe(after);

    const nested = 'memory:' + NL + '    backend: mnemopi   # глобальная' + NL + '    extra: 1' + NL + 'plan:' + NL + '    defaultOnStartup: false' + NL;
    writeFileSync(config, nested);
    expect(initProject(root).ompMemory).toEqual({ state: 'set', previous: 'mnemopi' });
    expect(Bun.YAML.parse(read())).toEqual({ memory: { backend: 'off', extra: 1 }, plan: { defaultOnStartup: false } });
    expect(read()).toContain('# глобальная');

    writeFileSync(config, 'memory:' + NL + '  dir: x' + NL);
    expect(initProject(root).ompMemory).toEqual({ state: 'set', previous: null });
    expect(Bun.YAML.parse(read())).toEqual({ memory: { dir: 'x', backend: 'off' } });

    // Форму, которую строкой не поправить, init не трогает и называет.
    const flow = 'memory: {backend: local}' + NL;
    writeFileSync(config, flow);
    expect(initProject(root).ompMemory).toEqual({ state: 'manual', previous: 'local' });
    expect(read()).toBe(flow);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
