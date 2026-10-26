import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {MemoryStore,type Change} from '../src/memory/core';

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
  expect(result.text).toMatch(/\[1 record\(s\) omitted by budget/);
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
  // Пометка о пропуске называет количество, ID и статус, поэтому её длина зависит от того,
  // что пропущено; место под неё резервируется заранее, и бюджет считается с этим резервом.
  const budget=lines[0].length+1+chosen.reduce((n,line)=>n+line.length+1,0)+MemoryStore.OMITTED_NOTICE_MAX;
  const result=s.recallDetailed('needle anchor',budget);
  const out=result.text.split('\n').filter(Boolean);
  expect(out[0]).toBe(lines[0]);
  expect(out.slice(1,-1)).toEqual(chosen);
  expect(out.filter(l=>l.startsWith('['))).toHaveLength(1);
  // Место под остаток «+N more» тоже зарезервировано, поэтому на тесном бюджете называется
  // столько ID, сколько влезает, а остальные считаются.
  expect(out.at(-1)).toContain('2 record(s) omitted by budget: b-big [active], +1 more');
  expect(result.counts).toEqual({selected:2,budget:2});
  expect(result.text.length).toBeLessThanOrEqual(budget);
  expect(full.text).not.toMatch(/record\(s\) omitted/);
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
  // Источник — файл: правка канонических документов устаревает именно такие записи. Запись,
  // цитирующая сообщение, с 0.6.10 от правки документа не устаревает (см. tests/core.test.ts).
  writeFileSync(join(root,'source.md'),'needle');
  const file=(version=0,text='needle')=>({id:'a',kind:'decision',status:'proposed',text,rationale:'needle',
    expectedVersion:version,source:s.fileSource('source.md','needle')});
  s.commit('t',[file()],'saved'); s.commit('t',[file(1,'needle revised')],'revised');
  writeFileSync(join(root,'.memory/MEMORY.md'),'changed');
  const result=s.recallDetailed('needle');
  expect(result.candidates[0]).toMatchObject({id:'a',version:2,stale:true,reason:'selected',supersededVersions:1});
  s.recordRetrieval('run','context',result,'');
  expect(s.lastRetrieval().candidates[0].finalBlock).toBe('clipped');
  s.recordRetrieval('run','context',result,result.text);
  expect(s.lastRetrieval().candidates[0].finalBlock).toBe('complete');
}));

