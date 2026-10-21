import { Database } from 'bun:sqlite';
import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/core';

function fixture(fn:(s:MemoryStore,dir:string)=>void) {
  const dir=mkdtempSync(join(import.meta.dir,'history-index-')),s=new MemoryStore(dir);
  try {fn(s,dir);} finally {s.close();rmSync(dir,{recursive:true,force:true});}
}
const hits=(s:MemoryStore,q:string)=>((s.episodes(q) as any).hits as {id:string}[]).map(h=>h.id);

test('indexed history follows appends and external edits/deletions without reusing stale candidates',()=>fixture((s,dir)=>{
  const first=s.capture('seed','user','Первый источник ZirconHandle.');
  expect(hits(s,'ZirconHandle')).toEqual([first]);
  expect(s.searchStatus().state).toBe('ready');
  const second=s.capture('next','user','Новый источник ObsidianHandle.');
  expect(hits(s,'ObsidianHandle')).toEqual([second]);
  const other=new MemoryStore(dir);
  try {
    other.db.query('UPDATE episodes SET text=? WHERE id=?').run('Исправленный источник AmethystHandle.',first);
    expect(hits(s,'ZirconHandle')).toEqual([]);
    expect(hits(s,'AmethystHandle')).toEqual([first]);
    other.db.query('DELETE FROM episodes WHERE id=?').run(second);
    expect(hits(s,'ObsidianHandle')).toEqual([]);
  } finally {other.close();}
  // Direct SQL from a maintenance/import consumer uses this connection's total_changes.
  s.db.query('UPDATE episodes SET text=? WHERE id=?').run('Перенесённый источник GarnetHandle.',first);
  expect(hits(s,'AmethystHandle')).toEqual([]);
  expect(hits(s,'GarnetHandle')).toEqual([first]);
}));

test('reopening after an older writer reconciles the disposable index with original episodes',()=>fixture((s,dir)=>{
  const first=s.capture('seed','user','Опорный факт TopazHandle.');
  expect(hits(s,'TopazHandle')).toEqual([first]);
  s.close();
  const legacy=new Database(join(dir,'.memory/runtime/state.sqlite'));
  try {legacy.query('INSERT INTO episodes VALUES (?,?,?,?,?)').run('old-writer','old','user','Старый клиент сохранил BerylHandle.','2026-01-01T00:00:00.000Z');}
  finally {legacy.close();}
  const reopened=new MemoryStore(dir);
  try {
    expect(hits(reopened,'BerylHandle')).toEqual(['old-writer']);
    expect(reopened.episode(first).text).toBe('Опорный факт TopazHandle.');
  } finally {reopened.close();}
}));

test('a foreign sidecar is preserved and a complete fallback still finds original evidence',()=>fixture((s,dir)=>{
  const id=s.capture('seed','user','Проверенный факт SaffronHandle.');
  const file=join(dir,'.memory/runtime/search.sqlite'),foreign=new Database(file);
  foreign.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES (\'preserve me\')');foreign.close();
  const result:any=s.episodes('SaffronHandle');
  expect(result.hits.map((h:any)=>h.id)).toEqual([id]);
  expect(result.indexWarning).toContain('INDEX_DEGRADED');
  expect(s.searchStatus().state).toBe('degraded');
  const after=new Database(file,{readonly:true});
  try {expect((after.query('SELECT value FROM unrelated').get() as any).value).toBe('preserve me');}
  finally {after.close();}
}));

test('a damaged derived index cannot hide source messages or replace the primary database',()=>fixture((s,dir)=>{
  const id=s.capture('seed','user','Свидетельство MarigoldHandle.');
  const file=join(dir,'.memory/runtime/search.sqlite');
  writeFileSync(file,'not a sqlite database');
  const original=readFileSync(file);
  expect(hits(s,'MarigoldHandle')).toEqual([id]);
  expect(s.searchStatus().state).toBe('degraded');
  expect(readFileSync(file)).toEqual(original);
  expect(s.episode(id).text).toBe('Свидетельство MarigoldHandle.');
}));

test('read-only history search and diagnosis never create a search sidecar',()=>fixture((s,dir)=>{
  const id=s.capture('seed','user','Неизменяемый источник CopperHandle.');s.close();
  const file=join(dir,'.memory/runtime/search.sqlite');
  const reader=new MemoryStore(dir,{readOnly:true});
  try {
    expect(hits(reader,'CopperHandle')).toEqual([id]);
    expect(reader.searchStatus().state).toBe('disabled');
    expect(()=>reader.rebuildIndex()).toThrow('READ_ONLY');
  } finally {reader.close();}
  expect(existsSync(file)).toBe(false);
}));

test('cached record tokens observe old-writer corrections and source changes immediately',()=>fixture((s,dir)=>{
  const quote='Используем OnyxHandle.',episode=s.capture('seed','user',quote);
  const fact={id:'choice',kind:'fact',status:'active',text:quote,expectedVersion:0,source:{episode,quote}};
  s.commit('seed',[fact],'seed');
  expect(s.recall('OnyxHandle')).toContain('OnyxHandle');
  const other=new MemoryStore(dir);
  try {
    const next='Теперь используем JasperHandle.',e=other.capture('next','user',next);
    other.commit('next',[{...fact,text:next,expectedVersion:1,source:{episode:e,quote:next}}],'correction');
    expect(s.recall('OnyxHandle')).not.toContain('"id":"choice"');
    expect(s.recall('JasperHandle')).toContain('"version":2');
  } finally {other.close();}
  writeFileSync(join(dir,'source.txt'),'QuartzHandle');
  s.commit('file',[{id:'file',kind:'fact',status:'active',text:'QuartzHandle',expectedVersion:0,
    source:s.fileSource('source.txt','QuartzHandle')}],'file');
  expect(s.recall('QuartzHandle')).not.toContain('STALE: recheck source');
  writeFileSync(join(dir,'source.txt'),'Changed value');
  expect(s.recall('QuartzHandle')).toContain('STALE: recheck source');
}));
