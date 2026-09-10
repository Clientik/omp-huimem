import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/core';

function fixture(fn: (s: MemoryStore, dir: string) => void) {
  const dir=mkdtempSync(join(import.meta.dir,'projection-test-')), s=new MemoryStore(dir);
  try { fn(s,dir); } finally { s.close(); rmSync(dir,{recursive:true,force:true}); }
}
const fact=(s:MemoryStore,text='Provider Stripe',version=0) => ({id:'payments',kind:'fact',status:'active',text,
  expectedVersion:version,source:{episode:s.capture('run','user',text),quote:text}});

test('commit publishes current records and preserves human notes and freshness',()=>fixture((s,dir)=>{
  writeFileSync(join(dir,'.memory/MEMORY.md'),'Human notes');
  expect(s.commit('a',[fact(s)],'saved').projection.state).toBe('synced');
  expect(readFileSync(join(dir,'.memory/RECORDS.md'),'utf8')).toContain('Provider Stripe');
  expect(readFileSync(join(dir,'.memory/RECORDS.md'),'utf8')).toContain('Source quote');
  expect(readFileSync(join(dir,'.memory/MEMORY.md'),'utf8')).toBe('Human notes');
  expect(s.current('payments')?.freshness).not.toBe('STALE');
  s.commit('b',[fact(s,'Provider YooKassa',1)],'changed');
  const view=readFileSync(join(dir,'.memory/RECORDS.md'),'utf8');
  expect(view).toContain('YooKassa'); expect(view).not.toContain('Stripe');
}));

test('manual edits produce a visible conflict while the database commit remains durable',()=>fixture((s,dir)=>{
  s.commit('a',[fact(s)],'first');
  writeFileSync(join(dir,'.memory/RECORDS.md'),'My correction');
  const result=s.commit('b',[fact(s,'Provider YooKassa',1)],'second');
  expect(result.saved).toBe(1); expect(result.projection.state).toBe('conflict');
  expect(s.current('payments')?.version).toBe(2);
  expect(readFileSync(join(dir,'.memory/RECORDS.md'),'utf8')).toBe('My correction');
  expect(s.status().projection.state).toBe('conflict');
  renameSync(join(dir,'.memory/RECORDS.md'),join(dir,'.memory/my-notes.md'));
  expect(s.sync().state).toBe('synced');
  expect(readFileSync(join(dir,'.memory/RECORDS.md'),'utf8')).toContain('YooKassa');
}));

test('failed publication recovers on reopening without a new commit',()=>fixture((s,dir)=>{
  mkdirSync(join(dir,'.memory/RECORDS.md'));
  expect(s.commit('r',[fact(s)],'saved').projection.state).toBe('pending');
  expect(s.checkpoint('r')).toBeTruthy();
  s.close(); rmSync(join(dir,'.memory/RECORDS.md'),{recursive:true});
  const next=new MemoryStore(dir);
  try {
    expect(next.status().projection.state).toBe('synced');
    expect(next.current('payments')?.version).toBe(1);
    expect(readFileSync(join(dir,'.memory/RECORDS.md'),'utf8')).toContain('Stripe');
  } finally { next.close(); }
}));

test('restart recognizes publication completed before its acknowledgement',()=>fixture((s,dir)=>{
  s.commit('a',[fact(s)],'first');
  s.db.exec('UPDATE projection SET last_hash=NULL'); s.close();
  const next=new MemoryStore(dir);
  try { expect(next.status().projection.state).toBe('synced'); expect(next.history('payments')).toHaveLength(1); }
  finally { next.close(); }
}));

test('schema one migration preserves history and generates its readable view',()=>fixture((s,dir)=>{
  s.commit('a',[fact(s)],'first');
  s.db.exec("DROP TABLE projection; UPDATE meta SET value='1' WHERE key='schema'");
  s.close(); rmSync(join(dir,'.memory/RECORDS.md'));
  const next=new MemoryStore(dir);
  try {
    expect(next.history('payments')).toHaveLength(1);
    expect(next.checkpoint('a')?.summary).toBe('first');
    expect(next.status().projection.state).toBe('synced');
  } finally { next.close(); }
}));

test('generated text cannot become independent evidence and failed commits leave the view unchanged',()=>fixture((s,dir)=>{
  s.commit('a',[fact(s)],'first');
  const before=readFileSync(join(dir,'.memory/RECORDS.md'),'utf8');
  expect(()=>s.fileSource('.memory/RECORDS.md','Provider Stripe')).toThrow('SOURCE_DERIVED');
  const bad=fact(s,'Provider YooKassa',1); bad.source.quote='Never said this';
  expect(()=>s.commit('bad',[bad],'bad')).toThrow('SOURCE');
  expect(readFileSync(join(dir,'.memory/RECORDS.md'),'utf8')).toBe(before);
  expect(s.checkpoint('bad')).toBeNull();
}));
