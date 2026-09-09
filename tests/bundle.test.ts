import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/core';
import install from '../dist/index.js';

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
