import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {MemoryStore} from '../src/memory/core';

function fixture(fn:(s:MemoryStore,root:string)=>void) {
  const root=mkdtempSync(join(import.meta.dir,'retrieval-test-'));
  const s=new MemoryStore(root);
  try {fn(s,root);} finally {s.close();rmSync(root,{recursive:true,force:true});}
}
function save(s:MemoryStore,id:string,text:string,status='active',version=0) {
  const episode=s.capture('test','user',text);
  s.commit('test',[{id,kind:'fact',status,text,expectedVersion:version,source:{episode,quote:text}}],'saved');
}

test('an oversized record does not hide a later matching record within the same budget',()=>fixture(s=>{
  save(s,'a-big','needle '+ 'x'.repeat(900));
  save(s,'b-small','needle small');
  save(s,'c-other','unrelated');
  save(s,'d-old','needle old','retired');
  const result=s.recallDetailed('needle',500);
  expect(result.text).toBe(s.recall('needle',500));
  expect(result.counts).toEqual({budget:1,selected:1,'no-match':1,retired:1});
  const rows=result.text.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
  expect(rows.map(row=>row.id)).toEqual(['b-small']);
  expect(result.text.length).toBeLessThanOrEqual(500);
  expect(result.text).toContain('[More records omitted');
  s.recordRetrieval('run','tool-search',result);
  expect(JSON.stringify(s.lastRetrieval())).not.toContain('needle');
  expect(s.lastRetrieval().characters).toBe(result.text.length);
}));

test('selection preserves rank and whole records while adding only one omission notice',()=>fixture(s=>{
  save(s,'a-first','needle anchor');
  save(s,'b-big','needle '+ 'x'.repeat(900));
  save(s,'c-last','needle small');
  save(s,'d-big','needle '+ 'y'.repeat(900));
  const full=s.recallDetailed('needle anchor');
  const lines=full.text.split('\n');
  const chosen=lines.filter(line=>line.startsWith('{') && ['a-first','c-last'].includes(JSON.parse(line).id));
  const notice='[More records omitted: use project_memory recall with narrower query.]';
  const budget=lines[0].length+1+chosen.reduce((n,line)=>n+line.length+1,0)+notice.length;
  const result=s.recallDetailed('needle anchor',budget);
  expect(result.text).toBe(lines[0]+'\n'+chosen.join('\n')+'\n'+notice);
  expect(result.counts).toEqual({selected:2,budget:2});
  expect(result.text.length).toBe(budget);
  expect(full.text).not.toContain('[More records omitted');
  for(const limit of [0,1,80,120]) {
    const small=s.recallDetailed('needle',limit);
    expect(small.text.length).toBeLessThanOrEqual(limit);
    expect(small.text).not.toContain('{');
    expect(small.counts.selected ?? 0).toBe(0);
  }
}));

test('bounded diagnostics retain selected records after many oversized candidates',()=>fixture(s=>{
  const text='needle '+ 'x'.repeat(900),episode=s.capture('test','user',text);
  for(let start=0;start<200;start+=25) {
    const changes=Array.from({length:25},(_,i)=>({id:'big-'+String(start+i).padStart(3,'0'),
      kind:'fact',status:'active',text,expectedVersion:0,source:{episode,quote:text}}));
    s.commit('test',changes,'batch');
  }
  save(s,'z-small','needle small');
  const result=s.recallDetailed('needle',500);
  expect(result.counts).toEqual({budget:200,selected:1});
  expect(result.candidates).toHaveLength(200);
  expect(result.detailsOmitted).toBe(1);
  expect(result.candidates[0]).toMatchObject({id:'z-small',reason:'selected'});
  s.recordRetrieval('run','context',result,result.text);
  expect(s.lastRetrieval().candidates[0]).toMatchObject({id:'z-small',finalBlock:'complete'});
}));

test('stale records remain selectable and final clipping is separate from retrieval',()=>fixture((s,root)=>{
  save(s,'a','needle'); save(s,'a','needle revised','active',1);
  writeFileSync(join(root,'.memory/MEMORY.md'),'changed');
  const result=s.recallDetailed('needle');
  expect(result.candidates[0]).toMatchObject({id:'a',version:2,stale:true,reason:'selected',supersededVersions:1});
  s.recordRetrieval('run','context',result,'');
  expect(s.lastRetrieval().candidates[0].finalBlock).toBe('clipped');
  s.recordRetrieval('run','context',result,result.text);
  expect(s.lastRetrieval().candidates[0].finalBlock).toBe('complete');
}));

test('direct ID diagnostics report missing records and bound receipt retention',()=>fixture(s=>{
  for(let i=0;i<105;i++) s.recordIdRetrieval('run'+i,'missing',null);
  expect((s.db.query('SELECT COUNT(*) n FROM retrieval_receipts').get() as any).n).toBe(100);
  expect(s.lastRetrieval()).toMatchObject({channel:'tool-id',counts:{missing:1},candidates:[]});
  save(s,'a','original');
  s.recordIdRetrieval('last','a',s.current('a'));
  expect(s.lastRetrieval().candidates[0]).toMatchObject({id:'a',selectionBasis:['explicit-id'],reason:'selected'});
}));
