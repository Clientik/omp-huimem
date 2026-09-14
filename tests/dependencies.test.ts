import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/core';

// Точные зависимости оснований (пункт 5, 14 сентября): запись зависит от версии другой записи или
// от хеша файла. Изменение основания делает устаревшей только зависимую запись и называет причину.
function fixture(fn: (s: MemoryStore, root: string) => void) {
  const root = mkdtempSync(join(import.meta.dir, 'deps-test-'));
  mkdirSync(join(root, '.memory/adr'), { recursive: true });
  const s = new MemoryStore(root);
  try { fn(s, root); } finally { s.close(); rmSync(root, { recursive: true, force: true }); }
}
function decision(s: MemoryStore, id: string, quote: string, rationale: string, extra: any = {}, expectedVersion = 0, status = 'accepted') {
  const episode = s.capture('t', 'user', quote);
  return { id, kind: 'decision', status, text: quote, rationale, expectedVersion, source: { episode, quote }, ...extra };
}
const reasons = (s: MemoryStore, id: string) => (s.current(id) as any).staleReasons ?? [];

test('changing A makes only its dependant B stale, with the reason; independent C stays fresh', () => fixture((s, root) => {
  s.commit('1', [decision(s, 'db', 'Берём PostgreSQL. Причина: транзакции.', 'транзакции', { dependsOn: [] })], 'db');
  s.commit('2', [decision(s, 'orm', 'ORM — Drizzle. Причина: работает с PostgreSQL.', 'работает с PostgreSQL', { dependsOn: [{ id: 'db' }] }),
    decision(s, 'ui', 'UI на Svelte. Причина: команда знает.', 'команда знает', { dependsOn: [] })], 'orm and ui');
  expect(s.current('orm')!.dependsOn).toEqual([{ id: 'db', version: 1 }]);
  // Постороннее изменение канонических документов больше не трогает записи с явными зависимостями.
  writeFileSync(join(root, '.memory/adr/0009-unrelated.md'), '# unrelated');
  writeFileSync(join(root, '.memory/MEMORY.md'), 'changed');
  for (const id of ['db', 'orm', 'ui']) expect(s.current(id)!.freshness).not.toBe('STALE');

  s.commit('3', [decision(s, 'db', 'Переходим на SQLite. Причина: один файл.', 'один файл', { dependsOn: [] }, 1)], 'db v2');
  expect(s.current('orm')!.freshness).toBe('STALE');
  expect(reasons(s, 'orm')).toEqual(['db changed: version 1 -> 2']);
  expect(s.current('ui')!.freshness).not.toBe('STALE');
  const line = s.recall('ORM Drizzle').split('\n').find(l => l.includes('"id":"orm"'))!;
  expect(JSON.parse(line).staleBecause).toEqual(['db changed: version 1 -> 2']);
  const ui = JSON.parse(s.recall('UI Svelte').split('\n').find(l => l.includes('"id":"ui"'))!);
  expect(ui.freshness).not.toContain('STALE');
  expect(ui.staleBecause).toBeUndefined();
}));

test('retirement, deletion and restoration of a dependency are explained, and staleness propagates along the chain', () => fixture(s => {
  s.commit('1', [decision(s, 'a', 'A. Причина: основа.', 'основа', { dependsOn: [] })], 'a');
  s.commit('2', [decision(s, 'b', 'B. Причина: из A.', 'из A', { dependsOn: [{ id: 'a' }] })], 'b');
  s.commit('3', [decision(s, 'c', 'C. Причина: из B.', 'из B', { dependsOn: [{ id: 'b' }] })], 'c');
  s.commit('4', [decision(s, 'a', 'A. Причина: основа.', 'основа', { dependsOn: [] }, 1, 'retired')], 'retire a');
  expect(reasons(s, 'b')).toEqual(['a was retired in version 2']);
  expect(reasons(s, 'c')).toEqual(['b is STALE (a was retired in version 2)']);

  const saved = s.db.query("SELECT * FROM versions WHERE id='a'").all() as any[];
  s.db.query("DELETE FROM versions WHERE id='a'").run();
  expect(reasons(s, 'b')).toEqual(['a is missing']);
  for (const r of saved) s.db.query('INSERT INTO versions VALUES (?,?,?,?)').run(r.id, r.version, r.data, r.time);
  s.db.query("DELETE FROM versions WHERE id='a' AND version=2").run();
  // Восстановленная ровно та версия, на которую ссылалась B, снова считается действующим основанием.
  expect(s.current('b')!.freshness).not.toBe('STALE');
  expect(s.current('c')!.freshness).not.toBe('STALE');
}));

test('cycles terminate: a consistent cycle is fresh, and updating one member explains the other', () => fixture(s => {
  s.commit('1', [decision(s, 'x', 'X. Причина: вместе с Y.', 'вместе с Y', { dependsOn: [{ id: 'y' }] }),
    decision(s, 'y', 'Y. Причина: вместе с X.', 'вместе с X', { dependsOn: [{ id: 'x' }] })], 'cycle');
  expect(s.current('x')!.dependsOn).toEqual([{ id: 'y', version: 1 }]);
  expect(s.current('x')!.freshness).not.toBe('STALE');
  s.commit('2', [decision(s, 'x', 'X2. Причина: вместе с Y.', 'вместе с Y', { dependsOn: [{ id: 'y' }] }, 1)], 'x v2');
  expect(reasons(s, 'y')).toEqual(['x changed: version 1 -> 2']);
  expect(reasons(s, 'x')).toEqual(['y is STALE (x changed: version 1 -> 2)']);
  expect(() => s.commit('3', [decision(s, 'z', 'Z. Причина: сам.', 'сам', { dependsOn: [{ id: 'z' }] })], 'self')).toThrow('cannot depend on itself');
}));

