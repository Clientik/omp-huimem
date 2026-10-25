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

  test('an id returns original text rather than a search window', () => withStore(s => {
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

test('an episode tail can be read verbatim after finding its search offset',()=>withStore(s=>{
  const quote='OCCT: выбираем ядро.';
  const original='x'.repeat(4600)+' '+quote+' '+'y'.repeat(2000);
  const id=s.capture('s','user',original);
  const search=s.episodes(quote);
  if(!('hits' in search)) throw new Error('Expected episode search results');
  const hit=search.hits[0];
  expect(hit.id).toBe(id);
  const options={id,offset:hit.offset};
  const tail=s.episodes('',options);
  if(!('text' in tail)) throw new Error('Expected an original episode page');
  expect(tail.text).toContain(quote);
  expect(tail.text).toBe(original.slice(hit.offset,hit.offset+2400));
}));

test('episode matching keeps short and technical tokens distinct',()=>withStore(s=>{
  const entries=[['Go','Генератор: Go.'],['Google','Google для поиска.'],['БД','БД проекта.'],
    ['C#','Пишем C#.'],['C++','Пишем C++.'],['на','на месте'],['журнал','журнал']];
  const ids=new Map(entries.map(([key,text])=>[key,s.capture('s','user',text)]));
  for(const query of ['Go','БД','C#','C++','на']) {
    const result=s.episodes(query);
    if(!('hits' in result)) throw new Error('Expected search results');
    expect(result.hits.map(h=>h.id)).toEqual([ids.get(query)]);
  }
}));

test('episode focus ignores substring distractions and chooses the earliest full-token window',()=>withStore(s=>{
  const text='20261 Google журнал '.repeat(180)+' 2026 Go рядом БД '+'x'.repeat(1500)+' Go рядом БД';
  const id=s.capture('s','user',text);
  for(const query of ['2026','Go БД']) {
    const result=s.episodes(query);
    if(!('hits' in result)) throw new Error('Expected search results');
    expect(result.hits[0].id).toBe(id);
    expect(result.hits[0].text).toContain(query==='2026' ? '2026 Go' : 'Go рядом БД');
    expect(result.hits[0].offset).toBeGreaterThan(3000);
    expect(result.hits[0].offset).toBeLessThan(4000);
  }
}));

test('episode pages reconstruct a long original without splitting a boundary emoji',()=>withStore(s=>{
  const original='a'.repeat(2399)+'😀'+'b'.repeat(3900);
  const id=s.capture('s','user',original);
  const first=s.episodes('',{id});
  if(!('text' in first)) throw new Error('Expected source page');
  expect(first).toMatchObject({offset:0,nextOffset:2399,truncated:true,role:'user'});
  expect(first.text).toBe('a'.repeat(2399));
  let offset=0,all='';
  for(let page=0;page<10;page++) {
    const result=s.episodes('',{id,offset});
    if(!('text' in result)) throw new Error('Expected source page');
    expect(result.offset).toBe(offset);
    expect(result.text).toBe(original.slice(offset,offset+result.text.length));
    all+=result.text;
    if(result.nextOffset===null) break;
    expect(result.nextOffset).toBeGreaterThan(offset);
    offset=result.nextOffset;
  }
  expect(all).toBe(original);
  for(const offset of [original.length,original.length+100]) {
    expect(s.episodes('',{id,offset})).toMatchObject({
      found:true,offset:original.length,nextOffset:null,length:original.length,text:'',truncated:true});
  }
  expect(s.episodes('',{id:'missing',offset:0})).toMatchObject({found:false});
}));

test('episode offsets reject invalid addresses, including a split surrogate pair',()=>withStore(s=>{
  const id=s.capture('s','user','a😀b');
  for(const offset of [-1,0.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity,2])
    expect(()=>s.episodes('',{id,offset})).toThrow('INVALID_EPISODE_OFFSET');
  expect(()=>s.episodes('',{offset:0})).toThrow('INVALID_EPISODE_OFFSET');
  expect(s.episodes('',{id,offset:1})).toMatchObject({offset:1,nextOffset:null,text:'😀b'});
  expect(s.episodes('',{id,offset:Number.MAX_SAFE_INTEGER})).toMatchObject({offset:4,nextOffset:null,text:''});
}));

test('episode page size keeps the bounded window contract',()=>withStore(s=>{
  const original='x'.repeat(6000),id=s.capture('s','user',original);
  for(const [window,size] of [[1,800],[700,2800],[700.1,2800],[2000,4000],[9000,4000]]) {
    const page=s.episodes('',{id,window});
    if(!('text' in page)) throw new Error('Expected source page');
    expect(page.text).toBe(original.slice(0,size));
    expect(page.nextOffset).toBe(size);
  }
}));

// ЗАМЕРЕНО 2026-10-24 в D:\NAPOLEONI: после сжатия истории задание в 51 KB перечитано 22 вызовами
// episodes id=… offset=…, потому что limit:12000 молча игнорировался и страница оставалась 2400.
test('an explicit limit sets the original page size within bounds',()=>withStore(s=>{
  const original=Array.from({length:30000},(_,i)=>String.fromCharCode(97+i%26)).join(''),id=s.capture('s','user',original);
  for(const [limit,size] of [[12000,12000],[50000,12000],[5,200],[3000,3000]]) {
    const page=s.episodes('',{id,offset:0,limit});
    if(!('text' in page)) throw new Error('Expected source page');
    expect(page.text).toBe(original.slice(0,size));
    expect(page.nextOffset).toBe(size);
  }
  expect(s.episodes('',{id,offset:24000,limit:12000})).toMatchObject({nextOffset:null,text:original.slice(24000)});
  expect(s.episodes('',{id})).toMatchObject({nextOffset:2400});
}));

test('episode search cursors can read original pages when window boundaries meet emoji',()=>withStore(s=>{
  const original='x'.repeat(4400)+'😀'+'z'.repeat(198)+' OCCT '+'w'.repeat(393)+'😀'+'y'.repeat(2000);
  const id=s.capture('s','user',original);
  const search=s.episodes('OCCT');
  if(!('hits' in search)) throw new Error('Expected search results');
  const hit=search.hits[0];
  const page=s.episodes('',{id,offset:hit.offset});
  if(!('text' in page)) throw new Error('Expected source page');
  expect(page.text).toContain('OCCT');
  expect(page.text).toBe(original.slice(hit.offset,hit.offset+page.text.length));
  expect(hit.text.isWellFormed()).toBe(true);
}));
