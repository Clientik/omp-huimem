import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/core';

function fixture(fn: (s: MemoryStore) => void) {
  const dir=mkdtempSync(join(import.meta.dir,'upgrade-behavior-')),s=new MemoryStore(dir);
  try {fn(s);} finally {s.close();rmSync(dir,{recursive:true,force:true});}
}
const rows=(text:string)=>text.split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l));
function save(s:MemoryStore,id:string,quote:string,kind='fact') {
  const episode=s.capture('seed','user',quote);
  s.commit('seed:'+id,[{id,kind,status:kind==='decision'?'accepted':'active',text:quote,expectedVersion:0,
    ...(kind==='decision'?{rationale:quote}:{}),source:{episode,quote}}],'seed');
}

test('unchanged retrieval delivery does not rewrite its diagnostic receipt',()=>fixture(s=>{
  save(s,'bus','Kafka transports events.');
  const r=s.recallDetailed('Kafka');
  s.recordRetrieval('run:0','context',r,r.text,{tasks:[]});
  const writes=(s.db.query('SELECT total_changes() n').get() as any).n;
  s.recordRetrieval('run:0','context',r,r.text,{tasks:[]});
  expect((s.db.query('SELECT total_changes() n').get() as any).n).toBe(writes);
  expect(s.lastRetrieval().candidates.find((c:any)=>c.id==='bus').finalBlock).toBe('complete');
  s.recordRetrieval('run:0','context',r,'',{tasks:[]});
  expect(s.lastRetrieval().candidates.find((c:any)=>c.id==='bus').finalBlock).toBe('clipped');
}));

test('acknowledged synchronized projection does not write again',()=>fixture(s=>{
  save(s,'bus','Kafka transports events.');
  const writes=(s.db.query('SELECT total_changes() n').get() as any).n;
  expect(s.sync().state).toBe('synced');
  expect((s.db.query('SELECT total_changes() n').get() as any).n).toBe(writes);
}));

test('automatic context does not pin an unrelated accepted decision while explicit reads retain it',()=>fixture(s=>{
  save(s,'database','Используем PostgreSQL для заказов.','decision');
  const automatic=(s.recallDetailed as any)('Redis',5200,[],s.authority(),{automatic:true});
  expect(rows(automatic.text)).toEqual([]);
  expect(s.current('database')?.source.quote).toBe('Используем PostgreSQL для заказов.');
  expect(rows(s.recallDetailed('').text).map((r:any)=>r.id)).toContain('database');
}));

test('automatic question recall admits its named topic without filling with common-word noise',()=>fixture(s=>{
  save(s,'bus','Используем Kafka для событий.');
  for(let i=0;i<12;i++) save(s,'indent-'+i,`Отступ ${i+1} пробелов. Причина: единообразие.`,'decision');
  const automatic=(s.recallDetailed as any)('Что известно про Kafka?',5200,[],s.authority(),{automatic:true});
  expect(rows(automatic.text).map((r:any)=>r.id)).toEqual(['bus']);
}));

test('history search reaches original evidence older than the former text scan ceiling',()=>fixture(s=>{
  const insert=s.db.query('INSERT INTO episodes VALUES (?,?,?,?,?)');
  s.db.transaction(()=>{
    insert.run('original','old','user','Решение: XerxesCobalt — точное имя компонента.','2020-01-01T00:00:00.000Z');
    const filler='служебный текст '.repeat(23000);
    for(let i=0;i<65;i++) insert.run('new-'+i,'new','assistant',filler+i,'2026-10-01T00:00:00.000Z');
  })();
  const found:any=s.episodes('XerxesCobalt',{role:'user'});
  expect(found.hits.map((h:any)=>h.id)).toEqual(['original']);
  const acrossRoles:any=s.episodes('XerxesCobalt');
  expect(acrossRoles.hits.map((h:any)=>h.id)).toEqual(['original']);
  expect(s.episode('original').role).toBe('user');
}));
