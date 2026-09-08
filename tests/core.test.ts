import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore, architectureCheck } from '../src/memory/core';

test('canonical file change invalidates conversation records until explicitly revised', () => withStore((s,dir) => {
  writeFileSync(join(dir,'.memory/MEMORY.md'),'Provider: Stripe');
  s.commit('a',[fact(s)],'saved');
  expect(s.current('payments')?.freshness).not.toBe('STALE');
  writeFileSync(join(dir,'.memory/MEMORY.md'),'Provider: YooKassa');
  expect(s.current('payments')?.freshness).toBe('STALE');
  expect(s.recall('Платежи')).toContain('STALE');
  s.commit('b',[fact(s,'Платежи: YooKassa',1)],'rechecked against canonical file');
  expect(s.current('payments')?.freshness).not.toBe('STALE');
}));

const withStore = (fn: (s: MemoryStore, dir: string) => void) => {
  const dir = mkdtempSync(join(import.meta.dir, 'memory-test-'));
  const s = new MemoryStore(dir);
  try { fn(s, dir); } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
};
const fact = (s: MemoryStore, text = 'Платежи: Stripe', version = 0) => {
  const episode = s.capture('s', 'user', text);
  return { id: 'payments', kind: 'fact', text, status: 'active', expectedVersion: version,
    source: { episode, quote: text } };
};
test('restart retains records and checkpoints', () => withStore((s, dir) => {
  s.commit('run', [fact(s)], 'next: test'); s.close();
  const reopened = new MemoryStore(dir);
  expect(reopened.current('payments')?.version).toBe(1);
  expect(reopened.checkpoint('run')?.summary).toBe('next: test'); reopened.close();
}));
test('correction supersedes old value but preserves history', () => withStore(s => {
  s.commit('a', [fact(s)], 'saved'); s.commit('b', [fact(s, 'Платежи: YooKassa', 1)], 'changed');
  expect(s.recall('Платежи')).toContain('YooKassa');
  expect(s.recall('Платежи')).not.toContain('Stripe'); expect(s.history('payments').length).toBe(2);
}));
test('stale concurrent update rolls back complete batch', () => withStore((s, dir) => {
  const other = new MemoryStore(dir); const a = fact(s); s.commit('a', [a], 'first');
  expect(() => other.commit('b', [{ ...a, id: 'new' }, a], 'conflict')).toThrow('VERSION_CONFLICT');
  expect(other.current('new')).toBeNull(); expect(other.checkpoint('b')).toBeNull(); other.close();
}));
test('invented evidence and assistant acceptance rejected', () => withStore(s => {
  const a = fact(s); expect(() => s.commit('x', [{ ...a, source: { ...a.source, quote: 'Kafka' } }], 'bad')).toThrow('SOURCE');
  const episode = s.capture('s', 'assistant', 'Use Kafka');
  expect(() => s.commit('x', [{ ...a, kind: 'decision', status: 'accepted', rationale: 'fast', source: { episode, quote: 'Use Kafka' } }], 'bad')).toThrow('USER_SOURCE');
}));
test('file evidence becomes stale on change and blocks unsupported hash', () => withStore((s, dir) => {
  writeFileSync(join(dir, 'app.ts'), 'export const db = "sqlite";');
  const source = s.fileSource('app.ts', 'sqlite');
  s.commit('a', [{ id: 'db', kind: 'fact', status: 'active', text: 'Uses sqlite', expectedVersion: 0, source }], 'saved');
  writeFileSync(join(dir, 'app.ts'), 'export const db = "postgres";');
  expect(s.recall('db')).toContain('STALE');
  expect(() => s.commit('b', [{ id: 'db2', kind: 'fact', status: 'active', text: 'Uses sqlite', expectedVersion: 0, source }], 'bad')).toThrow('SOURCE');
}));
test('read-only failure has no successful checkpoint', () => withStore(s => {
  const a = fact(s); s.db.exec('PRAGMA query_only = ON');
  expect(() => s.commit('bad', [a], 'saved')).toThrow(); expect(s.checkpoint('bad')).toBeNull();
}));
test('closed database can move with project', () => withStore((s, dir) => {
  s.commit('a', [fact(s)], 'saved'); s.close();
  const moved = dir + '-moved'; renameSync(dir, moved);
  try { const next = new MemoryStore(moved); expect(next.current('payments')?.version).toBe(1); next.close(); }
  finally { renameSync(moved, dir); }
}));
test('architecture violations are checked against actual files', () => withStore((_s, dir) => {
  mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'src/ui.ts'), 'import db from "server/db";');
  const policy = { configured: true, rules: [{ id: 'ui-no-db', files: ['src/ui.ts'], forbidden: 'server/db', reason: 'UI uses API' }] };
  expect(architectureCheck(dir, policy).ok).toBe(false);
  writeFileSync(join(dir, 'src/ui.ts'), 'import api from "client/api";');
  expect(architectureCheck(dir, policy).ok).toBe(true);
  expect(architectureCheck(dir, { configured: false, rules: [] }).configured).toBe(false);
}));
test('bounded recall, literal Russian retrieval, path traversal rejection', () => withStore(s => {
  s.commit('a', [fact(s, 'Причина отказа: задержка очереди')], 'done');
  expect(s.recall('причина')).toContain('задержка'); expect(s.recall('причина', 100).length).toBeLessThanOrEqual(100);
  expect(() => s.fileSource('../outside.txt', 'secret')).toThrow('PATH');
}));
test('accepted decision rationale must actually occur in its evidence', () => withStore(s => {
  const episode = s.capture('s', 'user', 'Use Postgres. Reason: transactions.');
  const d = { id:'db-decision',kind:'decision',status:'accepted',text:'Use Postgres',expectedVersion:0,
    rationale:'transactions',source:{episode,quote:'Use Postgres. Reason: transactions.'} };
  s.commit('a',[d],'saved');
  expect(() => s.commit('b',[{...d,id:'invented',rationale:'because MongoDB is slow'}],'bad')).toThrow('RATIONALE_SOURCE');
}));
test('direct ID recall also signals changed file', () => withStore((s,dir) => {
  writeFileSync(join(dir,'src.txt'),'old'); const source = s.fileSource('src.txt','old');
  s.commit('a',[{id:'source',kind:'fact',status:'active',text:'old',expectedVersion:0,source}],'saved');
  writeFileSync(join(dir,'src.txt'),'new'); expect(s.current('source')?.freshness).toBe('STALE');
}));
