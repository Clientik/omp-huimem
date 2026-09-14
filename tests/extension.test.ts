import { describe, test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/core';
import { LIMITS } from '../src/memory/settings';
import installSource from '../src/extensions/project-memory';
import installBundle from '../dist/index.js';

describe('source adapter', () => adapterContract(installSource));
describe('built bundle', () => adapterContract(installBundle));

function adapterContract(install: typeof installSource) {

test('partial and aliased ADR reads get provenance without modifying the excerpt',async()=>{
  const f=fixture(); try {
    mkdirSync(join(f.dir,'.memory/adr'),{recursive:true});
    writeFileSync(join(f.dir,'.memory/adr/0001.md'),'## Basis\n> quote\n## Consequences\nUnknown');
    symlinkSync(join(f.dir,'.memory/adr'),join(f.dir,'adr-alias'),'junction');
    await f.handlers.before_agent_start({prompt:'Read a fragment'},f.ctx);
    const content=[{type:'text',text:'[.memory/adr/0001.md#0750]\n4:Unknown'}];
    for(const path of ['.memory/adr/0001.md:4-4',join(f.dir,'.memory/adr/0001.md')+':4','adr-alias/0001.md:4-4']) {
      const result=await f.handlers.tool_result({toolName:'read',input:{path},content,isError:false},f.ctx);
      expect(result?.content[0].text).toContain('NO basis section is visible in this excerpt');
      expect(result.content.slice(1)).toEqual(content);
    }
    mkdirSync(join(f.dir,'docs'));
    writeFileSync(join(f.dir,'docs/outside.md'),'## Basis\n> quote');
    symlinkSync(join(f.dir,'docs'),join(f.dir,'.memory/adr/outside-alias'),'junction');
    expect(await f.handlers.tool_result({toolName:'read',input:{path:'.memory/adr/outside-alias/outside.md'},content,isError:false},f.ctx)).toBeUndefined();
  } finally {f.clean();}
});

test('ADR read results retain original content and add provenance warning only for documents',async()=>{
  const f=fixture(); try {
    await f.handlers.before_agent_start({prompt:'Why?'},f.ctx);
    const content=[{type:'text',text:'Accepted. More retries trigger deduplication.'}];
    const event={toolName:'read',input:{path:'.memory/adr/0001.md'},content,isError:false};
    const result=await f.handlers.tool_result(event,f.ctx);
    expect(result.content[0].text).toContain('DOCUMENT_PROVENANCE');
    expect(result.content.slice(1)).toEqual(content);
    expect(event.content).toEqual(content);
    expect(await f.handlers.tool_result({...event,input:{path:'src/a.ts'}},f.ctx)).toBeUndefined();
    expect(await f.handlers.tool_result({...event,isError:true},f.ctx)).toBeUndefined();
  } finally { f.clean(); }
});

// Пометка адресует блок основания, а не файл. Прежний вариант накрывал документ целиком
// и три живых прогона подряд не помешал модели приписать пользователю дописанную причину.
test('the provenance marker distinguishes a document with a quoted basis from one without',async()=>{
  const f=fixture(); try {
    await f.handlers.before_agent_start({prompt:'Why?'},f.ctx);
    const mark=async(text:string)=>(await f.handlers.tool_result(
      {toolName:'read',input:{path:'.memory/adr/0001.md'},content:[{type:'text',text}],isError:false},f.ctx)).content[0].text;
    const contract=['# 0001','','## Основание','> «нужна доставка хотя бы один раз»','',
      '## Последствия','Дедупликация при большом числе попыток.'].join('\n');
    const withBasis=await mark('[.memory/adr/0001.md#0750]\n'+contract.split('\n').map((line,i)=>`${i+1}:${line}`).join('\n'));
    expect(withBasis).toContain('1 quoted line(s)');
    expect(withBasis).toContain('authorship is unverified');
    // Раздел «Последствия» цитируемым не становится, даже будучи внутри принятого ADR.
    expect(withBasis).toContain('is not verified by acceptance');
    const legacy=await mark('# 0002\n\n- Статус: принято\n\nПри большем числе попыток срабатывает дедупликация.');
    expect(legacy).toContain('NO basis section');
    expect(legacy).not.toContain('quoted line(s)');
  } finally { f.clean(); }
});

// Перенос ADR: показ ничего не пишет, запись сохраняет оригинал и вставляет цитату из реестра.
test('/huimem adr-audit shows without writing, and apply writes with a byte-exact backup',async()=>{
  const f=fixture(); try {
    const adr='.memory/adr/0001-retry.md';
    const legacy='# ADR 0001\n\n- Статус: принято\n- Причина: окно 19 минут, поэтому больше попыток попадает в дедупликацию.\n';
    const quote='Выбираем 7 попыток. Причина: окно дедупликации 19 минут.';
    mkdirSync(join(f.dir,'.memory/adr'),{recursive:true});
    writeFileSync(join(f.dir,adr),legacy);
    const s=new MemoryStore(f.dir);
    const episode=s.capture('run','user',quote);
    s.commit('run:0',[{id:'retry',kind:'decision',status:'accepted',expectedVersion:0,text:'7 попыток, ADR '+adr,
      rationale:'окно дедупликации 19 минут',source:{episode,quote}} as any],'decision');
    s.close();
    await f.commands.huimem.handler('adr-audit',f.ctx);
    const shown=String(f.notices.at(-1)?.content ?? '');
    expect(shown).toContain('dry run, nothing written');
    expect(shown).toContain('MIGRATE');
    expect(readFileSync(join(f.dir,adr),'utf8')).toBe(legacy);
    await f.commands.huimem.handler('adr-audit apply',f.ctx);
    const wrote=String(f.notices.at(-1)?.content ?? '');
    expect(wrote).toContain('WROTE');
    expect(wrote).toContain('STALE');
    const after=readFileSync(join(f.dir,adr),'utf8');
    expect(after).toContain('## Основание\n> '+quote);
    expect(after.endsWith(legacy.split('\n').slice(1).join('\n'))).toBe(true);
    const backup=wrote.match(/original: (\S+)/)![1];
    expect(readFileSync(join(f.dir,backup),'utf8')).toBe(legacy);
  } finally { f.clean(); }
});

test('/huimem adr-audit reports invalid stored evidence and never writes an ADR',async()=>{
  for(const reason of ['episode-missing','episode-not-user','quote-absent']) {
    const f=fixture();
    try {
      const adr='.memory/adr/0001.md', legacy='# ADR\nOriginal text\n', quote='Use SQLite for local storage.';
      mkdirSync(join(f.dir,'.memory/adr'),{recursive:true});
      writeFileSync(join(f.dir,adr),legacy);
      const s=new MemoryStore(f.dir);
      try {
        const episode=s.capture('run','user',quote);
        s.commit('run:0',[{id:'db',kind:'decision',status:'accepted',expectedVersion:0,
          text:'See '+adr,rationale:'local storage',source:{episode,quote}}],'decision');
        if(reason==='episode-missing') s.db.query('DELETE FROM episodes WHERE id=?').run(episode);
        else if(reason==='episode-not-user') s.db.query("UPDATE episodes SET role='assistant' WHERE id=?").run(episode);
        else s.db.query("UPDATE episodes SET text='Unrelated text' WHERE id=?").run(episode);
      } finally {s.close();}
      for(const command of ['adr-audit','adr-audit apply']) {
        await f.commands.huimem.handler(command,f.ctx);
        const shown=String(f.notices.at(-1)?.content ?? '');
        expect(shown).toContain('UNVERIFIED');
        expect(shown).toContain(reason);
        expect(readFileSync(join(f.dir,adr),'utf8')).toBe(legacy);
        expect(existsSync(join(f.dir,'.memory/adr-backup'))).toBe(false);
      }
    } finally {f.clean();}
  }
});

// Итоговый блок контекста собирается по целым частям и записям, а не режется по символу.
// До исправления обработчик context склеивал инструкции, выдержку и чекпоинт, давал реестру
// полный бюджет, а затем обрезал весь блок slice(0, limit - 80) посреди JSON-записи.
async function packedContext(f:any, injectionLimit:number) {
  writeFileSync(join(f.dir,'.memory/MEMORY.md'),'# Память\n'+'Длинный факт проекта для заполнения выдержки. '.repeat(120));
  writeFileSync(join(f.dir,'.memory/PROJECT.md'),'# Проект\n'+'Карта модулей и команд проекта. '.repeat(120));
  writeFileSync(join(f.dir,'.memory/settings.json'),JSON.stringify({injectionLimit,recallBudget:3200}));
  const s=new MemoryStore(f.dir);
  for(let i=0;i<8;i++){
    const quote=`Решение ${i}: используем компонент номер ${i}. Причина: требование ${i} к надёжности и сопровождению.`;
    const ep=s.capture('seed','user',quote);
    s.commit('seed:'+i,[{id:'d'+i,kind:'decision',status:'accepted',expectedVersion:0,
      text:`Компонент ${i} выбран для подсистемы ${i}. `+'Подробности решения. '.repeat(12),
      rationale:`требование ${i} к надёжности и сопровождению`,source:{episode:ep,quote}} as any],'seed');
  }
  s.commit('seed:cp',[],'Следующий шаг: '+'проверить интеграцию и обновить документацию. '.repeat(40));
  s.close();
  await f.handlers.before_agent_start({prompt:'компонент решение'},f.ctx);
  const out:any=await f.handlers.context({messages:[]},f.ctx);
  return out.messages.find((m:any)=>m.customType==='project-memory-context').content as string;
}
const recordLines=(text:string)=>text.split('\n').filter(l=>l.trimStart().startsWith('{'));

test('the final memory block stays within the limit and never cuts a record in half',async()=>{
  const f=fixture(); try {
    const content=await packedContext(f,5000);
    expect(content.length).toBeLessThanOrEqual(5000);
    const lines=recordLines(content);
    expect(lines.length).toBeGreaterThan(0);
    for(const l of lines) expect(()=>JSON.parse(l)).not.toThrow();
    const s=new MemoryStore(f.dir); const receipt=s.lastContext(); s.close();
    expect(receipt.records.map((r:any)=>r.id).sort()).toEqual(lines.map(l=>JSON.parse(l).id).sort());
    expect(receipt.characters).toBe(content.length);
  } finally { f.clean(); }
});

test('at the minimum allowed limit the required rules fit and nothing is dropped without being named',async()=>{
  const f=fixture(); try {
    const min=LIMITS.injectionLimit.min;
    const content=await packedContext(f,min);
    expect(content.length).toBeLessThanOrEqual(min);
    expect(content).not.toContain('MEMORY_BUDGET_EXHAUSTED');
    for(const rule of ['SOURCE ORDER:','CLAIM SCOPE:','project_memory commit is AVAILABLE']) expect(content).toContain(rule);
    for(const l of recordLines(content)) expect(()=>JSON.parse(l)).not.toThrow();
    const notice=(content.match(/\[MEMORY_BUDGET[^\]]*\]/)?.[0] ?? '').toLowerCase();
    expect(notice).not.toBe('');
    // Пропуск записей называет либо общая пометка (реестр опущен целиком), либо пометка поиска.
    if(!recordLines(content).length) expect(notice.includes('registry') || content.includes('[More records omitted')).toBe(true);
    if(!content.includes('Previous checkpoint')) expect(notice).toContain('checkpoint');
  } finally { f.clean(); }
});

test('retrieval diagnostics report every delivered record as complete, none clipped',async()=>{
  const f=fixture(); try {
    const content=await packedContext(f,5000);
    const s=new MemoryStore(f.dir); const r=s.lastRetrieval(); s.close();
    const selected=r.candidates.filter((c:any)=>c.reason==='selected');
    expect(selected.length).toBe(recordLines(content).length);
    expect(selected.every((c:any)=>c.finalBlock==='complete')).toBe(true);
  } finally { f.clean(); }
});

test('when everything fits, the block is not trimmed and carries no budget marker',async()=>{
  const f=fixture(); try {
    const s=new MemoryStore(f.dir);
    const quote='Используем SQLite. Причина: один файл.';
    const ep=s.capture('seed','user',quote);
    s.commit('seed:1',[{id:'db',kind:'decision',status:'accepted',expectedVersion:0,text:'SQLite',
      rationale:'один файл',source:{episode:ep,quote}} as any],'seed'); s.close();
    await f.handlers.before_agent_start({prompt:'база'},f.ctx);
    const out:any=await f.handlers.context({messages:[]},f.ctx);
    const content=out.messages.find((m:any)=>m.customType==='project-memory-context').content;
    expect(content).not.toContain('MEMORY_BUDGET');
    expect(content).toContain('Canonical preview');
    expect(content).toContain('Previous checkpoint');
    expect(recordLines(content).map(l=>JSON.parse(l).id)).toEqual(['db']);
    const t=new MemoryStore(f.dir); expect(t.lastContext().truncated).toBe(false); t.close();
  } finally { f.clean(); }
});

test('session pause rejects all commits, permits reads, and resumes explicitly',async()=>{
  const f=fixture(); try {
    await f.handlers.before_agent_start({prompt:'Use SQLite'},f.ctx);
    await f.commands.huimem.handler('pause',f.ctx);
    const result=await f.tools.project_memory.execute('x',{op:'commit',changes:[],summary:'should not save'},null,null,f.ctx);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('COMMITS_PAUSED');
    const s=new MemoryStore(f.dir);
    expect(s.latestCheckpoint()).toBeNull(); s.close();
    expect((await f.tools.project_memory.execute('r',{op:'recall'},null,null,f.ctx)).isError).not.toBe(true);
    await f.handlers.before_agent_start({prompt:'Next question'},f.ctx);
    expect((await f.tools.project_memory.execute('y',{op:'commit',changes:[{}],summary:'blocked'},null,null,f.ctx)).isError).toBe(true);
    await f.commands.huimem.handler('resume',f.ctx);
    expect((await f.tools.project_memory.execute('z',{op:'commit',changes:[],summary:'explicitly resumed'},null,null,f.ctx)).isError).not.toBe(true);
  } finally { f.clean(); }
});

test('setup explains independence from mnemopi and sync does not invent records',async()=>{
  const f=fixture(); try {
    await f.commands.huimem.handler('',f.ctx);
    expect(JSON.stringify(f.notices)).toContain('No mnemopi');
    await f.commands.huimem.handler('sync',f.ctx);
    expect(JSON.stringify(f.notices)).toContain('Readable registry: empty');
    expect(existsSync(join(f.dir,'.memory/RECORDS.md'))).toBe(false);
    rmSync(join(f.dir,'.memory/MEMORY.md'));
    await f.commands.huimem.handler('',f.ctx);
    expect(JSON.stringify(f.notices)).toContain('mnemopi is NOT required');
  } finally { f.clean(); }
});

test('native compaction guidance works on resume and stays inert without deployment', async () => {
  const f=fixture(); try {
    const event={type:'session.compacting',messages:[{role:'user',content:'A decision'}]};
    const result=await f.handlers['session.compacting'](event,f.ctx);
    expect(Object.keys(result)).toEqual(['context']);
    expect(result.context.join(' ')).toContain('Quote the original user rationale exactly');
    expect(result.context.join(' ').length).toBeLessThan(600);
    expect(event.messages).toEqual([{role:'user',content:'A decision'}]);
    rmSync(join(f.dir,'.memory/MEMORY.md'));
    expect(await f.handlers['session.compacting'](event,f.ctx)).toBeUndefined();
  } finally { f.clean(); }
});

test('essential tool saves current user decision without asking model for an episode ID', async () => {
  const f=fixture(); try {
    expect(f.tools.project_memory.loadMode).toBe('essential');
    await f.handlers.before_agent_start({prompt:'Use PostgreSQL. Reason: transactions.'},f.ctx);
    const result=await f.tools.project_memory.execute('save',{op:'commit',summary:'Accepted PostgreSQL',changes:[{
      id:'database',kind:'decision',status:'accepted',text:'Use PostgreSQL',rationale:'transactions',expectedVersion:0,
      source:{origin:'user',quote:'Use PostgreSQL. Reason: transactions.'}
    }]},null,null,f.ctx);
    expect(result.isError).not.toBe(true);
    const db=new MemoryStore(f.dir); expect(db.current('database')?.source.episode).toBeTruthy(); db.close();
    await f.handlers.tool_result({toolName:'write',input:{path:'xd://project_memory'},details:{xdev:{tool:'project_memory'}}},f.ctx);
    await f.handlers.session_stop({},f.ctx);
    expect(f.notices.some(x=>String(x).includes('CHECKPOINT_MISSING'))).toBe(false);
  } finally {f.clean();}
});
test('file quote gets a verified hash; forged user quotes still fail', async () => {
  const f=fixture(); const {writeFileSync}=await import('node:fs'); try {
    await f.handlers.before_agent_start({prompt:'Inspect project'},f.ctx);
    writeFileSync(join(f.dir,'app.txt'),'DB=sqlite');
    const tool=f.tools.project_memory;
    const saved=await tool.execute('a',{op:'commit',summary:'Observed DB',changes:[{
      id:'db',kind:'fact',status:'active',text:'DB=sqlite',expectedVersion:0,source:{origin:'file',path:'app.txt',quote:'DB=sqlite'}
    }]},null,null,f.ctx);
    expect(saved.isError).not.toBe(true);
    const bad=await tool.execute('b',{op:'commit',summary:'Unstated choice',changes:[{
      id:'invented',kind:'decision',status:'accepted',text:'Use MongoDB',rationale:'cheap',expectedVersion:0,
      source:{origin:'user',quote:'Use MongoDB because cheap'}
    }]},null,null,f.ctx);
    expect(bad.isError).toBe(true);
    const db=new MemoryStore(f.dir); expect(db.current('db')?.source.hash).toHaveLength(64); expect(db.current('invented')).toBeNull(); db.close();
  } finally {f.clean();}
});

test('canonical preview is injected with a bounded total context', async () => {
  const f=fixture(); const {writeFileSync}=await import('node:fs');
  try {
    await f.handlers.before_agent_start({prompt:'current provider'},f.ctx);
    writeFileSync(join(f.dir,'.memory/MEMORY.md'),'Provider YooKassa\n'+'x'.repeat(20000));
    const result=await f.handlers.context({messages:[]},f.ctx);
    expect(result.messages[0].content).toContain('Provider YooKassa');
    expect(result.messages[0].content.length).toBeLessThanOrEqual(8000);
  } finally {f.clean();}
});
test('context includes a fitting record after an oversized candidate and reports omissions',async()=>{
  const f=fixture();
  try {
    writeFileSync(join(f.dir,'.memory/settings.json'),JSON.stringify({recallBudget:500}));
    const s=new MemoryStore(f.dir);
    try {
      for(const [id,text] of [['a-big','needle '+'x'.repeat(900)],['b-small','needle small']]) {
        const episode=s.capture('seed','user',text);
        s.commit('seed',[{id,kind:'fact',status:'active',expectedVersion:0,text,source:{episode,quote:text}}],'seed');
      }
    } finally {s.close();}
    await f.handlers.before_agent_start({prompt:'needle'},f.ctx);
    const result=await f.handlers.context({messages:[]},f.ctx);
    const content=result.messages.find((m:any)=>m.customType==='project-memory-context').content;
    expect(content).toContain('"id":"b-small"');
    expect(content).not.toContain('"id":"a-big"');
    expect(content).toContain('[More records omitted');
    const check=new MemoryStore(f.dir);
    try {
      expect(check.lastContext().truncated).toBe(true);
      expect(check.lastRetrieval().candidates.find((c:any)=>c.id==='b-small').finalBlock).toBe('complete');
    } finally {check.close();}
  } finally {f.clean();}
});

test('repeated starts/stops cannot schedule continuation', async () => {
  const f=fixture(); try {
    for(let n=0;n<6;n++) {
      await f.handlers.before_agent_start({prompt:'say ok'},f.ctx);
      await f.handlers.tool_result({toolName:'write'},f.ctx);
      expect(await f.handlers.session_stop({},f.ctx)).toBeUndefined();
    }
  } finally {f.clean();}
});

function fixture() {
  const dir = mkdtempSync(join(import.meta.dir, 'extension-test-'));
  // Память включается только в развёрнутом проекте: фикстура отражает то состояние,
  // в котором расширение вообще работает. Голый каталог проверяется отдельным тестом.
  mkdirSync(join(dir, '.memory'), { recursive: true });
  writeFileSync(join(dir, '.memory/MEMORY.md'), '# Память проекта');
  const handlers: any = {}, tools: any = {}, notices: any[] = [], commands: any = {};
  const chain: any = new Proxy(() => chain, { get: () => chain });
  const pi: any = { zod: chain, on: (n: string, fn: any) => handlers[n] = fn,
    registerTool: (t: any) => tools[t.name] = t,
    registerCommand: (n: string, d: any) => commands[n] = d,
    sendMessage: (m: any) => notices.push(m) };
  const ctx: any = { cwd: dir, hasUI: true, ui: { notify: (s: string) => notices.push(s) },
    sessionManager: { getSessionId: () => 'session-test' } };
  install(pi);
  return { dir, handlers, tools, ctx, notices, commands, clean() { handlers.session_shutdown?.({},ctx); rmSync(dir,{recursive:true,force:true}); } };
}
test('automatic prompt capture, recall, stop checkpoint, bounded retry', async () => {
  const f = fixture(); try {
    await f.handlers.before_agent_start({ prompt: 'Провайдер YooKassa', systemPrompt: 'system' }, f.ctx);
    const context = await f.handlers.context({ messages: [{role:'user',content:'Провайдер?'}] }, f.ctx);
    expect(JSON.stringify(context)).toContain('sourceEpisode');
    // Контракт изменён 2026-09-08 дважды:
    //  1) отсутствие чекпоинта СООБЩАЕТСЯ, но работу не блокирует — прежде здесь
    //     ожидалось `continue: true`, принудительный повтор, зацикливавший модель;
    //  2) предупреждение выдаётся ТОЛЬКО если ход что-то менял. Иначе выходило
    //     противоречие: агенту сказано «для пустяков коммит пропусти», и его же
    //     за пропуск ругали на каждом «скажи ок».
    // Ход без изменений: тишина.
    expect(await f.handlers.session_stop({}, f.ctx)).toBeUndefined();
    expect(f.notices.some(x => String(x).includes('CHECKPOINT_MISSING'))).toBe(false);
    // После изменения без чекпоинта — предупреждение появляется.
    await f.handlers.tool_result({ toolName: 'write', isError: false }, f.ctx);
    expect(await f.handlers.session_stop({}, f.ctx)).toBeUndefined();
    expect(f.notices.some(x => String(x).includes('CHECKPOINT_MISSING'))).toBe(true);
    const tool = f.tools.project_memory;
    const saved = await tool.execute('id', { op: 'commit', changes: [], summary: 'No durable changes; architecture unconfigured' }, undefined, undefined, f.ctx);
    expect(saved.isError).not.toBe(true);
    expect(await f.handlers.session_stop({}, f.ctx)).toBeUndefined();
  } finally { f.clean(); }
});
test('later mutation invalidates a checkpoint and own context never accumulates', async () => {
  const f = fixture(); try {
    await f.handlers.before_agent_start({prompt:'Work'},f.ctx);
    await f.tools.project_memory.execute('id',{op:'commit',changes:[],summary:'Nothing changed'},null,null,f.ctx);
    await f.handlers.tool_result({toolName:'write',isError:false},f.ctx);
    // Мутация после чекпоинта делает его недействительным: раньше это вызывало
    // принудительный повтор, теперь — только сообщение.
    expect(await f.handlers.session_stop({},f.ctx)).toBeUndefined();
    expect(f.notices.some(x => String(x).includes('CHECKPOINT_MISSING'))).toBe(true);
    const a = await f.handlers.context({messages:[]},f.ctx);
    const b = await f.handlers.context({messages:a.messages},f.ctx);
    expect(b.messages.length).toBe(1);
  } finally { f.clean(); }
});
test('database initialization failure visible in context and blocks mutation', async () => {
  const f = fixture(); const {mkdirSync,writeFileSync} = await import('node:fs');
  try {
    mkdirSync(join(f.dir,'.memory/runtime'),{recursive:true}); writeFileSync(join(f.dir,'.memory/runtime/state.sqlite'),'corrupt db');
    await f.handlers.before_agent_start({prompt:'Work'},f.ctx);
    expect((await f.handlers.tool_call({toolName:'write',input:{path:'src/a'}},f.ctx)).block).toBe(true);
    const context = await f.handlers.context({messages:[]},f.ctx);
    expect(JSON.stringify(context)).toContain('MEMORY_ERROR');
    expect(f.notices.length).toBeGreaterThan(0);
  } finally { f.clean(); }
});
test('direct policy edits are blocked and shell policy drift fails stop check', async () => {
  const f = fixture(); const {mkdirSync,writeFileSync} = await import('node:fs');
  try {
    mkdirSync(join(f.dir,'.memory'),{recursive:true});
    writeFileSync(join(f.dir,'.memory/architecture.json'),JSON.stringify({configured:false,rules:[]}));
    await f.handlers.before_agent_start({prompt:'Work'},f.ctx);
    expect((await f.handlers.tool_call({toolName:'write',input:{path:'.memory/architecture.json'}},f.ctx)).block).toBe(true);
    writeFileSync(join(f.dir,'.memory/architecture.json'),JSON.stringify({configured:true,rules:[]}));
    await f.tools.project_memory.execute('id',{op:'commit',changes:[],summary:'changed policy'},null,null,f.ctx);
    const result=await f.handlers.session_stop({},f.ctx);
    // additionalContext был частью принудительного продолжения; теперь смотрим
    // на видимое уведомление.
    expect(f.notices.some(x => String(x).includes('POLICY_CHANGED'))).toBe(true);
  } finally {f.clean();}
});

// ЗАМЕРЕНО 2026-09-08 на голом каталоге: расширение заводило `.memory/runtime/state.sqlite`
// в любом проекте, где запущен omp, включая чужие репозитории без `.gitignore` для неё.
test('project without the marker stays inert: no database, no context, no notices', async () => {
  const f = fixture(); try {
    rmSync(join(f.dir, '.memory/MEMORY.md'));   // каталог остался, канонического файла нет
    await f.handlers.before_agent_start({ prompt: 'What does main.py do?' }, f.ctx);
    expect(await f.handlers.context({ messages: [] }, f.ctx)).toBeUndefined();
    await f.handlers.message_end({ message: { role: 'assistant', content: 'an answer' } }, f.ctx);
    expect(await f.handlers.session_stop({}, f.ctx)).toBeUndefined();
    expect(f.notices).toEqual([]);
    expect(existsSync(join(f.dir, '.memory/runtime/state.sqlite'))).toBe(false);
    const denied = await f.tools.project_memory.execute('x', { op: 'status' }, null, null, f.ctx);
    expect(denied.isError).toBe(true);
    expect(String(denied.content[0].text)).toContain('PROJECT_MEMORY_NOT_ENABLED');
  } finally { f.clean(); }
});
test('deploying the marker enables memory on the next prompt, without a restart', async () => {
  const f = fixture(); try {
    rmSync(join(f.dir, '.memory/MEMORY.md'));
    await f.handlers.before_agent_start({ prompt: 'first' }, f.ctx);
    expect(await f.handlers.context({ messages: [] }, f.ctx)).toBeUndefined();
    writeFileSync(join(f.dir, '.memory/MEMORY.md'), '# Память проекта');
    await f.handlers.before_agent_start({ prompt: 'second' }, f.ctx);
    expect(JSON.stringify(await f.handlers.context({ messages: [] }, f.ctx))).toContain('sourceEpisode');
  } finally { f.clean(); }
});

// Команда настроек: подкоманды вместо диалогов ctx.ui, форма которых из документации
// и минифицированного бинарника OMP не извлекается (замерена только арность).
test('/huimem shows state, and refuses a project that is not deployed', async () => {
  const f = fixture(); try {
    const cmd = f.commands.huimem;
    expect(cmd).toBeTruthy();
    await cmd.handler('', f.ctx);
    const shown = String(f.notices.at(-1)?.content ?? '');
    expect(shown).toContain('huimem');
    expect(shown).toContain('recall');
    rmSync(join(f.dir, '.memory/MEMORY.md'));
    await cmd.handler('', f.ctx);
    expect(String(f.notices.at(-1)?.content ?? '')).toContain('PROJECT_MEMORY_NOT_ENABLED');
  } finally { f.clean(); }
});
test('dependsOn through the tool pins the basis, explains staleness on recall, and shows in RECORDS.md', async () => {
  const f = fixture(); try {
    const tool = f.tools.project_memory;
    const say = async (prompt: string, change: any) => {
      await f.handlers.before_agent_start({ prompt }, f.ctx);
      return tool.execute('x', { op: 'commit', summary: 'saved', changes: [{ ...change, source: { origin: 'user', quote: prompt } }] }, null, null, f.ctx);
    };
    expect((await say('Берём PostgreSQL, потому что транзакции.', { id: 'db', kind: 'decision', status: 'accepted', expectedVersion: 0,
      text: 'PostgreSQL', rationale: 'транзакции', dependsOn: [] })).isError).not.toBe(true);
    expect((await say('ORM Drizzle, потому что PostgreSQL.', { id: 'orm', kind: 'decision', status: 'accepted', expectedVersion: 0,
      text: 'Drizzle', rationale: 'PostgreSQL', dependsOn: [{ id: 'db' }] })).isError).not.toBe(true);
    expect(readFileSync(join(f.dir, '.memory/RECORDS.md'), 'utf8')).toContain('Depends on: db v1');
    writeFileSync(join(f.dir, '.memory/MEMORY.md'), '# Память проекта\nпостороннее изменение');
    let orm = await tool.execute('r', { op: 'recall', id: 'orm' }, null, null, f.ctx);
    expect(orm.details.freshness).not.toBe('STALE');
    expect((await say('Переходим на SQLite, потому что один файл.', { id: 'db', kind: 'decision', status: 'accepted', expectedVersion: 1,
      text: 'SQLite', rationale: 'один файл', dependsOn: [] })).isError).not.toBe(true);
    orm = await tool.execute('r', { op: 'recall', id: 'orm' }, null, null, f.ctx);
    expect(orm.details).toMatchObject({ freshness: 'STALE', staleReasons: ['db changed: version 1 -> 2'] });
    const wrong = await say('Кеш Redis, потому что быстро.', { id: 'cache', kind: 'decision', status: 'accepted', expectedVersion: 0,
      text: 'Redis', rationale: 'быстро', dependsOn: [{ id: 'db', version: 1 }] });
    expect(String(wrong.content[0].text)).toContain('DEPENDENCY_VERSION');
  } finally { f.clean(); }
});
test('commit task= ties a checkpoint to its task, recall by id returns it, and a wrong task is refused', async () => {
  const f = fixture(); try {
    mkdirSync(join(f.dir, '.git'));
    writeFileSync(join(f.dir, '.git/HEAD'), 'ref: refs/heads/feature/csv\n');
    const tool = f.tools.project_memory;
    await f.handlers.before_agent_start({ prompt: 'Задача: экспорт счетов в CSV.' }, f.ctx);
    const saved = await tool.execute('1', { op: 'commit', summary: 'Экспорт начат', changes: [{ id: 'task-invoices', kind: 'task', status: 'doing',
      expectedVersion: 0, text: 'Экспорт счетов в CSV', source: { origin: 'user', quote: 'Задача: экспорт счетов в CSV.' } }] }, null, null, f.ctx);
    expect(saved.isError).not.toBe(true);
    await f.handlers.before_agent_start({ prompt: 'Пауза, запиши следующий шаг' }, f.ctx);
    const step = await tool.execute('2', { op: 'commit', changes: [], summary: 'Следующий шаг: колонка НДС', task: 'task-invoices' }, null, null, f.ctx);
    expect(step.isError).not.toBe(true);
    const wrong = await tool.execute('3', { op: 'commit', changes: [], summary: 'x', task: 'nope' }, null, null, f.ctx);
    expect(wrong.isError).toBe(true);
    expect(String(wrong.content[0].text)).toContain('INVALID_TASK_SCOPE');
    const recalled = await tool.execute('4', { op: 'recall', id: 'task-invoices' }, null, null, f.ctx);
    expect(recalled.details.lastCheckpoint).toMatchObject({ summary: 'Следующий шаг: колонка НДС', branch: 'feature/csv' });

    await f.handlers.before_agent_start({ prompt: 'Что дальше по экспорту счетов?' }, f.ctx);
    const out: any = await f.handlers.context({ messages: [] }, f.ctx);
    const block = out.messages.find((m: any) => m.customType === 'project-memory-context').content as string;
    expect(block).toContain('- task-invoices [doing, matches this request;');
    expect(block).toContain('branch feature/csv]: Следующий шаг: колонка НДС');
    await f.commands.huimem.handler('context', f.ctx);
    expect(String(f.notices.at(-1)?.content ?? '')).toContain('"task": "task-invoices"');
  } finally { f.clean(); }
});

// Экран настроек в интерактивном терминале: сценарий нажатий подаётся вместо пользователя.
function scriptedUi(f: any, answers: any[]) {
  const screens: { title: string; labels: string[]; initialIndex?: number }[] = [];
  const labelsOf = (items: any[]) => items.map(i => typeof i === 'string' ? i : i.label);
  f.ctx.mode = 'tui';
  f.ctx.ui = {
    notify: (s: string) => f.notices.push(s),
    select: async (title: string, items: any[], opts?: any) => {
      screens.push({ title, labels: labelsOf(items), initialIndex: opts?.initialIndex });
      const a = answers.shift();
      return typeof a === 'function' ? a(labelsOf(items)) : a;
    },
    input: async () => answers.shift(),
    confirm: async () => answers.shift(),
  };
  return screens;
}
const starting = (prefix: string) => (labels: string[]) => labels.find(l => l.startsWith(prefix));

test('/huimem opens a settings screen in the terminal and applies choices through the same checks', async () => {
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, '.memory/settings.json'), 'utf8'));
  const f = fixture(); try {
    const s = new MemoryStore(f.dir);
    const quote = 'Ключи никогда не пишем в логи. Причина: утечки.';
    const episode = s.capture('seed', 'user', quote);
    s.commit('seed', [{ id: 'security-rule', kind: 'decision', status: 'accepted', expectedVersion: 0, text: quote,
      rationale: 'утечки', source: { episode, quote } } as any], 'seed');
    s.close();
    const screens = scriptedUi(f, [
      starting('Recall budget'), '4500',
      starting('Injection limit'), '99999',
      starting('Commits'),
      starting('Required records'), starting('[ ] security-rule'), 'Back',
      starting('Reset limits'), true,
      undefined,
    ]);
    await f.commands.huimem.handler('', f.ctx);
    const saved = read(f.dir);
    expect(saved.recallBudget).toBe(LIMITS.recallBudget.default);
    expect(saved.injectionLimit).toBe(LIMITS.injectionLimit.default);
    expect(saved.required).toEqual(['security-rule']);
    expect(f.notices.some((n: any) => String(n).includes('recallBudget = 4500'))).toBe(true);
    expect(f.notices.some((n: any) => String(n).includes('saved the nearest allowed value: 16000'))).toBe(true);
    // Экран показывает текущие значения и возвращает курсор на последний пункт.
    const main = screens.filter(x => x.title.startsWith('huimem ·'));
    expect(main[1].labels).toContain('Recall budget: 4500');
    expect(main[3].labels).toContain('Commits: PAUSED');
    expect(main[3].initialIndex).toBe(0);
    expect(screens.find(x => x.title.startsWith('Required records'))!.labels).toContain('[ ] security-rule');
    const denied = await f.tools.project_memory.execute('x', { op: 'commit', changes: [], summary: 'x' }, null, null, f.ctx);
    expect(String(denied.content[0].text)).toContain('COMMITS_PAUSED');
    // Длинные отчёты закрывают экран, чтобы их можно было прочитать.
    const before = f.notices.length;
    scriptedUi(f, [starting('Architecture')]);
    await f.commands.huimem.handler('', f.ctx);
    expect(String(f.notices.at(-1)?.content ?? '')).toContain('.memory/architecture.json');
    expect(f.notices.length).toBe(before + 1);
  } finally { f.clean(); }
});

