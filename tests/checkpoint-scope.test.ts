import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore, gitBranch } from '../src/memory/core';

// Область чекпоинта (пункт 4, 14 сентября): шаг задачи A не выдаётся за шаг задачи B.
function fixture(fn: (s: MemoryStore, root: string) => void) {
  const root = mkdtempSync(join(import.meta.dir, 'scope-test-'));
  const s = new MemoryStore(root);
  try { fn(s, root); } finally { s.close(); rmSync(root, { recursive: true, force: true }); }
}
const tick = () => Bun.sleepSync(4);

test('task checkpoints survive other commits in the same run, failures and reopening',()=>fixture((s,root)=>{
  s.commit('same:0',[task(s,'task-a','Export invoices')],'Next A');
  s.commit('same:0',[task(s,'task-b','Migrate orders')],'Next B');
  expect(s.taskCheckpoint('task-a')?.summary).toBe('Next A');
  s.commit('same:0',[],'General summary');
  expect(s.taskCheckpoint('task-b')?.summary).toBe('Next B');
  s.commit('same:0',[],'Updated A',{task:'task-a'});
  expect(()=>s.commit('same:0',[],'Invalid',{task:'missing'})).toThrow('INVALID_TASK_SCOPE');
  expect(s.checkpoint('same:0').summary).toBe('Updated A');
  expect(s.taskCheckpoint('task-a')?.summary).toBe('Updated A');
  s.close();
  const reopened=new MemoryStore(root);
  try {
    expect(reopened.taskCheckpoint('task-a')?.summary).toBe('Updated A');
    expect(reopened.taskCheckpoint('task-b')?.summary).toBe('Next B');
    expect(reopened.checkpointView('export').tasks.map(t=>t.task)).toEqual(['task-a','task-b']);
    expect(reopened.checkpointView('export').tasks.filter(t=>t.task==='task-a')).toHaveLength(1);
  } finally {reopened.close();}
}));

test('a checkpoint written before task archiving is preserved on the first replacement',()=>fixture((s,root)=>{
  s.commit('old:0',[task(s,'task-a','Export')],'Legacy A');
  s.db.exec('DROP TABLE IF EXISTS checkpoint_archive');
  s.close();
  const reopened=new MemoryStore(root);
  try {
    reopened.commit('old:0',[task(reopened,'task-b','Orders')],'Next B');
    expect(reopened.taskCheckpoint('task-a')?.summary).toBe('Legacy A');
    expect(reopened.taskCheckpoint('task-b')?.summary).toBe('Next B');
    expect((reopened.db.query("SELECT value FROM meta WHERE key='schema'").get() as any).value).toBe('2');
  } finally {reopened.close();}
}));
function task(s: MemoryStore, id: string, text: string, status = 'doing', version = 0) {
  const episode = s.capture('t', 'user', text);
  return { id, kind: 'task', status, text, expectedVersion: version, source: { episode, quote: text } };
}

test('a commit with one task change is scoped to it; an empty commit stays unscoped', () => fixture(s => {
  s.commit('r1', [task(s, 'task-a', 'Экспорт счетов в CSV')], 'Следующий шаг A'); tick();
  s.commit('r2', [task(s, 'task-b', 'Миграция orders')], 'Следующий шаг B'); tick();
  s.commit('r3', [], 'Общая сводка без задачи');
  const view = s.checkpointView('экспорт счетов');
  expect(view.tasks.map(t => [t.task, t.summary, t.matched])).toEqual([['task-a', 'Следующий шаг A', true], ['task-b', 'Следующий шаг B', false]]);
  expect(view.unscoped.summary).toBe('Общая сводка без задачи');
  expect(s.taskCheckpoint('task-a').summary).toBe('Следующий шаг A');
}));

