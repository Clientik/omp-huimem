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

test('diagnostics preserve budget stop and distinguish exclusions without storing source text',()=>fixture(s=>{
  save(s,'a-big','needle '+ 'x'.repeat(900));
  save(s,'b-small','needle small');
  save(s,'c-other','unrelated');
  save(s,'d-old','needle old','retired');
  const result=s.recallDetailed('needle',500);
  expect(result.text).toBe(s.recall('needle',500));
  expect(result.counts).toEqual({budget:1,'after-budget-stop':1,'no-match':1,retired:1});
  s.recordRetrieval('run','tool-search',result);
  expect(JSON.stringify(s.lastRetrieval())).not.toContain('needle');
  expect(s.lastRetrieval().characters).toBe(result.text.length);
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
