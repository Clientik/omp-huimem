import { test, expect, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { apply, audit, eligible, mentions, migrate, plan, publishPlan } from '../src/memory/adr-audit';
import { readBasis } from '../src/memory/provenance';
import { MemoryStore } from '../src/memory/core';

// Фикстура — та самая форма загрязнённого ADR из audit/legacy-evidence-20260910.
const ADR = '.memory/adr/0001-max-retry-attempts.md';
const LEGACY = [
  '# ADR 0001: Максимум 7 попыток повторной отправки',
  '',
  '- Статус: принято',
  '- Причина: шлюз Берилл-42 удерживает окно дедупликации 19 минут, поэтому',
  '  большее число попыток попадает в дедупликацию.',
  '- Альтернативы: оставить 3 (менее устойчиво к сбоям).',
  '',
].join('\n');
const QUOTE = 'Для этого сервиса выбираем максимум 7 попыток повторной отправки. Причина: шлюз Берилл-42 удерживает окно дедупликации 19 минут.';
const decision = (over: any = {}) => ({ id: 'fact-retry', version: 1, data: {
  kind: 'decision', status: 'accepted', text: 'maxAttempts = 7. ADR ' + ADR,
  rationale: 'шлюз Берилл-42 удерживает окно дедупликации 19 минут',
  source: { episode: 'ep-1', quote: QUOTE }, ...over } });

test('a legacy ADR gets the registry quote as its basis and keeps every original line', () => {
  const item = plan(ADR, LEGACY, [decision()], '2026-09-14');
  expect(item.state).toBe('migratable');
  if (item.state !== 'migratable') return;
  const basis = readBasis(item.proposed);
  expect(basis.section).toBe(true);
  expect(basis.quotes.join('\n')).toBe(QUOTE);          // побайтово как в реестре
  const rest = LEGACY.split('\n').slice(1).join('\n');
  expect(item.proposed.endsWith(rest)).toBe(true);        // проза целиком, в прежнем порядке
  // Дописанная причинная связь осталась, но только после заголовка интерпретации.
  const interp = item.proposed.indexOf('## Интерпретация [?]');
  expect(item.proposed.indexOf('попадает в дедупликацию')).toBeGreaterThan(interp);
  expect(item.proposed.startsWith('# ADR 0001')).toBe(true);
});

test('a document that already has a basis section is left alone', () => {
  const withBasis = '# 0002\n\n## Основание\n> «цитата»\n';
  expect(plan('.memory/adr/0002.md', withBasis, [decision()], 'd').state).toBe('has-basis');
});

test('no matching decision means no proposal, not a guessed basis', () => {
  const item = plan(ADR, LEGACY, [decision({ text: 'совсем другое решение без пути' })], 'd');
  expect(item.state).toBe('no-match');
  expect((item as any).proposed).toBeUndefined();
});

test('two decisions pointing at one ADR are reported as ambiguous and nothing is chosen', () => {
  const second = { ...decision(), id: 'fact-retry-2' };
  const item = plan(ADR, LEGACY, [decision(), second], 'd');
  expect(item.state).toBe('ambiguous');
  expect((item as any).candidates.sort()).toEqual(['fact-retry', 'fact-retry-2']);
});

test('only accepted, user-sourced decisions whose rationale is inside the quote qualify', () => {
  expect(eligible(decision().data)).toBe(true);
  expect(eligible(decision({ status: 'proposed' }).data)).toBe(false);
  expect(eligible(decision({ source: { path: 'a.md', hash: 'h', quote: QUOTE } }).data)).toBe(false);
  expect(eligible(decision({ rationale: 'большее число попыток попадает в дедупликацию' }).data)).toBe(false);
});

test('a link must name the document; shared words are not a match', () => {
  expect(mentions({ text: 'Берилл-42, окно дедупликации, 7 попыток' }, ADR)).toBe(false);
  expect(mentions({ text: 'x', links: ['0001-max-retry-attempts.md'] }, ADR)).toBe(true);
  expect(mentions({ text: 'см. .memory\\adr\\0001-max-retry-attempts.md' }, ADR)).toBe(true);
});

test('ADR references do not match another directory or path prefix',()=>{
  expect(mentions({links:['other/0001-max-retry-attempts.md']},ADR)).toBe(false);
  expect(mentions({links:['0001-max-retry-attempts.md']},'.memory/adr/nested/0001-max-retry-attempts.md')).toBe(false);
  expect(mentions({text:ADR+'.backup'},ADR)).toBe(false);
  expect(mentions({text:'other/'+ADR},ADR)).toBe(false);
  expect(mentions({text:'See `'+ADR+'`.'},ADR)).toBe(true);
});

test('a changed source and an occupied backup are never overwritten',()=>{
  const dir=mkdtempSync(join(import.meta.dir,'adr-safe-'));
  try {
    mkdirSync(join(dir,'.memory/adr'),{recursive:true});
    writeFileSync(join(dir,ADR),LEGACY);
    const item=plan(ADR,LEGACY,[decision()],'d');
    if(item.state!=='migratable') throw new Error('fixture');
    writeFileSync(join(dir,ADR),LEGACY+'concurrent edit');
    expect(()=>publishPlan(dir,item,'stamp')).toThrow('ADR_CHANGED');
    expect(readFileSync(join(dir,ADR),'utf8')).toBe(LEGACY+'concurrent edit');
    writeFileSync(join(dir,ADR),LEGACY);
    mkdirSync(join(dir,'.memory/adr-backup/stamp'),{recursive:true});
    const backup=join(dir,'.memory/adr-backup/stamp/0001-max-retry-attempts.md');
    writeFileSync(backup,'existing backup');
    expect(()=>publishPlan(dir,item,'stamp')).toThrow();
    expect(readFileSync(backup,'utf8')).toBe('existing backup');
    expect(readFileSync(join(dir,ADR),'utf8')).toBe(LEGACY);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('backup junctions cannot redirect migration outside the project',()=>{
  const dir=mkdtempSync(join(import.meta.dir,'adr-safe-'));
  const outside=mkdtempSync(join(import.meta.dir,'adr-outside-'));
  try {
    mkdirSync(join(dir,'.memory/adr'),{recursive:true});
    writeFileSync(join(dir,ADR),LEGACY);
    symlinkSync(outside,join(dir,'.memory/adr-backup'),'junction');
    expect(()=>apply(dir,[decision()],'d','stamp')).toThrow();
    expect(existsSync(join(outside,'stamp'))).toBe(false);
    expect(readFileSync(join(dir,ADR),'utf8')).toBe(LEGACY);
  } finally {rmSync(dir,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test('an edit during backup publication causes a conflict and preserves both versions',()=>{
  const dir=mkdtempSync(join(import.meta.dir,'adr-race-'));
  const sync=fs.fsyncSync; let changed=false;
  mkdirSync(join(dir,'.memory/adr'),{recursive:true});
  writeFileSync(join(dir,ADR),LEGACY);
  const hook=spyOn(fs,'fsyncSync').mockImplementation(fd=>{
    sync(fd);
    if(!changed) {changed=true;writeFileSync(join(dir,ADR),LEGACY+'external edit');}
  });
  try {
    const result=apply(dir,[decision()],'d','stamp');
    expect(changed).toBe(true);
    expect(result.written).toEqual([]);
    expect(result.skipped[0].state).toBe('conflict');
    expect(readFileSync(join(dir,ADR),'utf8')).toBe(LEGACY+'external edit');
    expect(readFileSync(join(dir,'.memory/adr-backup/stamp/0001-max-retry-attempts.md'),'utf8')).toBe(LEGACY);
  } finally {hook.mockRestore();rmSync(dir,{recursive:true,force:true});}
});

test('CRLF documents stay CRLF and multi-line quotes become one quote line each', () => {
  const crlf = LEGACY.split('\n').join('\r\n');
  const out = migrate(crlf, { id: 'r', version: 2, episode: 'e', quote: 'первая строка\nвторая строка' }, 'd');
  expect(out.includes('\r\n')).toBe(true);
  expect(out.replace(/\r\n/g, '').includes('\n')).toBe(false);
  expect(readBasis(out.replace(/\r\n/g, '\n')).quotes).toEqual(['первая строка', 'вторая строка']);
});

test('apply backs up the original byte for byte outside the ADR folder and is idempotent', async () => {
  const dir = mkdtempSync(join(import.meta.dir, 'adr-audit-'));
  try {
    mkdirSync(join(dir, '.memory/adr'), { recursive: true });
    writeFileSync(join(dir, '.memory/MEMORY.md'), '# Память');
    writeFileSync(join(dir, ADR), LEGACY);
    writeFileSync(join(dir, '.memory/adr/README.md'), '# Архитектурные решения\n');
    const store = new MemoryStore(dir);
    const episode = store.capture('run', 'user', QUOTE);
    store.commit('run:0', [{ id: 'fact-retry', kind: 'decision', status: 'accepted', expectedVersion: 0,
      text: 'maxAttempts = 7. ADR ' + ADR, rationale: 'шлюз Берилл-42 удерживает окно дедупликации 19 минут',
      source: { episode, quote: QUOTE } } as any], 'decision');
    expect(store.current('fact-retry')!.freshness).not.toBe('STALE');

    const planned = audit(dir, store.latestRecords(), '2026-09-14');
    expect(planned.map(i => i.path)).toEqual([ADR]);      // README не аудитируется
    const result = apply(dir, store.latestRecords(), '2026-09-14', 'stamp-1');
    expect(result.written).toHaveLength(1);
    const backup = join(dir, result.written[0].backup);
    expect(result.written[0].backup.startsWith('.memory/adr-backup/')).toBe(true);
    expect(readFileSync(backup, 'utf8')).toBe(LEGACY);
    expect(readBasis(readFileSync(join(dir, ADR), 'utf8')).quotes.join('\n')).toBe(QUOTE);

    // Резервная копия не попадает в следующий аудит, повторный запуск ничего не переписывает.
    const again = apply(dir, store.latestRecords(), '2026-09-14', 'stamp-2');
    expect(again.written).toHaveLength(0);
    expect(again.skipped.map(i => i.state)).toEqual(['has-basis']);
    expect(existsSync(join(dir, '.memory/adr-backup/stamp-2'))).toBe(false);

    // Ожидаемое следствие: решение из разговора следит за хешем канонических документов.
    expect(store.current('fact-retry')!.freshness).toBe('STALE');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