test('the settings screen enables memory in a bare project, and RPC mode keeps the text output', async () => {
  const f = fixture(); try {
    rmSync(join(f.dir, '.memory'), { recursive: true, force: true });
    const screens = scriptedUi(f, ['Enable memory in this project', undefined]);
    await f.commands.huimem.handler('', f.ctx);
    expect(screens[0].title).toContain('memory is OFF here');
    expect(existsSync(join(f.dir, '.memory/MEMORY.md'))).toBe(true);
    expect(screens[1].title).toContain('records');
    f.ctx.mode = 'rpc';
    const calls = screens.length;
    await f.commands.huimem.handler('', f.ctx);
    expect(screens.length).toBe(calls);
    expect(String(f.notices.at(-1)?.content ?? '')).toContain('huimem project memory');
  } finally { f.clean(); }
});

test('/huimem init enables memory in a bare project without copying the starter', async () => {
  const last = (f: any) => String(f.notices.at(-1)?.content ?? '');
  const f = fixture(); try {
    rmSync(join(f.dir, '.memory'), { recursive: true, force: true });
    await f.handlers.before_agent_start({ prompt: 'first' }, f.ctx);
    expect(await f.handlers.context({ messages: [] }, f.ctx)).toBeUndefined();
    const off = await f.tools.project_memory.execute('x', { op: 'status' }, null, null, f.ctx);
    expect(String(off.content[0].text)).toContain('/huimem init');
    await f.commands.huimem.handler('', f.ctx);
    expect(last(f)).toContain('/huimem init');

    await f.commands.huimem.handler('init', f.ctx);
    expect(last(f)).toContain('Project memory ENABLED');
    for (const path of ['.memory/MEMORY.md', '.memory/todo.json', '.omp/config.yml', '.omp/RULES.md', 'AGENTS.md'])
      expect(existsSync(join(f.dir, path))).toBe(true);
    expect(readFileSync(join(f.dir, '.gitignore'), 'utf8')).toContain('.memory/runtime/');
    expect(existsSync(join(f.dir, '.memory/runtime'))).toBe(false);

    await f.handlers.before_agent_start({ prompt: 'second' }, f.ctx);
    expect(JSON.stringify(await f.handlers.context({ messages: [] }, f.ctx))).toContain('sourceEpisode');
    await f.commands.huimem.handler('init', f.ctx);
    expect(last(f)).toContain('already enabled');
    expect(last(f)).toContain('Created: nothing');
  } finally { f.clean(); }
});
test('/huimem clamps an out-of-range limit and says so instead of failing quietly', async () => {
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, '.memory/settings.json'), 'utf8'));
  const f = fixture(); try {
    const cmd = f.commands.huimem;
    await cmd.handler('recall 4000', f.ctx);
    expect(read(f.dir).recallBudget).toBe(4000);
    await cmd.handler('recall 99999', f.ctx);
    expect(read(f.dir).recallBudget).toBe(12000);
    expect(String(f.notices.at(-1)?.content ?? '')).toContain('12000');
    await cmd.handler('reset', f.ctx);
    expect(read(f.dir).recallBudget).toBe(3200);
    await cmd.handler('нетакой', f.ctx);
    expect(String(f.notices.at(-1)?.content ?? '')).toContain('Unknown subcommand');
  } finally { f.clean(); }
});
// Обязательные записи задаёт только пользователь; модель не может снять их правкой файла.
test('/huimem require marks only existing active records, and the model cannot edit the list', async () => {
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, '.memory/settings.json'), 'utf8'));
  const last = (f: any) => String(f.notices.at(-1)?.content ?? '');
  const f = fixture(); try {
    const s = new MemoryStore(f.dir);
    const quote = 'Ключи никогда не пишем в логи. Причина: утечки.';
    const episode = s.capture('seed', 'user', quote);
    s.commit('seed', [{ id: 'security-rule', kind: 'decision', status: 'accepted', expectedVersion: 0, text: quote,
      rationale: 'утечки', source: { episode, quote } } as any], 'seed');
    const e2 = s.capture('seed', 'user', 'Старое. Причина: было.');
    s.commit('seed2', [{ id: 'old', kind: 'decision', status: 'retired', expectedVersion: 0, text: 'old',
      rationale: 'было', source: { episode: e2, quote: 'Старое. Причина: было.' } } as any], 'seed');
    for (let i = 0; i < 12; i++) s.commit('seed-minor-' + i, [{ id: `minor-${String(i).padStart(2, '0')}`, kind: 'fact', status: 'active', expectedVersion: 0,
      text: `Отступ ${i} в конфиге.`, source: { episode, quote } } as any], 'seed');
    s.close();
    const cmd = f.commands.huimem;
    await cmd.handler('require nope', f.ctx);
    expect(last(f)).toContain('No record with id nope');
    expect(existsSync(join(f.dir, '.memory/settings.json'))).toBe(false);
    await cmd.handler('require old', f.ctx);
    expect(last(f)).toContain('retired');
    await cmd.handler('require security-rule', f.ctx);
    expect(read(f.dir).required).toEqual(['security-rule']);
    await cmd.handler('reset', f.ctx);
    expect(read(f.dir).required).toEqual(['security-rule']);
    await cmd.handler('', f.ctx);
    expect(last(f)).toContain('Required records:   security-rule');

    await f.handlers.before_agent_start({ prompt: 'Поправь отступы в конфиге' }, f.ctx);
    for (const path of ['.memory/settings.json', '.MEMORY/Settings.json'])
      expect((await f.handlers.tool_call({ toolName: 'write', input: { path } }, f.ctx))?.block).toBe(true);
    const delivered = async () => {
      const out: any = await f.handlers.context({ messages: [] }, f.ctx);
      const block = out.messages.find((m: any) => m.customType === 'project-memory-context').content as string;
      return { block, ids: block.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l).id) };
    };
    const normal = await delivered();
    expect(normal.ids[0]).toBe('security-rule');
    expect(normal.ids).toContain('minor-00');
    // Бюджет меньше самой короткой формы записи: правило не выдаётся, но названо.
    writeFileSync(join(f.dir, '.memory/settings.json'), JSON.stringify({ recallBudget: 500, required: ['security-rule'] }));
    const tiny = await delivered();
    expect(tiny.ids).not.toContain('security-rule');
    expect(tiny.block).toContain('REQUIRED records not shown in full: security-rule');

    await cmd.handler('unrequire security-rule', f.ctx);
    expect(read(f.dir).required).toEqual([]);
  } finally { f.clean(); }
});
test('configured injection limit actually bounds the injected block', async () => {
  const f = fixture(); try {
    writeFileSync(join(f.dir, '.memory/MEMORY.md'), '# Память проекта' + ' факт проекта.'.repeat(600));
    await f.handlers.before_agent_start({ prompt: 'факт' }, f.ctx);
    const wide: any = await f.handlers.context({ messages: [] }, f.ctx);
    const wideLen = wide.messages.find((m: any) => m.customType === 'project-memory-context').content.length;
    writeFileSync(join(f.dir, '.memory/settings.json'), JSON.stringify({ injectionLimit: LIMITS.injectionLimit.min }));
    await f.handlers.before_agent_start({ prompt: 'факт' }, f.ctx);
    const tight: any = await f.handlers.context({ messages: [] }, f.ctx);
    const tightLen = tight.messages.find((m: any) => m.customType === 'project-memory-context').content.length;
    expect(tightLen).toBeLessThanOrEqual(LIMITS.injectionLimit.min);
    expect(wideLen).toBeGreaterThan(tightLen);
    const s=new MemoryStore(f.dir);
    try {
      expect(s.lastContext().characters).toBe(tightLen);
      expect(s.lastContext().truncated).toBe(true);
    } finally { s.close(); }
    await f.commands.huimem.handler('context',f.ctx);
    expect(JSON.stringify(f.notices)).toContain('Last prepared memory block');
  } finally { f.clean(); }
});
test('a corrupt settings file falls back to defaults without breaking the turn', async () => {
  const f = fixture(); try {
    writeFileSync(join(f.dir, '.memory/settings.json'), 'это не json');
    await f.handlers.before_agent_start({ prompt: 'x' }, f.ctx);
    const out: any = await f.handlers.context({ messages: [] }, f.ctx);
    expect(JSON.stringify(out)).toContain('sourceEpisode');
    await f.commands.huimem.handler('', f.ctx);
    expect(String(f.notices.at(-1)?.content ?? '')).toContain('3200');
  } finally { f.clean(); }
});

}
