import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/core';

// ЗАМЕРЕНО 2026-10-17 на живой базе HUICAD (audit/huicad-after-0.6.6/ОТЧЁТ.md). Воспроизводится
// та самая расстановка: один огромный эпизод плана, куда вложены ответы пользователя, и короткое
// исходное сообщение. Прежний поиск отдавал голову плана (совпадения в ней не видно) и терял
// короткое сообщение, потому что выдавал пять новейших.
const withStore = (fn: (s: MemoryStore) => void) => {
  const dir = mkdtempSync(join(import.meta.dir, 'episodes-test-'));
  const s = new MemoryStore(dir);
  try { fn(s); } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
};
const PHRASE = 'Будем собирать ядро сами и использовать OCCT';
const plan = 'Plan approved.\n' + 'x'.repeat(4400) + '\n' + PHRASE + '\n' + 'y'.repeat(32000);

describe('episode search', () => {
  test('the original user message outranks the huge plan that quotes it', () => withStore(s => {
    s.capture('old', 'user', plan);
    const original = s.capture('old', 'user', PHRASE + '. Основной стек это tauri rust + vue.');
    for (let i = 0; i < 8; i++) s.capture('new', 'assistant', 'Разбираю OCCT и ядро дальше, шаг ' + i);
    const out: any = s.episodes(PHRASE);
    expect(out.hits[0].id).toBe(original);
    // Новейшие записи больше не вытесняют старое основание.
    expect(out.hits.map((h: any) => h.id)).toContain(original);
    expect(out.total).toBeGreaterThan(out.shown);
  }));

  test('a match far inside a document is visible in the returned window', () => withStore(s => {
    s.capture('old', 'user', plan);
    const out: any = s.episodes(PHRASE);
    const hit = out.hits.find((h: any) => h.length === plan.length);
    expect(hit).toBeDefined();
    // Прежде здесь приходили первые 1600 символов, где искомого нет.
    expect(hit.text).toContain(PHRASE);
    expect(hit.offset).toBeGreaterThan(1600);
    expect(hit.length).toBe(plan.length);
    expect(hit.text.length).toBeLessThan(900);
  }));

  test('separate words match without the exact phrase', () => withStore(s => {
    const id = s.capture('s', 'user', 'Три независимых Git-репозитория: библиотека, программа и ядро.');
    const out: any = s.episodes('репозитории ядра');
    expect(out.hits[0].id).toBe(id);
  }));

  test('role filter returns only that side of the conversation', () => withStore(s => {
    s.capture('s', 'assistant', 'Зафиксировал hui-vue как UI-базу');
    const user = s.capture('s', 'user', 'Добавь что использовать ui будем hui-vue');
    const out: any = s.episodes('hui-vue', { role: 'user' });
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].id).toBe(user);
    expect(out.total).toBe(1);
  }));

  test('an id returns the whole episode, not a window', () => withStore(s => {
    const id = s.capture('s', 'user', plan);
    const out: any = s.episodes('', { id });
    expect(out.found).toBe(true);
    expect(out.length).toBe(plan.length);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(2400);
    expect(s.episodes('', { id: 'missing' })).toMatchObject({ found: false });
  }));

  test('an empty query lists the most recent episodes', () => withStore(s => {
    for (let i = 0; i < 7; i++) s.capture('s', 'user', 'сообщение ' + i);
    const out: any = s.episodes('');
    expect(out.shown).toBe(5);
    expect(out.total).toBe(7);
    expect(out.hits[0].text).toContain('сообщение 6');
  }));

  test('no match reports zero instead of an unrelated document', () => withStore(s => {
    s.capture('s', 'user', plan);
    const out: any = s.episodes('совершенно посторонний предмет');
    expect(out.total).toBe(0);
    expect(out.hits).toHaveLength(0);
  }));

  test('a quote with LIKE wildcards and backslashes is matched literally', () => withStore(s => {
    const id = s.capture('s', 'user', String.raw`путь C:\temp\100% готово`);
    expect((s.episodes(String.raw`C:\temp\100%`) as any).hits[0].id).toBe(id);
    expect((s.episodes('ggg_zzz') as any).total).toBe(0);
  }));
});