test('direct ID diagnostics report missing records and bound receipt retention',()=>fixture(s=>{
  // С 2026-10-17 место делится по агентам (ключ до двоеточия), а общий предел — 200 строк.
  for(let i=0;i<105;i++) s.recordIdRetrieval('agent-a:'+i,'missing',null);
  expect((s.db.query('SELECT COUNT(*) n FROM retrieval_receipts').get() as any).n).toBe(10);
  for(let i=0;i<40;i++) s.recordIdRetrieval('agent-b:'+i,'missing',null);
  expect((s.db.query("SELECT COUNT(*) n FROM retrieval_receipts WHERE run LIKE 'agent-a:%'").get() as any).n).toBe(10);
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
  const one=s.recallDetailed('timeout',full.text.indexOf('\n')+1+full.text.split('\n')[1].length+1+160);
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

// Оговорка о границе цитаты — одна строка перед первым решением вместо поля в каждой строке.
// Слепая серия 12 на 12 (audit/claimscope-20260914) не показала ухудшения: 11 из 12 у обоих вариантов.
test('decision rows carry one scope note before the first decision, counted in the budget',()=>fixture(s=>{
  for(let i=0;i<8;i++) decide(s,`pay-${i}`,`Платежи: правило ${i}. Причина: банк ${i}.`,`банк ${i}`);
  save(s,'fact-a','Платежи: факт без решения');
  const result=s.recallDetailed('платежи');
  const lines=result.text.split('\n');
  expect(lines.filter(l=>l.startsWith('Decision rows:'))).toHaveLength(1);
  const note=lines.findIndex(l=>l.startsWith('Decision rows:'));
  expect(JSON.parse(lines[note+1]).kind).toBe('decision');
  expect(result.text).not.toContain('"claimScope"');
  for(const budget of [300,700,1200,2000]) {
    const r=s.recallDetailed('платежи',budget);
    expect(r.text.length).toBeLessThanOrEqual(budget);
    const hasDecision=rows(r.text).some(x=>x.kind==='decision');
    expect(r.text.includes('Decision rows:')).toBe(hasDecision);
  }
}));

test('a registry without decisions gets no scope note',()=>fixture(s=>{
  save(s,'fact-a','Порт сервиса 8080');
  save(s,'fact-b','Порт базы 5432');
  const text=s.recallDetailed('порт').text;
  expect(rows(text).map(r=>r.id).sort()).toEqual(['fact-a','fact-b']);
  expect(text).not.toContain('Decision rows:');
}));

test('a precomputed authority gives the same retrieval as computing it inside',()=>fixture((s,root)=>{
  save(s,'a','needle one'); save(s,'b','needle two');
  writeFileSync(join(root,'.memory/MEMORY.md'),'changed');
  const own=s.recallDetailed('needle',3200);
  const passed=s.recallDetailed('needle',3200,[],s.authority());
  expect(passed.text).toBe(own.text);
  expect(passed.candidates).toEqual(own.candidates);
}));

// ЗАМЕРЕНО 2026-10-19 на живом HUICAD (audit/huicad-after-0.6.7): при 20 записях в блок
// попадали 7, остальные 13 отбрасывались по бюджету на каждом из 43 ходов, и пометка называла
// только их количество. Позвать по ID то, о существовании чего не знаешь, нельзя — за день
// 14 поштучных recall id=, угаданных по документам.
test('on a real budget the omitted records are named with their status',()=>fixture(s=>{
  const long='Решение по подсистеме: '+'подробности и обоснование. '.repeat(20);
  for(let i=0;i<20;i++) save(s,'record-'+String(i).padStart(2,'0'),long+' Пункт '+i);
  const result=s.recallDetailed('решение подсистеме',4800);
  const shown=rows(result.text).map(r=>r.id);
  expect(shown.length).toBeGreaterThan(2);
  expect(shown.length).toBeLessThan(20);
  const notice=result.text.split('\n').find(l=>l.startsWith('['))!;
  expect(notice).toContain(`${20-shown.length} record(s) omitted by budget`);
  // Названы именно пропущенные, со статусом, и каждое имя пригодно для recall id=.
  const named=[...notice.matchAll(/([a-z-]+\d\d) \[(\w+)\]/g)].map(m=>m[1]);
  expect(named.length).toBeGreaterThan(2);
  for(const id of named) {
    expect(shown).not.toContain(id);
    expect(s.current(id)).not.toBeNull();
  }
  expect(notice).toContain('+'); // остаток назван числом, а не молча отброшен
  expect(result.text.length).toBeLessThanOrEqual(4800);
}));

test('a quote-only match outranks unrelated accepted decisions and preserves its source',()=>fixture(s=>{
  const quote='Используем Kafka для событий.',episode=s.capture('test','user',quote);
  s.commit('test',[{id:'z-event-bus',kind:'fact',status:'active',text:'Шина событий',
    expectedVersion:0,source:{episode,quote}}],'saved');
  for(let i=0;i<12;i++) decide(s,`a-noise-${i}`,`Отступ ${i+1} пробелов. Причина: единообразие.`,'единообразие');
  const result=s.recallDetailed('Что известно про Kafka? Только чтение: ничего не сохраняй.',5200);
  expect(rows(result.text)[0]).toMatchObject({id:'z-event-bus',source:{episode,quote}});
  expect(result.candidates[0].selectionBasis).toEqual(['query-match','match:quote']);
}));

test('short technical tokens match whole words rather than turning into an overview',()=>fixture(s=>{
  for(const [id,text] of [['generator','Генератор: Go.'],['search','Google для поиска.'],
    ['database','БД проекта.'],['database-long','БДшка.'],['sharp','Язык C#.'],['cpp','Язык C++.'],
    ['journal','журнал'],['preposition','на месте'],['year','2026'],['long-year','20261']])
    save(s,id,text);
  for(const [query,ids] of [['Go',['generator']],['БД',['database']],['C#',['sharp']],['C++',['cpp']],
    ['на',['preposition']],['2026',['year']]] as const)
    expect(rows(s.recall(query)).map(r=>r.id)).toEqual(ids);
  expect(rows(s.recall('% \\')).map(r=>r.id).sort()).toEqual(s.latestRecords().map(r=>r.id).sort());
}));

test('source and dependency paths are searchable without making changed evidence fresh',()=>fixture((s,root)=>{
  writeFileSync(join(root,'transport-config.txt'),'Значение очереди.');
  writeFileSync(join(root,'limits.yaml'),'Количество попыток.');
  s.commit('test',[{id:'settings',kind:'fact',status:'active',text:'Настройка транспорта.',
    expectedVersion:0,source:s.fileSource('transport-config.txt','Значение очереди.'),
    dependsOn:[{path:'limits.yaml'}]}],'saved');
  const fresh=s.recallDetailed(String.raw`transport-config.txt`);
  expect(rows(fresh.text)[0].id).toBe('settings');
  expect(fresh.candidates[0].selectionBasis).toEqual(['query-match','match:path']);
  expect(rows(s.recall(String.raw`limits.yaml`))[0].id).toBe('settings');
  writeFileSync(join(root,'transport-config.txt'),'Другое значение.');
  const stale=s.recallDetailed('transport-config.txt');
  expect(stale.candidates[0]).toMatchObject({id:'settings',stale:true,reason:'selected'});
  expect(rows(stale.text)[0].freshness).toContain('STALE');
}));

test('each matching field class is reported once without repetition changing coverage',()=>fixture((s,root)=>{
  writeFileSync(join(root,'Kafka.txt'),'Kafka Kafka Kafka');
  s.commit('test',[{id:'bus',kind:'fact',status:'active',text:'Kafka',expectedVersion:0,
    source:s.fileSource('Kafka.txt','Kafka Kafka Kafka')}],'saved');
  save(s,'other-bus','Kafka');
  const result=s.recallDetailed('Kafka Kafka');
  expect(rows(result.text).map(r=>r.id)).toEqual(['bus','other-bus']);
  expect(result.candidates[0].score).toBe(result.candidates[1].score);
  expect(result.candidates[0].selectionBasis).toEqual(['query-match','match:record','match:quote','match:path']);
}));

function graphChange(s:MemoryStore,id:string,text:string,extra:Partial<Change>={}):Change {
  const episode=s.capture('graph','user',text);
  return {id,kind:'fact',status:'active',text,expectedVersion:0,source:{episode,quote:text},...extra};
}

test('related evidence follows outgoing dependencies before links once, keeping latest status and provenance',()=>fixture((s,root)=>{
  writeFileSync(join(root,'basis.txt'),'Первое хранение.');
  const assistant=s.capture('graph','assistant','Предлагаю отдельную очередь.');
  s.commit('graph',[
    graphChange(s,'dep-a','Основание алфавита.'),
    graphChange(s,'dep-z','Предложение очереди.',{status:'proposed',source:{episode:assistant,quote:'Предлагаю отдельную очередь.'}}),
    graphChange(s,'linked','Первое хранение.',{source:s.fileSource('basis.txt','Первое хранение.'),links:['seed','deep']}),
    graphChange(s,'deep','Второй переход.'),
    graphChange(s,'reverse','Обратное ребро.',{links:['seed']}),
    graphChange(s,'old','Прежняя запись.',{status:'retired'}),
    graphChange(s,'gone','Исчезнувший сосед.'),
    graphChange(s,'seed','Экспорт CSV.',{kind:'task',status:'doing',dependsOn:[{id:'dep-z'},{id:'dep-a'}],
      links:['linked','dep-z','old','seed','linked','gone']}),
  ],'graph');
  // A legacy dangling link must not turn a read into an error.
  s.db.query('DELETE FROM versions WHERE id=?').run('gone');
  writeFileSync(join(root,'basis.txt'),'Текущее хранение.');
  s.commit('graph',[graphChange(s,'linked','Текущее хранение.',{expectedVersion:1,
    source:s.fileSource('basis.txt','Текущее хранение.'),links:['seed','deep']})],'updated basis');
  writeFileSync(join(root,'basis.txt'),'Непроверенное хранение.');
  const result=s.recallDetailed('CSV',12000);
  expect(rows(result.text).map(r=>r.id)).toEqual(['seed','dep-a','dep-z','linked']);
  for(const id of ['dep-a','dep-z'])
    expect(result.candidates.find(c=>c.id===id)).toMatchObject({score:0,pinned:false,selectionBasis:['related:dependsOn:seed']});
  expect(result.candidates.find(c=>c.id==='linked')).toMatchObject({
    version:2,stale:true,score:0,selectionBasis:['related:links:seed']});
  expect(rows(result.text).find(r=>r.id==='linked').source.quote).toBe('Текущее хранение.');
  expect(rows(result.text).find(r=>r.id==='dep-z').status).toBe('proposed');
  expect(s.verifyRecord('dep-z')).toMatchObject({role:'assistant',match:true});
}));

test('related evidence limits expansion to three fresh lexical seeds and six unique lower-priority neighbors',()=>fixture(s=>{
  const changes:Change[]=[];
  for(let i=0;i<4;i++) {
    for(let j=0;j<3;j++) changes.push(graphChange(s,`neighbor-${i}-${j}`,`Основание ${i} ${j}.`));
    changes.push(graphChange(s,`seed-${i}`,'CSV',{links:[
      'required','work','blocked','question','queued','neighbor-0-0',...Array.from({length:3},(_,j)=>`neighbor-${i}-${j}`)]}));
  }
  changes.push(graphChange(s,'required','Обязательное правило.'),
    graphChange(s,'work','Текущая работа.',{kind:'task',status:'doing'}),
    graphChange(s,'blocked','Ожидание.',{kind:'task',status:'blocked'}),
    graphChange(s,'question','Как продолжать?',{kind:'question',status:'open'}),
    graphChange(s,'queued','Следующая работа.',{kind:'task',status:'todo'}));
  s.commit('graph',changes,'graph');
  const result=s.recallDetailed('CSV',12000,['required']);
  const related=result.candidates.filter(c=>c.selectionBasis.some(b=>b.startsWith('related:')));
  expect(related.map(c=>c.id)).toEqual(['neighbor-0-0','neighbor-0-1','neighbor-0-2','neighbor-1-0','neighbor-1-1','neighbor-1-2']);
  expect(result.candidates.find(c=>c.id==='neighbor-0-0')!.selectionBasis).toEqual(['related:links:seed-0']);
  expect(rows(result.text).slice(0,9).map(r=>r.id)).toEqual([
    'required','seed-0','seed-1','seed-2','seed-3','blocked','question','work','queued']);
}));

test('related evidence caps seeds independently of the six-neighbor limit',()=>fixture(s=>{
  const changes:Change[]=[];
  for(let i=0;i<4;i++) changes.push(graphChange(s,`leaf-${i}`,`Основание ${i}.`),
    graphChange(s,`seed-${i}`,'CSV',{links:[`leaf-${i}`]}));
  s.commit('graph',changes,'graph');
  const result=s.recallDetailed('CSV',12000);
  expect(rows(result.text).map(r=>r.id)).toEqual(['seed-0','seed-1','seed-2','seed-3','leaf-0','leaf-1','leaf-2']);
}));

test('related evidence never expands overview, required-only, retired or stale file-backed lexical seeds',()=>fixture((s,root)=>{
  save(s,'leaf','Существующее основание.');
  writeFileSync(join(root,'seed.txt'),'CSV');
  s.commit('graph',[graphChange(s,'seed','CSV',{source:s.fileSource('seed.txt','CSV'),links:['leaf']})],'graph');
  for(const query of ['', 'неизвестное']) {
    const result=s.recallDetailed(query,12000,['seed']);
    expect(result.candidates.every(c=>c.selectionBasis.every(b=>!b.startsWith('related:')))).toBe(true);
  }
  writeFileSync(join(root,'seed.txt'),'Другой текст.');
  const stale=s.recallDetailed('CSV',12000);
  expect(rows(stale.text).map(r=>r.id)).toEqual(['seed']);
  expect(stale.candidates[0].stale).toBe(true);
  save(s,'retired-seed','CSV','retired');
  expect(s.recallDetailed('CSV').candidates.find(c=>c.id==='leaf')!.reason).toBe('no-match');
}));

test('related evidence cannot revive an old pinned dependency version',()=>fixture(s=>{
  save(s,'basis','Первое основание.');
  s.commit('graph',[graphChange(s,'seed','CSV',{dependsOn:[{id:'basis'}]})],'graph');
  save(s,'basis','Заменённое основание.','active',1);
  const result=s.recallDetailed('CSV',12000,['basis']);
  expect(rows(result.text).map(r=>[r.id,r.version])).toEqual([['basis',2],['seed',1]]);
  expect(result.candidates.find(c=>c.id==='seed')!.stale).toBe(true);
  expect(result.candidates.every(c=>c.selectionBasis.every(b=>!b.startsWith('related:')))).toBe(true);
}));

// MemDerive (arXiv 2610.25373): большинство ошибок — нужное промежуточное состояние есть в памяти, но
// не собрано для вопроса; неявные изменения распространяются через записанные зависимости. QEMem
// (arXiv 2610.22668): собирать недостающие основания, а не только похожие записи. STALE-совпадение
// уже называет причину; текущая версия изменившегося основания — то, чего не хватает для ответа.
test('a STALE match brings the current version of its changed basis and nothing else',()=>fixture(s=>{
  save(s,'customer-format','Клиент требует CSV.');
  save(s,'leaf','Посторонняя заметка.');
  s.commit('graph',[graphChange(s,'export','Экспорт отчёта в CSV.',{dependsOn:[{id:'customer-format'}],links:['leaf']})],'graph');
  save(s,'customer-format','Клиент перешёл на JSON.','active',1);
  const result=s.recallDetailed('экспорт отчёта',12000);
  expect(rows(result.text).map(r=>[r.id,r.version])).toEqual([['export',1],['customer-format',2]]);
  expect(result.candidates.find(c=>c.id==='export')!.stale).toBe(true);
  expect(result.candidates.find(c=>c.id==='customer-format')!.selectionBasis).toEqual(['related:staleCause:export']);
  expect(rows(result.text).find(r=>r.id==='customer-format').relation).toBe('changed basis of STALE export: version 1 -> 2');
}));
test('related rows name their evidential role for the matched record',()=>fixture(s=>{
  s.commit('graph',[graphChange(s,'basis','Основание.'),graphChange(s,'note','Заметка.')],'graph');
  s.commit('graph',[graphChange(s,'seed','Экспорт CSV.',{dependsOn:[{id:'basis'}],links:['note']})],'graph');
  const shown=rows(s.recallDetailed('CSV',12000).text);
  expect(shown.find(r=>r.id==='basis').relation).toBe('basis of seed');
  expect(shown.find(r=>r.id==='note').relation).toBe('linked from seed');
  expect(shown.find(r=>r.id==='seed').relation).toBeUndefined();
}));

// MemoType (arXiv 2610.11573): разные типы памяти отвечают разным вопросам, единая стратегия упирается
// в предел. ЗАМЕРЕНО 2026-10-26 офлайн на настоящем recallDetailed: при 20 одинаково совпадающих
// фактах и решениях процедура на «как развернуть сервис», решение на «почему» и задача на «что
// дальше» с ID в конце алфавита не попадали в блок вовсе — равные совпадения решал алфавит.
test('among equal matches the question type decides: how — procedure, why — decision, what next — task',()=>fixture(s=>{
  const cases:[string,string,string,string][]=[
    ['как развернуть сервис','z-steps','procedure','Развернуть сервис: make deploy, затем /health.'],
    ['почему выбрали Postgres','z-choice','decision','Выбрали Postgres, нужны транзакции.'],
    ['что дальше с миграцией','z-orders','task','Миграция: дальше таблица orders.'],
  ];
  for(const [query,id,kind,text] of cases) {
    const status=kind==='task' ? 'todo' : kind==='decision' ? 'accepted' : 'active';
    const noise=Array.from({length:20},(_,i)=>graphChange(s,`${id}-noise-${i}`.replace('z-','a-'),`${text} Вариант ${i}.`,
      {kind:i%2 ? 'fact' : (kind==='decision' ? 'procedure' : 'decision'),status:i%2 ? 'active' : (kind==='decision' ? 'active' : 'accepted'),
        ...(i%2 || kind==='decision' ? {} : {rationale:`${text} Вариант ${i}.`})}));
    s.commit('t',noise,'noise');
    s.commit('t',[graphChange(s,id,text,{kind,status,...(kind==='decision' ? {rationale:text} : {})})],'target');
    const result=s.recallDetailed(query,5200,[],undefined,{automatic:true});
    expect(rows(result.text)[0].id).toBe(id);
    expect(result.candidates.find(c=>c.id===id)!.selectionBasis).toContain('question-type');
  }
  // Без вопросительного слова прежний порядок: при равенстве — ID.
  const neutral=rows(s.recallDetailed('развернуть сервис',5200,[],undefined,{automatic:true}).text);
  expect(neutral[0].id).toBe('a-steps-noise-0');
}));

test('related evidence stays behind fitting matches and blockers while oversized seeds use skip-fit',()=>fixture(s=>{
  s.commit('graph',[
    graphChange(s,'a-neighbor','Связанное основание.'),
    graphChange(s,'a-rule','Обязательное правило.'),
    graphChange(s,'b-huge','CSV '+'x'.repeat(2800),{links:['a-neighbor']}),
    graphChange(s,'z-task','CSV',{kind:'task',status:'doing'}),
    graphChange(s,'z-block','Ждём ответа.',{kind:'question',status:'open'}),
    graphChange(s,'z-todo','Следующий шаг.',{kind:'task',status:'todo'}),
  ],'graph');
  const result=s.recallDetailed('CSV',2500,['a-rule']);
  expect(rows(result.text).map(r=>r.id)).toEqual(['a-rule','z-task','z-block','z-todo','a-neighbor']);
  expect(result.text).toContain('b-huge [active]');
  expect(result.text.length).toBeLessThanOrEqual(2500);
  expect(result.candidates.find(c=>c.id==='b-huge')!.reason).toBe('budget');
}));

test('sparse relevance delivers a distinctive topic before several ubiquitous query words',()=>{
  for(const entity of ['Kafka','OCCT','RabbitMQ','WebAssembly']) fixture(s=>{
    const quote=`${entity}: durable event queue.`;
    s.commit('sparse',[graphChange(s,'z-topic',quote),
      ...Array.from({length:12},(_,i)=>graphChange(s,`a-noise-${i}`,`Export report format rule ${i}.`))],'corpus');
    const result=s.recallDetailed(`${entity} export report format`,800);
    expect(rows(result.text)[0]).toMatchObject({id:'z-topic',source:{quote}});
    expect(result.text.length).toBeLessThanOrEqual(800);
  });
});

test('sparse relevance chooses related-evidence seeds by topic rather than common vocabulary',()=>fixture(s=>{
  s.commit('sparse',[graphChange(s,'basis','SQLite: persistent storage.'),
    graphChange(s,'z-topic','Kafka: durable event queue.',{links:['basis']}),
    ...Array.from({length:8},(_,i)=>graphChange(s,`a-noise-${i}`,`Export report format rule ${i}.`))],'corpus');
  const result=s.recallDetailed('Kafka export report format',12000);
  expect(rows(result.text)[0].id).toBe('z-topic');
  expect(rows(result.text).find(r=>r.id==='basis').source.quote).toBe('SQLite: persistent storage.');
  expect(result.candidates.find(c=>c.id==='basis')!.selectionBasis).toEqual(['related:links:z-topic']);
}));

test('retired records and historical versions cannot distort current sparse relevance',()=>fixture(s=>{
  save(s,'a-topic','Kafka');
  save(s,'b-generic','export report format');
  const query='Kafka export report format';
  expect(rows(s.recall(query))[0].id).toBe('b-generic');
  for(let version=1;version<=8;version++) save(s,'b-generic','export report format','active',version);
  s.commit('retired',Array.from({length:16},(_,i)=>graphChange(s,`old-${i}`,'export report format',{status:'retired'})),'old corpus');
  const result=s.recallDetailed(query);
  expect(rows(result.text).map(r=>r.id)).toEqual(['b-generic','a-topic']);
  expect(result.candidates.find(c=>c.id==='b-generic')!.version).toBe(9);
}));

test('sparse relevance retains complementary facts of the same topic instead of diversity pruning',()=>fixture(s=>{
  s.commit('sparse',[graphChange(s,'a-deadline','Kafka timeout: increase deadline.'),
    graphChange(s,'b-cancel','Kafka timeout: keep cancellation.'),
    ...Array.from({length:8},(_,i)=>graphChange(s,`z-noise-${i}`,`Report export formatting rule ${i}.`))],'corpus');
  expect(rows(s.recall('Kafka timeout report',900)).map(r=>r.id)).toEqual(['a-deadline','b-cancel']);
}));
