import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import install from '../src/extensions/project-memory';
import { MemoryStore } from '../src/memory/core';
import { personalRoot, sessionRoot } from '../src/memory/scopes';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'huimem-learning-'));
  mkdirSync(join(root,'.memory'));
  writeFileSync(join(root,'.memory/MEMORY.md'),'# Project memory\n');
  const store=new MemoryStore(root), handlers:any={}, tools:any={}, commands:any={};
  const chain:any=new Proxy(()=>chain,{get:()=>chain}), turn=Promise.withResolvers<any>(), messages:any[]=[];
  const ctx:any={cwd:root,hasUI:false,agent:{kind:'main'},sessionManager:{getSessionId:()=>'native-dialogue'}};
  install({zod:chain,on:(name:string,fn:any)=>handlers[name]=fn,registerTool:(tool:any)=>tools[tool.name]=tool,
    registerCommand:(name:string,command:any)=>commands[name]=command,sendMessage:(message:any,options:any)=>{
      messages.push(message);if(options?.triggerTurn) turn.resolve(message);
    }} as any,{agentDir:join(root,'profile')});
  const call=(params:any,signal?:AbortSignal)=>tools.project_memory.execute('learning',params,signal,undefined,ctx);
  const ok=async(params:any)=>{
    const result=await call(params);
    if(result.isError) throw new Error(result.details.error);
    return result.details;
  };
  return {root,store,ctx,handlers,commands,call,ok,turn,messages,
    async clean(){await handlers.session_shutdown({},ctx);store.close();rmSync(root,{recursive:true,force:true});}};
}
function fact(store:MemoryStore,id:string,quote:string,expectedVersion=0) {
  const episode=store.capture('old-dialogue','user',quote);
  store.commit('seed',[{id,kind:'fact',status:'active',text:quote,expectedVersion,source:{episode,quote},dependsOn:[]}],'Source-backed fact');
  return episode;
}
const revision=(store:MemoryStore)=>{
  // The fixed PRAGMA always returns its schema-defined numeric data_version.
  const row=store.db.query('PRAGMA data_version').get() as {data_version:number};
  return row.data_version;
};

