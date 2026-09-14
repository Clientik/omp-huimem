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

// Разделение обязательных правил и памяти по задаче (пункт 3, 14 сентября).
function decide(s:MemoryStore,id:string,quote:string,rationale:string,status='accepted',version=0) {
  const episode=s.capture('test','user',quote);
  s.commit('test',[{id,kind:'decision',status,text:quote,rationale,expectedVersion:version,source:{episode,quote}}],'saved');
}
const rows=(text:string)=>text.split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l));

test('short quotes cannot bypass the collective required share or displace the matching task',()=>fixture(s=>{
  const required=Array.from({length:6},(_,i)=>'required-'+i);
  const episode=s.capture('test','user','x');
  s.commit('test',required.map(id=>({id,kind:'fact',status:'active',text:'x'.repeat(166),
    expectedVersion:0,source:{episode,quote:'x'}})),'required');
  const text='export invoices '+'t'.repeat(250),source=s.capture('test','user',text);
  s.commit('test',[{id:'export-task',kind:'task',status:'doing',text,expectedVersion:0,source:{episode:source,quote:text}}],'task');
  const result=s.recallDetailed('export invoices',3000,required);
  const selected=rows(result.text);
  const used=selected.filter(r=>required.includes(r.id)).reduce((n,r)=>n+JSON.stringify(r).length+1,0);
  expect(used).toBeLessThanOrEqual(1500);
  expect(selected.some(r=>r.id==='export-task')).toBe(true);
  expect(selected.some(r=>r.quoteClipped)).toBe(false);
  expect(result.text).toContain('REQUIRED records not shown in full');
}));

test('required omissions keep all IDs in diagnostics and use a whole compact notice',()=>fixture(s=>{
  const required=Array.from({length:10},(_,i)=>'rule-'+i+'-'+'x'.repeat(92));
  const episode=s.capture('test','user','x');
  s.commit('test',required.map(id=>({id,kind:'fact',status:'active',text:'x'.repeat(200),
    expectedVersion:0,source:{episode,quote:'x'}})),'rules');
  for(const state of ['existing','retired','missing']) {
    if(state==='retired') s.commit('test',required.map(id=>({id,kind:'fact',status:'retired',text:'x',
      expectedVersion:1,source:{episode,quote:'x'}})),'retired');
    if(state==='missing') s.db.exec('DELETE FROM versions');
    const result=s.recallDetailed('unknown',500,required);
    expect(result.text.length).toBeLessThanOrEqual(500);
    expect(result.text.trimEnd().endsWith(']')).toBe(true);
    expect(result.text).toContain('project_memory status');
    expect(result.requiredOmissions).toHaveLength(10);
    for(const id of required) expect(result.requiredOmissions!.some(x=>x.startsWith(id))).toBe(true);
    s.recordRetrieval('run','tool-search',result);
    expect(s.lastRetrieval().requiredOmissions).toEqual(result.requiredOmissions);
  }
  for(const budget of [0,1,80,120]) {
    const result=s.recallDetailed('',budget,required);
    expect(result.text.length).toBeLessThanOrEqual(budget);
    expect(result.text==='' || result.text.trimEnd().endsWith(']')).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.requiredOmissions).toHaveLength(10);
  }
}));

test('short words inside other words no longer rank unrelated decisions above current work',()=>fixture(s=>{
  for(let i=0;i<25;i++) decide(s,`arch-${String(i).padStart(2,'0')}`,`Журнал сервиса ${i} — logs/${i}. Причина: ротация.`,'ротация');
  const quote='Задача: экспорт счетов в CSV.',episode=s.capture('test','user',quote);
  s.commit('test',[{id:'task-invoices',kind:'task',status:'doing',text:quote,expectedVersion:0,source:{episode,quote}}],'task');
  const result=s.recallDetailed('на чём мы остановились',1200);
  expect(rows(result.text)[0].id).toBe('task-invoices');
  expect(result.candidates.find(c=>c.id==='arch-00')!.score).toBe(0);
}));

test('matching compares word starts and still finds inflected forms and id parts',()=>fixture(s=>{
  save(s,'retry-limit','Ключи не пишутся в логи.');
  save(s,'other','Отступы в конфиге.');
  const result=s.recallDetailed('ключей логов limit');
  expect(result.candidates[0]).toMatchObject({id:'retry-limit',score:3});
  expect(result.candidates.find(c=>c.id==='other')!.reason).toBe('no-match');
}));