test('an explicit task scopes an empty commit, and an invalid task writes nothing', () => fixture(s => {
  s.commit('r1', [task(s, 'task-a', 'Экспорт счетов')], 'first'); tick();
  s.commit('r2', [], 'Шаг A после паузы', { task: 'task-a', branch: 'feature/csv' });
  expect(s.taskCheckpoint('task-a')).toMatchObject({ summary: 'Шаг A после паузы', branch: 'feature/csv' });
  s.commit('r3', [{ id: 'fact-x', kind: 'fact', status: 'active', text: 'x', expectedVersion: 0, source: task(s, 'q', 'x').source }], 'fact only');
  expect(() => s.commit('r4', [task(s, 'task-c', 'Новая')], 'bad', { task: 'fact-x' })).toThrow('INVALID_TASK_SCOPE');
  expect(() => s.commit('r5', [], 'bad', { task: 'nope' })).toThrow('INVALID_TASK_SCOPE');
  expect(s.checkpoint('r4')).toBeNull();
  expect(s.current('task-c')).toBeNull();
  // Две задачи в одном commit без явного task — область не угадывается.
  s.commit('r6', [task(s, 'task-d', 'D'), task(s, 'task-e', 'E')], 'two tasks');
  expect(s.checkpointView('').unscoped.summary).toBe('two tasks');
}));

test('done and retired tasks drop out unless asked about; at most three task checkpoints are shown', () => fixture(s => {
  for (const id of ['t1', 't2', 't3', 't4']) { s.commit(id, [task(s, id, 'Задача ' + id + ' отчёт')], 'шаг ' + id); tick(); }
  let view = s.checkpointView('');
  expect(view.tasks.map(t => t.task)).toEqual(['t4', 't3', 't2']);
  expect(view.omitted).toBe(1);
  s.commit('t4-done', [task(s, 't4', 'Задача t4 отчёт', 'done', 1)], 'готово'); tick();
  s.commit('t3-retired', [task(s, 't3', 'Задача t3 отчёт', 'retired', 1)], 'снято');
  view = s.checkpointView('');
  expect(view.tasks.map(t => t.task)).toEqual(['t2', 't1']);
  view = s.checkpointView('задача t4');
  expect(view.tasks[0]).toMatchObject({ task: 't4', status: 'done', summary: 'готово' });
}));

test('a database from an earlier version opens, keeps its checkpoints unscoped, and old writes still work', () => {
  const root = mkdtempSync(join(import.meta.dir, 'scope-test-'));
  try {
    mkdirSync(join(root, '.memory/runtime'), { recursive: true });
    const old = new Database(join(root, '.memory/runtime/state.sqlite'), { create: true });
    old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE episodes (id TEXT PRIMARY KEY, session TEXT, role TEXT, text TEXT, time TEXT);
      CREATE TABLE versions (id TEXT, version INTEGER, data TEXT NOT NULL, time TEXT, PRIMARY KEY(id,version));
      CREATE TABLE checkpoints (run TEXT PRIMARY KEY, summary TEXT, time TEXT);
      CREATE TABLE health (id INTEGER PRIMARY KEY CHECK(id=1), lastWrite TEXT);
      INSERT INTO meta VALUES ('schema','2');
      INSERT INTO checkpoints VALUES ('old-run','Шаг из старой версии','2026-09-01T00:00:00.000Z');`);
    old.close();
    const s = new MemoryStore(root);
    try {
      expect(s.checkpointView('').unscoped.summary).toBe('Шаг из старой версии');
      expect(s.checkpointView('').tasks).toEqual([]);
      // Так пишет чекпоинт прежняя версия плагина: три столбца, таблицу области она не знает.
      s.db.query('INSERT OR REPLACE INTO checkpoints VALUES (?,?,?)').run('legacy-write', 'от старого плагина', '2026-09-20T00:00:00.000Z');
      expect(s.checkpointView('').unscoped.summary).toBe('от старого плагина');
      expect((s.db.query("SELECT value FROM meta WHERE key='schema'").get() as any).value).toBe('2');
    } finally { s.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the git branch is read from files for a normal checkout, a worktree and a detached head', () => {
  const root = mkdtempSync(join(import.meta.dir, 'scope-test-'));
  try {
    expect(gitBranch(root)).toBeNull();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/feature/csv\n');
    expect(gitBranch(root)).toBe('feature/csv');
    writeFileSync(join(root, '.git/HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    expect(gitBranch(root)).toBe('0123456789ab');
    const wt = join(root, 'wt');
    mkdirSync(join(root, '.git/worktrees/wt'), { recursive: true });
    writeFileSync(join(root, '.git/worktrees/wt/HEAD'), 'ref: refs/heads/other\n');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), 'gitdir: ' + join(root, '.git/worktrees/wt') + '\n');
    expect(gitBranch(wt)).toBe('other');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
