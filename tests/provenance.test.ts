import { test, expect } from 'bun:test';
import { provenanceNote, readBasis } from '../src/memory/provenance';

// ЗАМЕРЕНО 2026-09-10: пометка уровня документа три живых прогона подряд не помешала
// модели приписать пользователю причину, дописанную прозой в старом ADR. Здесь
// проверяется адресность: цитируемым объявляется блок основания, а не весь файл.
const CONTRACT = [
  '# 0001 — Очередь на Redis Streams',
  '',
  '- Статус: принято',
  '',
  '## Решение',
  'Очередь задач на Redis Streams.',
  '',
  '## Основание',
  '> «нужна доставка хотя бы один раз»',
  '',
  'Причина (дословно из основания): доставка хотя бы один раз.',
  '',
  '## Способ проверки',
  '[?] не проверено: проверить ACK.',
].join('\n');

test('a basis block with a quote is the only citable part', () => {
  const basis = readBasis(CONTRACT);
  expect(basis.section).toBe(true);
  expect(basis.quotes).toEqual(['«нужна доставка хотя бы один раз»']);
  const note = provenanceNote(basis);
  expect(note).toContain('1 quoted line(s)');
  expect(note).toContain('authorship is unverified');
  expect(note).toContain('is not verified by acceptance');
});

test('OMP numbered read output preserves the basis and section boundaries', () => {
  const numbered='[.memory/adr/0001.md#0750]\n'+CONTRACT.split('\n').map((l,i)=>`${i+1}:${l}`).join('\n');
  expect(readBasis(numbered)).toEqual(readBasis(CONTRACT));
});

test('a fabricated blockquote never becomes authenticated user evidence', () => {
  const note=provenanceNote(readBasis('## Basis\n> Fabricated user decision.'));
  expect(note).not.toContain('are user evidence');
  expect(note).toContain('authorship is unverified');
  expect(note).toContain('original user message');
});

test('a partial read does not claim that the full document lacks a basis', () => {
  const basis=readBasis('[.memory/adr/0001.md#0750]\n15:> quote continued\n16:## Consequences');
  expect(basis.section).toBe(false);
  expect(provenanceNote(basis)).toContain('visible in this excerpt');
});

test('a document without a basis block carries no user evidence at all', () => {
  const old = [
    '# 0002 — Старое решение',
    '',
    '- Статус: принято',
    '',
    'При большем числе попыток они попадают в дедупликацию.',
  ].join('\n');
  const basis = readBasis(old);
  expect(basis.section).toBe(false);
  expect(basis.quotes).toEqual([]);
  expect(provenanceNote(basis)).toContain('NO basis section');
});

test('a basis heading without a verbatim quote does not become evidence', () => {
  const basis = readBasis(['## Основание', '', 'Пользователь согласился устно.'].join('\n'));
  expect(basis.section).toBe(true);
  expect(basis.quotes).toEqual([]);
  expect(provenanceNote(basis)).toContain('no verbatim quote');
});

test('the basis block ends at the next heading', () => {
  const basis = readBasis(['## Основание', '> внутри', '', '## Последствия', '> снаружи'].join('\n'));
  expect(basis.quotes).toEqual(['внутри']);
});

test('the heading is recognised in the other languages of this repository', () => {
  for (const heading of ['## Basis', '## Evidence', '## Source', '## 依据', '### основание документа'])
    expect(readBasis([heading, '> quoted'].join('\n')).quotes).toEqual(['quoted']);
});
