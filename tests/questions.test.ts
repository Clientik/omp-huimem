import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/core';
import { diagnoseMemory } from '../src/memory/doctor';

// ЗАМЕРЕНО 2026-10-19 на живом HUICAD (audit/huicad-after-0.6.7): девять вопросов, от которых
// зависело содержание 45 КБ архитектурного документа, нигде в памяти не существовали. Они выжили
// прозой — в сводке чекпоинта, в §19 документа и строкой «[?] уточнить — вопрос 3 сообщения
// 42bc704f без ответа» в DESIGN.md, то есть там, где правила велят прозе не доверять.
const withStore = (fn: (s: MemoryStore, dir: string) => void) => {
  const dir = mkdtempSync(join(import.meta.dir, 'questions-test-'));
  const s = new MemoryStore(dir);
  try { fn(s, dir); } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
};
const ask = (s: MemoryStore, id: string, text: string, status = 'open', version = 0, links?: string[]) => {
  const episode = s.capture('run', 'assistant', 'Нужны твои решения. ' + text);
  s.commit('run', [{ id, kind: 'question', status, text, expectedVersion: version,
    ...(links ? { links } : {}), source: { episode, quote: text } }], 'вопрос пользователю');
};

describe('open questions', () => {
  test('a question is saved from your own message and cannot be accepted or active', () => withStore(s => {
    ask(s, 'modelling-kind', 'Параметрическая история или прямое моделирование?');
    expect(s.current('modelling-kind')).toMatchObject({ kind: 'question', status: 'open', version: 1 });
    const episode = s.capture('run', 'assistant', 'Моё предложение: прямое моделирование.');
    expect(() => s.commit('run', [{ id: 'bad', kind: 'question', status: 'accepted', expectedVersion: 0,
      text: 'x', source: { episode, quote: 'Моё предложение' } }], 'x')).toThrow('INVALID_STATUS');
    expect(() => s.commit('run', [{ id: 'bad', kind: 'guess', status: 'open', expectedVersion: 0,
      text: 'x', source: { episode, quote: 'Моё предложение' } }], 'x')).toThrow('INVALID_KIND');
  }));

  test('an open question is pinned into the block even when it matches nothing', () => withStore(s => {
    const episode = s.capture('run', 'user', 'Делаем экспорт счетов в PDF.');
    s.commit('run', [{ id: 'export-pdf', kind: 'decision', status: 'accepted', expectedVersion: 0,
      text: 'Экспорт счетов в PDF.', rationale: 'экспорт счетов в PDF', source: { episode, quote: 'Делаем экспорт счетов в PDF' } }], 'решение');
    ask(s, 'modelling-kind', 'Параметрическая история или прямое моделирование?');
    const text = s.recallDetailed('экспорт счетов', 4000).text;
    const ids = text.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
    expect(ids.map(r => r.id)).toContain('modelling-kind');
    // Вопрос виден вместе с текстом: именно он и есть содержание записи.
    expect(text).toContain('Параметрическая история или прямое моделирование?');
    expect(ids.find(r => r.id === 'modelling-kind').status).toBe('open');
  }));

  test('an answered question stops being pinned and keeps the link to what it decided', () => withStore(s => {
    ask(s, 'modelling-kind', 'Параметрическая история или прямое моделирование?');
    const answer = s.capture('run', 'user', '6. Прямое моделирование. Но размеры рядом с линией полезны.');
    s.commit('run', [{ id: 'direct-modelling', kind: 'decision', status: 'accepted', expectedVersion: 0,
      text: 'Прямое моделирование, без истории построения.', rationale: 'Прямое моделирование',
      source: { episode: answer, quote: '6. Прямое моделирование.' } }], 'ответ на вопрос');
    ask(s, 'modelling-kind', 'Параметрическая история или прямое моделирование?', 'answered', 1, ['direct-modelling']);
    const record: any = s.current('modelling-kind');
    expect(record).toMatchObject({ status: 'answered', version: 2 });
    expect(record.links).toEqual(['direct-modelling']);
    const ids = s.recallDetailed('совсем другое', 4000).text.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l).id);
    expect(ids).not.toContain('modelling-kind');
    expect(ids).toContain('direct-modelling');
  }));

  // ЗАМЕРЕНО 2026-10-19 (audit/huicad-after-0.6.7): ответ пришёл номерами — «1. Да 2. У тебя уже
  // есть репозиторий…» — и цитата «Это репозиторий» сама по себе не доказывает ничего. Связь
  // с вопросом модель восстановила рукой: «[?] сопоставлено по номеру пункта со вторым вопросом
  // сообщения ассистента 42bc704f» в MEMORY.md и ADR 0003.
  test('a numbered answer carries the message it answers', () => withStore(s => {
    const asked = s.capture('run', 'assistant', '2. hui-vue — это и есть UI-репозиторий из трёх?');
    const answer = s.capture('run', 'user', '1. Да\n2. Это репозиторий\n3. На твоё усмотрение');
    s.commit('run', [{ id: 'hui-vue-is-ui-repo', kind: 'decision', status: 'accepted', expectedVersion: 0,
      text: 'hui-vue и есть UI-репозиторий из трёх.', rationale: 'Это репозиторий',
      source: { episode: answer, quote: '2. Это репозиторий', answers: asked } }], 'ответ пользователя');
    const record: any = s.current('hui-vue-is-ui-repo');
    expect(record.source.answers).toBe(asked);
    // Сама запись проверяется как прежде, и связь видна вместе с ней.
    expect((s.verifyRecord('hui-vue-is-ui-repo') as any).match).toBe(true);
    expect(s.recallDetailed('репозиторий', 4000).text).toContain(asked);
  }));

  test('answers must name your own earlier message', () => withStore(s => {
    const answer = s.capture('run', 'user', '1. Да');
    const later = s.capture('run', 'assistant', 'Вопрос, заданный уже после ответа');
    const other = s.capture('run', 'user', 'Другое сообщение пользователя');
    const save = (answers: string) => s.commit('run', [{ id: 'q', kind: 'fact', status: 'active', expectedVersion: 0,
      text: 'Ответ «да».', source: { episode: answer, quote: '1. Да', answers } }], 'x');
    expect(() => save('нет такого')).toThrow('answers must name a saved message');
    expect(() => save(other)).toThrow('answers must name your own message');
    expect(() => save(later)).toThrow('written after the answer');
  }));

  test('doctor names what is waiting for the user and an answer that changed nothing', () => withStore((s, dir) => {
    writeFileSync(join(dir, '.memory/MEMORY.md'), '# Память проекта\n');
    ask(s, 'modelling-kind', 'Параметрическая история или прямое моделирование?');
    ask(s, 'package-name', 'Как назвать npm-пакет?');
    ask(s, 'clone-path', 'Куда клонировать hui-vue?', 'answered', 0);
    s.close();
    const report = diagnoseMemory(dir);
    const open = report.issues.find(i => i.code === 'QUESTIONS_OPEN')!;
    expect(open.severity).toBe('info');
    expect(open.message).toContain('2 question(s) are waiting for the user');
    expect(open.message).toContain('modelling-kind');
    const lost = report.issues.find(i => i.code === 'ANSWER_WITHOUT_RECORD')!;
    expect(lost.severity).toBe('warning');
    expect(lost.message).toContain('clone-path');
  }));
});