describe('one source-to-knowledge learning lifecycle',()=>{
  test('old dialogues are offered oldest-first without writes or inventing facts; partial Unicode sources resume after restart',async()=>{
    const f=fixture();try {
      const original='a'.repeat(11999)+'😀'+' хвост';
      const first=f.store.capture('legacy-0.6.10','user',original);
      const second=f.store.capture('legacy-0.7.0','assistant','Proposed procedure, not a verified fact.');
      await f.ok({op:'status'});
      const before=revision(f.store);
      const packet=await f.ok({op:'learn',action:'next'});
      expect(packet.sources.map((source:any)=>source.id)).toEqual([first]);
      expect(packet.sources[0]).toMatchObject({role:'user',offset:0,endOffset:11999,length:12007,text:'a'.repeat(11999)});
      expect((await f.ok({op:'learn',action:'next'})).id).toBe(packet.id);
      expect(revision(f.store)).toBe(before);
      const complete={op:'learn',action:'complete',id:packet.id,outcome:'nothing-durable',summary:'Reviewed the incomplete source; no durable claim in this slice.',records:[]};
      await f.ok(complete);
      await f.handlers.session_switch({},f.ctx);
      const tail=await f.ok({op:'learn',action:'next'});
      expect(tail.sources.map((source:any)=>[source.id,source.role,source.offset])).toEqual([[first,'user',11999],[second,'assistant',0]]);
      expect(tail.sources[0].text).toBe('😀 хвост');
      expect(tail.sources[0].contextBefore).toBe('a'.repeat(400));
      await f.ok({...complete,id:tail.id,summary:'Remaining source reviewed; the assistant procedure is still unverified.'});
      expect((await f.ok({op:'learn',action:'next'})).sources).toEqual([]);
      expect((await f.ok({op:'learn',action:'status'})).pendingSources).toBe(0);
      expect(f.store.latestRecords()).toEqual([]);
      expect(f.store.episode(first).text).toBe(original);
    } finally {await f.clean();}
  });

  test('new messages do not invalidate an offered packet; identical acknowledgements do not write and conflicting replays cannot replace them',async()=>{
    const f=fixture();try {
      const first=f.store.capture('old','user','Only a short exchange, nothing to retain.');
      const packet=await f.ok({op:'learn',action:'next'});
      const other=new MemoryStore(f.root);
      let later:string;
      try {later=other.capture('external-writer','user','A later message must remain pending.');} finally {other.close();}
      const params={op:'learn',action:'complete',id:packet.id,outcome:'nothing-durable',summary:'No durable knowledge in the reviewed exchange.',records:[]};
      const saved=await f.ok(params);
      expect(saved.unchanged).toBe(false);
      expect(saved.receipt.sources.map((source:any)=>source.id)).toEqual([first]);
      const before=revision(f.store);
      expect((await f.ok(params)).unchanged).toBe(true);
      expect(revision(f.store)).toBe(before);
      expect((await f.call({...params,summary:'Different review result.'})).details.code).toBe('LEARN_CONFLICT');
      expect((await f.ok({op:'learn',action:'next'})).sources.map((source:any)=>source.id)).toEqual([later!]);
      expect((await f.ok({op:'learn',action:'read',id:packet.id})).summary).toBe(params.summary);
    } finally {await f.clean();}
  });

  test('failed validation, cancellation and source changes never advance coverage',async()=>{
    const f=fixture();try {
      const episode=f.store.capture('old','user','Keep decisions source-backed.');
      const packet=await f.ok({op:'learn',action:'next'});
      const params={op:'learn',action:'complete',id:packet.id,outcome:'nothing-durable',summary:'Reviewed this source without a durable addition.',records:[]};
      expect((await f.call({...params,summary:''})).details.code).toBe('LEARN_INPUT');
      expect((await f.call({...params,outcome:'recorded',records:[{id:'invented',version:1}]})).details.code).toBe('LEARN_RECORD');
      const abort=new AbortController();abort.abort();
      expect((await f.call(params,abort.signal)).details.code).toBe('LEARN_ABORTED');
      expect((await f.ok({op:'learn',action:'next'})).id).toBe(packet.id);
      f.store.db.query('UPDATE episodes SET text=? WHERE id=?').run('A source edited outside the plugin.',episode);
      expect((await f.call(params)).details.code).toBe('LEARN_CONFLICT');
      expect((await f.ok({op:'learn',action:'status'})).pendingSources).toBe(1);
    } finally {await f.clean();}
  });

  test('review results pin checked versions without promoting assistant observations, and survive an older writer',async()=>{
    const f=fixture();try {
      const assistant=f.store.capture('old','assistant','A cache might reduce repeated disk reads.');
      const packet=await f.ok({op:'learn',action:'next'});
      const change={id:'cache-proposal',kind:'procedure',status:'proposed',text:'Investigate a cache for repeated disk reads.',expectedVersion:0,
        source:{origin:'episode',episode:assistant,quote:'A cache might reduce repeated disk reads.'},dependsOn:[]};
      await f.ok({op:'commit',summary:'Unverified cache proposal.',changes:[change]});
      const result=await f.ok({op:'learn',action:'complete',id:packet.id,outcome:'recorded',summary:'Retained only as an unverified proposal.',records:[{id:'cache-proposal',version:1}]});
      expect(result.receipt.records).toEqual([{id:'cache-proposal',version:1}]);
      expect(result.coverageIsNotEvidence).toBe(true);
      expect(f.store.current('cache-proposal')).toMatchObject({status:'proposed',version:1,source:{episode:assistant}});
      expect((await f.call({op:'wiki',action:'publish',id:'cache',title:'Cache',body:'Cache is beneficial.',records:[{id:'cache-proposal',version:1}]})).details.code).toBe('WIKI_SOURCE');
      f.store.db.query("INSERT OR REPLACE INTO meta VALUES ('plugin','0.6.10')").run();
      const later=f.store.capture('older-writer','user','We have not measured this cache.');
      await f.handlers.session_switch({},f.ctx);
      expect((await f.ok({op:'learn',action:'next'})).sources.map((source:any)=>source.id)).toEqual([later]);
      // These fixed schema-owned SELECTs return the named TEXT and COUNT columns.
      const schema=f.store.db.query("SELECT value FROM meta WHERE key='schema'").get() as {value:string};
      const tables=f.store.db.query("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as {n:number};
      expect(schema.value).toBe('2');
      expect(tables.n).toBe(11);
    } finally {await f.clean();}
  });

  test('stale result versions cannot close a review; pause, off and native session scopes retain their boundaries',async()=>{
    const f=fixture();try {
      fact(f.store,'database','Use SQLite for this project.');
      const packet=await f.ok({op:'learn',action:'next'});
      fact(f.store,'database','Use SQLite WAL for this project.',1);
      const params={op:'learn',action:'complete',id:packet.id,outcome:'recorded',summary:'Reviewed storage.',records:[{id:'database',version:1}]};
      expect((await f.call(params)).details.code).toBe('LEARN_RECORD');
      expect((await f.ok({op:'learn',action:'next'})).sources[0].id).toBe(packet.sources[0].id);
      await f.commands.huimem.handler('pause',f.ctx);
      expect((await f.call({...params,records:[{id:'database',version:2}]})).details.code).toBe('COMMITS_PAUSED');
      expect((await f.ok({op:'learn',action:'next'})).sources[0].id).toBe(packet.sources[0].id);
      await f.commands.huimem.handler('resume',f.ctx);
      expect((await f.ok({op:'learn',scope:'session',action:'next'})).sources).toEqual([]);
      expect((await f.call({op:'learn',scope:'session',action:'complete',id:packet.id,outcome:'nothing-durable',summary:'Wrong scope.',records:[]})).details.code).toBe('LEARN_CONFLICT');
      expect((await f.call({op:'learn',scope:'personal',action:'next'})).details.code).toBe('PERSONAL_MEMORY_NOT_ENABLED');
      await f.commands.huimem.handler('off',f.ctx);
      expect((await f.call({op:'learn',action:'next'})).details.code).toBe('PROJECT_MEMORY_OFF');
    } finally {await f.clean();}
  });
  test('damaged coverage metadata is diagnosed read-only rather than reset or treated as reviewed',async()=>{
    const f=fixture();try {
      f.store.capture('old','user','Original evidence remains available.');
      f.store.db.query('INSERT INTO meta VALUES(?,?)').run('learning.v1','{"schema":1,"cursor":{"position":1}}');
      const before=revision(f.store);
      const diagnostic=await f.ok({op:'doctor'});
      expect(diagnostic.issues.some((issue:any)=>issue.code==='LEARN_STATE')).toBe(true);
      expect(revision(f.store)).toBe(before);
      expect((await f.call({op:'learn',action:'next'})).details.code).toBe('LEARN_STATE');
      expect(f.store.episodes('Original evidence').hits.map((hit:any)=>hit.role)).toEqual(['user']);
    } finally {await f.clean();}
  });

  test.each(['session','personal'] as const)('scoped doctor reports a damaged %s review ledger without modifying it',async(scope)=>{
    const f=fixture();try {
      if(scope==='personal') await f.commands.huimem.handler('personal on',f.ctx);
      await f.ok({op:'learn',scope,action:'next'});
      const storage=scope==='personal' ? personalRoot(join(f.root,'profile')) : sessionRoot(f.root,'native-dialogue');
      const source=scope==='personal' ? storage : f.root;
      const damaged=new MemoryStore(source,{storageRoot:storage});
      try {damaged.db.query('INSERT INTO meta VALUES(?,?)').run('learning.v1','{"schema":1,"cursor":{"position":1}}');}
      finally {damaged.close();}
      const reader=new MemoryStore(source,{storageRoot:storage,readOnly:true});
      try {
        const before=revision(reader), diagnostic=await f.ok({op:'doctor',scope});
        expect(diagnostic.issues.some((issue:any)=>issue.code==='LEARN_STATE')).toBe(true);
        expect(revision(reader)).toBe(before);
      } finally {reader.close();}
    } finally {await f.clean();}
  });

  test.each([false,true])('explicit curation cannot feed generated text back into learning (before_agent_start=%s)',async(emitBeforeStart)=>{
    const f=fixture();try {
      const original=f.store.capture('old','user','Use SQLite for the local journal.');
      const running=f.commands.huimem.handler('learn',f.ctx), guide=await f.turn.promise;
      f.ctx.sessionManager.getBranch=()=>[{type:'custom_message',customType:'huimem-learn',content:guide.content,attribution:'agent'}];
      if(emitBeforeStart) await f.handlers.before_agent_start({prompt:guide.content,attribution:'agent'},f.ctx);
      await f.handlers.agent_start({},f.ctx);
      await f.handlers.message_end({message:{role:'assistant',content:[{type:'text',text:'Generated interpretation: SQLite was selected because it is faster.'}]}},f.ctx);
      const packet=await f.ok({op:'learn',action:'next'});
      expect(packet.sources.map((source:any)=>[source.id,source.role])).toEqual([[original,'user']]);
      await f.ok({op:'learn',action:'complete',id:packet.id,outcome:'nothing-durable',summary:'Source reviewed without additional claims.',records:[]});
      await f.handlers.agent_end({},f.ctx);await running;
      expect((await f.ok({op:'learn',action:'next'})).sources).toEqual([]);
      expect(f.store.episodes('because it is faster').hits).toEqual([]);
      expect(f.store.episode(original).text).toBe('Use SQLite for the local journal.');
    } finally {await f.clean();}
  });

  test('a genuine user interruption resumes ordinary capture without advancing unfinished curation',async()=>{
    const f=fixture();try {
      const original=f.store.capture('old','user','Old source awaiting review.');
      const running=f.commands.huimem.handler('learn',f.ctx);
      await f.turn.promise;
      await f.handlers.before_agent_start({prompt:'Stop curation. Use Go for the CLI.'},f.ctx);
      await running;
      await f.handlers.message_end({message:{role:'assistant',content:'I will inspect the current CLI before changing it.'}},f.ctx);
      const packet=await f.ok({op:'learn',action:'next'});
      expect(packet.sources.map((source:any)=>[source.role,source.text])).toEqual([
        ['user','Old source awaiting review.'],['user','Stop curation. Use Go for the CLI.'],['assistant','I will inspect the current CLI before changing it.'],
      ]);
      expect(packet.sources[0].id).toBe(original);
      expect((await f.ok({op:'learn',action:'status'})).reviewedBatches).toBe(0);
    } finally {await f.clean();}
  });
  test('bounded packets drain every source exactly once and empty work cannot create false coverage',async()=>{
    const f=fixture();try {
      const ids=Array.from({length:19},(_,index)=>f.store.capture('old','user',`Transient exchange ${index}.`));
      const reviewed:string[]=[];
      for(let count=0;count<10;count++) {
        const packet=await f.ok({op:'learn',action:'next'});
        if(!packet.id) break;
        reviewed.push(...packet.sources.map((source:any)=>source.id));
        await f.ok({op:'learn',action:'complete',id:packet.id,outcome:'nothing-durable',summary:'Reviewed transient exchanges; no durable additions.',records:[]});
      }
      expect(reviewed).toEqual(ids);
      expect((await f.ok({op:'learn',action:'status'})).pendingSources).toBe(0);
      expect(f.store.latestRecords()).toEqual([]);
      expect((await f.call({op:'learn',action:'complete',id:'learn1:999:0:'+'0'.repeat(64),outcome:'nothing-durable',summary:'There is no offered packet.',records:[]})).details.code).toBe('LEARN_CONFLICT');
    } finally {await f.clean();}
  });
});

describe('source-backed wiki workbench',()=>{
  test('plans only supported uncovered knowledge and separates stale pages, proposals and duplicate candidates without rewriting them',async()=>{
    const f=fixture();try {
      fact(f.store,'storage','Use SQLite for the local journal.');
      fact(f.store,'deploy','Deploy only after a backup.');
      fact(f.store,'deploy-copy','Deploy only after a backup.');
      const assistant=f.store.capture('old','assistant','Maybe deploy to a new region.');
      f.store.commit('proposal',[{id:'region',kind:'decision',status:'proposed',text:'Use another region.',rationale:'Not accepted.',expectedVersion:0,
        source:{episode:assistant,quote:'Maybe deploy to a new region.'}}],'Region remains proposed.');
      await f.ok({op:'wiki',action:'publish',id:'storage',title:'Storage',body:'SQLite stores the local journal. Reasons not recorded.',records:[{id:'storage',version:1}]});
      const pagePath=join(f.root,'.memory/wiki/storage.md'), bytes=readFileSync(pagePath,'utf8');
      fact(f.store,'storage','Use SQLite WAL for the local journal.',1);
      const plan=await f.ok({op:'wiki',action:'plan'});
      expect(plan.uncovered.map((record:any)=>record.id).sort()).toEqual(['deploy','deploy-copy','storage']);
      expect(plan.updates.map((page:any)=>page.id)).toEqual(['storage']);
      expect(plan.review.map((record:any)=>[record.id,record.status])).toEqual([['region','proposed']]);
      expect(plan.duplicates.map((group:any)=>group.records)).toEqual([[{id:'deploy',version:1},{id:'deploy-copy',version:1}]]);
      expect(readFileSync(pagePath,'utf8')).toBe(bytes);
      expect(f.store.current('region')?.status).toBe('proposed');
      const old=await f.ok({op:'wiki',action:'read',id:'storage'});
      await f.ok({op:'wiki',action:'publish',id:'storage',title:'Storage',body:'SQLite WAL stores the local journal.',records:[{id:'storage',version:2}],expectedHash:old.hash});
      expect((await f.ok({op:'wiki',action:'plan'})).uncovered.map((record:any)=>record.id).sort()).toEqual(['deploy','deploy-copy']);
    } finally {await f.clean();}
  });

  test('discovers outbound dependencies, backlinks and shared sources from the existing record graph, not from generated prose',async()=>{
    const f=fixture();try {
      const episode=fact(f.store,'database','SQLite is local. Back up the database before deployment.');
      f.store.commit('links',[{id:'backup',kind:'procedure',status:'active',text:'Back up the database before deployment.',expectedVersion:0,
        source:{episode,quote:'Back up the database before deployment.'},dependsOn:[{id:'database'}]}],'Checked user procedure.');
      for(const page of [
        {id:'database',title:'Database',body:'SQLite. [[invented-page]] is merely prose.',records:[{id:'database',version:1}]},
        {id:'backup',title:'Backup',body:'Back up the database.',records:[{id:'backup',version:1}]},
        {id:'database-notes',title:'Database notes',body:'Additional interpretation.',records:[{id:'database',version:1}]},
      ]) await f.ok({op:'wiki',action:'publish',...page});
      const backlinks=await f.ok({op:'wiki',action:'discover',id:'database'});
      expect(backlinks.related.find((page:any)=>page.id==='backup').via).toContainEqual({kind:'dependsOn',direction:'incoming',from:'backup',to:'database'});
      expect(backlinks.related.find((page:any)=>page.id==='database-notes').via).toContainEqual({kind:'shared-source',direction:'shared',from:'database',to:'database'});
      expect(backlinks.related.some((page:any)=>page.id==='invented-page')).toBe(false);
      const outgoing=await f.ok({op:'wiki',action:'discover',id:'backup'});
      expect(outgoing.related.find((page:any)=>page.id==='database').via).toContainEqual({kind:'dependsOn',direction:'outgoing',from:'backup',to:'database'});
      expect((await f.ok({op:'wiki',action:'discover',id:'absent'})).found).toBe(false);
    } finally {await f.clean();}
  });

  test('an unreadable human-edited page makes coverage explicitly incomplete and is never repaired by planning',async()=>{
    const f=fixture();try {
      fact(f.store,'storage','Keep local storage in SQLite.');
      await f.ok({op:'wiki',action:'publish',id:'storage',title:'Storage',body:'Local SQLite.',records:[{id:'storage',version:1}]});
      const path=join(f.root,'.memory/wiki/storage.md'), human='# Human-edited interpretation\\nPreserve this text.';
      writeFileSync(path,human);
      const plan=await f.ok({op:'wiki',action:'plan'});
      expect(plan.sourceCoverageComplete).toBe(false);
      expect(plan.issues.map((issue:any)=>[issue.id,issue.code])).toEqual([['storage','WIKI_CORRUPT']]);
      expect(plan.uncovered.map((record:any)=>record.id)).toEqual(['storage']);
      expect(readFileSync(path,'utf8')).toBe(human);
    } finally {await f.clean();}
  });
});