test('a STALE record yields to a fresh one at equal score but stays visible',()=>fixture((s,root)=>{
  writeFileSync(join(root,'a.txt'),'timeout 5');
  const source=s.fileSource('a.txt','timeout 5');
  s.commit('test',[{id:'a-timeout',kind:'fact',status:'active',text:'timeout stale',expectedVersion:0,source}],'file');
  save(s,'b-timeout','timeout fresh');
  writeFileSync(join(root,'a.txt'),'timeout 9');
  const full=s.recallDetailed('timeout');
  expect(rows(full.text).map(r=>[r.id,r.freshness.startsWith('STALE')])).toEqual([['b-timeout',false],['a-timeout',true]]);
  const one=s.recallDetailed('timeout',full.text.indexOf('\n')+1+full.text.split('\n')[1].length+1+80);
  expect(rows(one.text).map(r=>r.id)).toEqual(['b-timeout']);
}));

test('required records come first, keep an exact quote prefix when clipped, and are named when not shown in full',()=>fixture(s=>{
  const long='Правило безопасности: ключи никогда не пишем в логи. '+'Секреты не попадают в журналы и трассировки. '.repeat(30)+'Причина: утечки.';
  decide(s,'security-rule',long,'утечки');
  for(let i=0;i<5;i++) decide(s,`minor-${i}`,`Отступ ${i} в конфиге. Причина: единообразие.`,'единообразие');
  const plain=s.recallDetailed('отступ в конфиге',1200);
  expect(rows(plain.text).map(r=>r.id)).not.toContain('security-rule');
  const tight=s.recallDetailed('отступ в конфиге',1200,['security-rule']);
  expect(rows(tight.text).map(r=>r.id)).not.toContain('security-rule');
  expect(tight.requiredOmissions).toEqual(['security-rule']);
  expect(tight.text).toContain('REQUIRED records not shown in full: security-rule');
  const result=s.recallDetailed('отступ в конфиге',2000,['security-rule']);
  expect(result.text.length).toBeLessThanOrEqual(2000);
  const [rule]=rows(result.text);
  expect(rule.id).toBe('security-rule');
  expect(long.startsWith(rule.source.quote)).toBe(true);
  expect(rule.source.quote).toContain('ключи никогда не пишем в логи');
  expect(rule.quoteClipped).toContain(`of ${long.length} characters`);
  expect(result.text).toContain('[REQUIRED records not shown in full: security-rule.');
  expect(result.candidates[0]).toMatchObject({id:'security-rule',reason:'quote-clipped'});
  expect(result.candidates[0].selectionBasis).toContain('required');
  s.recordRetrieval('run','context',result,result.text);
  expect(s.lastRetrieval().candidates[0].finalBlock).toBe('quote-clipped');
  // Где половина бюджета достижима, обязательная запись не занимает больше неё,
  // и записи по вопросу остаются в выдаче.
  const mid=s.recallDetailed('отступ в конфиге',3000,['security-rule']);
  const midRows=rows(mid.text);
  expect(JSON.stringify(midRows[0]).length+1).toBeLessThanOrEqual(1500);
  expect(midRows[0].quoteClipped).toBeDefined();
  expect(midRows.filter(r=>r.id.startsWith('minor-')).length).toBeGreaterThan(0);
  // С достаточным бюджетом обязательная запись выдаётся целиком и без пометки.
  const wide=s.recallDetailed('отступ в конфиге',12000,['security-rule']);
  expect(rows(wide.text)[0].source.quote).toBe(long);
  expect(wide.text).not.toContain('REQUIRED records not shown');
  expect(rows(wide.text).length).toBe(6);
}));

test('missing and retired required records are named, never silently dropped',()=>fixture(s=>{
  decide(s,'old-rule','Старое правило. Причина: было нужно.','было нужно');
  decide(s,'old-rule','Старое правило. Причина: было нужно.','было нужно','retired',1);
  save(s,'fact','unrelated');
  const result=s.recallDetailed('something',3200,['nope','old-rule']);
  expect(result.text).toContain('nope (missing)');
  expect(result.text).toContain('old-rule (retired)');
  expect(rows(result.text).map(r=>r.id)).not.toContain('old-rule');
}));
