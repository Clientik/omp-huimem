import { describe, test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/core';
import installSource from '../src/extensions/project-memory';
import installBundle from '../dist/index.js';

describe('source adapter', () => adapterContract(installSource));
describe('built bundle', () => adapterContract(installBundle));

function adapterContract(install: typeof installSource) {

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
    const withBasis=await mark(contract);
    expect(withBasis).toContain('only the 1 quoted line(s)');
    // Раздел «Последствия» цитируемым не становится, даже будучи внутри принятого ADR.
    expect(withBasis).toContain('is not verified by acceptance');
    const legacy=await mark('# 0002\n\n- Статус: принято\n\nПри большем числе попыток срабатывает дедупликация.');
    expect(legacy).toContain('NO basis section');
    expect(legacy).not.toContain('quoted line(s)');
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
test('configured injection limit actually bounds the injected block', async () => {
  const f = fixture(); try {
    writeFileSync(join(f.dir, '.memory/MEMORY.md'), '# Память проекта' + ' факт проекта.'.repeat(600));
    await f.handlers.before_agent_start({ prompt: 'факт' }, f.ctx);
    const wide: any = await f.handlers.context({ messages: [] }, f.ctx);
    const wideLen = wide.messages.find((m: any) => m.customType === 'project-memory-context').content.length;
    writeFileSync(join(f.dir, '.memory/settings.json'), JSON.stringify({ injectionLimit: 2000 }));
    await f.handlers.before_agent_start({ prompt: 'факт' }, f.ctx);
    const tight: any = await f.handlers.context({ messages: [] }, f.ctx);
    const tightLen = tight.messages.find((m: any) => m.customType === 'project-memory-context').content.length;
    expect(tightLen).toBeLessThanOrEqual(2000);
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