test('file dependencies pin a hash; wrong, missing or stale references are refused before anything is saved', () => fixture((s, root) => {
  writeFileSync(join(root, '.memory/adr/0001-db.md'), '# 0001\nPostgreSQL');
  s.commit('1', [decision(s, 'db', 'Берём PostgreSQL. Причина: транзакции.', 'транзакции', { dependsOn: [{ path: '.memory/adr/0001-db.md' }] })], 'db');
  expect((s.current('db')!.dependsOn as any)[0].hash).toMatch(/^[0-9a-f]{64}$/);
  writeFileSync(join(root, '.memory/adr/0002-other.md'), '# other');
  expect(s.current('db')!.freshness).not.toBe('STALE');
  writeFileSync(join(root, '.memory/adr/0001-db.md'), '# 0001\nSQLite');
  expect(reasons(s, 'db')).toEqual(['file .memory/adr/0001-db.md changed']);
  rmSync(join(root, '.memory/adr/0001-db.md'));
  expect(reasons(s, 'db')).toEqual(['file .memory/adr/0001-db.md is missing or unreadable']);

  const bad = (dependsOn: any) => () => s.commit('x', [decision(s, 'n', 'N. Причина: п.', 'п', { dependsOn })], 'n');
  expect(bad([{ id: 'nope' }])).toThrow('MISSING_DEPENDENCY');
  expect(bad([{ id: 'db', version: 7 }])).toThrow('DEPENDENCY_VERSION');
  expect(bad([{ path: '.memory/adr/none.md' }])).toThrow();
  expect(bad([{ id: 'db', path: 'x' }])).toThrow('INVALID_DEPENDENCIES');
  expect(bad('db')).toThrow('INVALID_DEPENDENCIES');
  s.commit('r', [decision(s, 'old', 'Old. Причина: было.', 'было', { dependsOn: [] })], 'old');
  s.commit('r2', [decision(s, 'old', 'Old. Причина: было.', 'было', { dependsOn: [] }, 1, 'retired')], 'retire');
  expect(bad([{ id: 'old' }])).toThrow('DEPENDENCY_RETIRED');
  expect(s.current('n')).toBeNull();
  expect(s.checkpoint('x')).toBeNull();
}));

test('staleness clears only through a new version that repins the current basis; history keeps the old pin', () => fixture(s => {
  s.commit('1', [decision(s, 'db', 'PostgreSQL. Причина: транзакции.', 'транзакции', { dependsOn: [] })], 'db');
  s.commit('2', [decision(s, 'orm', 'Drizzle. Причина: PostgreSQL.', 'PostgreSQL', { dependsOn: [{ id: 'db' }] })], 'orm');
  s.commit('3', [decision(s, 'db', 'SQLite. Причина: один файл.', 'один файл', { dependsOn: [] }, 1)], 'db v2');
  // Возврат прежнего текста — новая версия, а не прежнее основание: STALE сам не снимается.
  s.commit('4', [decision(s, 'db', 'PostgreSQL. Причина: транзакции.', 'транзакции', { dependsOn: [] }, 2)], 'db v3');
  expect(reasons(s, 'orm')).toEqual(['db changed: version 1 -> 3']);
  // Переподтверждение — обычный commit: цитата проверяется, зависимость закрепляется на текущей версии.
  expect(() => s.commit('5', [{ ...decision(s, 'orm', 'Drizzle. Причина: PostgreSQL.', 'PostgreSQL', { dependsOn: [{ id: 'db' }] }, 1),
    source: { episode: 'forged', quote: 'Drizzle' } }], 'forged')).toThrow('SOURCE');
  expect(s.current('orm')!.freshness).toBe('STALE');
  s.commit('6', [decision(s, 'orm', 'Drizzle. Причина: PostgreSQL.', 'PostgreSQL', { dependsOn: [{ id: 'db', version: 3 }] }, 1)], 'reconfirmed');
  expect(s.current('orm')!.freshness).not.toBe('STALE');
  const history = s.history('orm').map((h: any) => JSON.parse(h.data).dependsOn);
  expect(history).toEqual([[{ id: 'db', version: 1 }], [{ id: 'db', version: 3 }]]);
}));

test('records saved without dependsOn keep the earlier conservative rule', () => fixture((s, root) => {
  s.commit('1', [decision(s, 'legacy', 'Legacy. Причина: давно.', 'давно')], 'legacy');
  expect(s.current('legacy')!.dependsOn).toBeUndefined();
  writeFileSync(join(root, '.memory/adr/0003-any.md'), '# any');
  expect(reasons(s, 'legacy')).toEqual(['canonical project documents changed since this record was saved']);
}));
