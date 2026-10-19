import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/core';

// ЗАМЕРЕНО 2026-10-19 на живом HUICAD (audit/huicad-after-0.6.7): сверить цитаты записей с
// сохранёнными сообщениями было нечем, и модель 17 раз открывала state.sqlite своим SQL.
const withStore = (fn: (s: MemoryStore, dir: string) => void) => {
  const dir = mkdtempSync(join(import.meta.dir, 'evidence-test-'));
  const s = new MemoryStore(dir);
  try { fn(s, dir); } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
};
const QUOTE = 'Бейдж референса оставляем 8.0.1';
const save = (s: MemoryStore, episode: string, over: Record<string, any> = {}) => {
  const change: any = { id: 'occt-version', kind: 'decision', status: 'accepted', expectedVersion: 0,
    text: 'Версия OCCT для референса — 8.0.1.', rationale: QUOTE, source: { episode, quote: QUOTE }, ...over };
  s.commit('run', [change], 'сохранено решение по версии OCCT');
  return change.id;
};

describe('evidence checks', () => {
  test('a record is confirmed against the message it quotes', () => withStore(s => {
    const episode = s.capture('run', 'user', '4. ' + QUOTE + '. Остальное на твоё усмотрение.');
    save(s, episode);
    const out: any = s.verifyRecord('occt-version');
    expect(out.match).toBe(true);
    expect(out.source).toBe('episode');
    expect(out.role).toBe('user');
    expect(out.version).toBe(1);
  }));

  test('a missing record and a missing episode are answers, not exceptions', () => withStore(s => {
    expect((s.verifyRecord('nothing') as any).exists).toBe(false);
    expect((s.episodeSource('5c9fd1f2-0000-4000-8000-000000000000', 'что угодно') as any).found).toBe(false);
  }));

  test('a quote absent from the message is reported, not thrown', () => withStore(s => {
    const episode = s.capture('run', 'user', QUOTE);
    const out: any = s.episodeSource(episode, 'Бейдж референса оставляем 9.0.0');
    expect(out.found).toBe(false);
    expect(out.role).toBe('user');
    expect(out.detail).toContain('absent');
  }));

  test('the matching part of a long message comes back in context', () => withStore(s => {
    const episode = s.capture('run', 'user', 'x'.repeat(5000) + QUOTE + 'y'.repeat(5000));
    const out: any = s.episodeSource(episode, QUOTE);
    expect(out.found).toBe(true);
    expect(out.at).toBeGreaterThan(4000);
    expect(out.context).toContain(QUOTE);
    expect(out.context.length).toBeLessThan(700);
    expect(out.characters).toBe(10000 + QUOTE.length);
  }));

  test('a record whose source file changed is unconfirmed with the reason', () => withStore((s, dir) => {
    mkdirSync(join(dir, '.memory'), { recursive: true });
    writeFileSync(join(dir, '.memory', 'DESIGN.md'), 'закрытия вкладок в tabs нет\n');
    s.commit('run', [{ id: 'tabs', kind: 'fact', status: 'active', expectedVersion: 0, text: 'В tabs нет закрытия вкладок.',
      source: s.fileSource('.memory/DESIGN.md', 'закрытия вкладок в tabs нет') }], 'факт о вкладках');
    expect((s.verifyRecord('tabs') as any).match).toBe(true);
    writeFileSync(join(dir, '.memory', 'DESIGN.md'), 'закрытия вкладок в tabs нет\nдописано позже\n');
    const out: any = s.verifyRecord('tabs');
    expect(out.match).toBe(false);
    expect(out.detail).toContain('changed');
    expect(out.path).toBe('.memory/DESIGN.md');
  }));

  test('the whole registry is checked in one call and the unconfirmed are named', () => withStore((s, dir) => {
    const episode = s.capture('run', 'user', '4. ' + QUOTE + '.');
    save(s, episode);
    mkdirSync(join(dir, '.memory'), { recursive: true });
    writeFileSync(join(dir, '.memory', 'DESIGN.md'), 'закрытия вкладок в tabs нет\n');
    s.commit('run2', [{ id: 'tabs', kind: 'fact', status: 'active', expectedVersion: 0, text: 'В tabs нет закрытия вкладок.',
      source: s.fileSource('.memory/DESIGN.md', 'закрытия вкладок в tabs нет') }], 'факт о вкладках');
    expect((s.verifyRecords() as any).unconfirmed).toEqual([]);
    writeFileSync(join(dir, '.memory', 'DESIGN.md'), 'переписано целиком\n');
    const out: any = s.verifyRecords();
    expect(out.records).toBe(2);
    expect(out.checked).toBe(2);
    expect(out.unconfirmed).toEqual(['tabs']);
    expect(out.results.find((r: any) => r.id === 'occt-version').match).toBe(true);
  }));

  // ЗАМЕРЕНО 2026-10-19 (audit/huicad-after-0.6.7): один ответ пользователя сохранён тремя
  // эпизодами — 16:33:54, 16:34:19, 16:34:51, — потому что OMP отдал ход трижды. Какой из трёх
  // ID «то самое сообщение», сказать было нельзя.
  test('the same message repeated within the window is one episode', () => withStore(s => {
    const first = s.capture('run', 'user', '1. Да\n2. Это репозиторий');
    expect(s.capture('run', 'user', '1. Да\n2. Это репозиторий')).toBe(first);
    expect(s.capture('run2', 'user', '1. Да\n2. Это репозиторий')).toBe(first);
    // Другая роль и другой текст — другие эпизоды.
    expect(s.capture('run', 'assistant', '1. Да\n2. Это репозиторий')).not.toBe(first);
    expect(s.capture('run', 'user', '1. Да')).not.toBe(first);
    expect((s.db.query('SELECT COUNT(*) n FROM episodes').get() as any).n).toBe(3);
    // За окном тот же текст — снова отдельное сообщение: «Продолжай» в разные дни не одно и то же.
    const old = new Date(Date.now() - MemoryStore.DEDUP_WINDOW_MS - 1000).toISOString();
    s.db.query('UPDATE episodes SET time=?').run(old);
    expect(s.capture('run', 'user', '1. Да\n2. Это репозиторий')).not.toBe(first);
  }));

  test('an evidence check leaves a receipt naming what was confirmed', () => withStore(s => {
    const episode = s.capture('run', 'user', '4. ' + QUOTE + '.');
    save(s, episode);
    const out: any = s.verifyRecords();
    s.recordEvidence('run:1', 'all records', out, out.results.map((r: any) => ({ id: r.id, version: r.version, match: r.match })));
    const receipt: any = s.lastRetrieval();
    expect(receipt.channel).toBe('tool-evidence');
    expect(receipt.counts).toEqual({ confirmed: 1, unconfirmed: 0 });
    expect(receipt.candidates[0]).toMatchObject({ id: 'occt-version', reason: 'confirmed', selectionBasis: ['evidence-check'] });
  }));
});
