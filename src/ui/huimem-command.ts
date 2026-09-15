import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LIMITS, REQUIRED_MAX, readSettings, writeSettings, SETTINGS_PATH } from '../memory/settings';
import { apply, audit } from '../memory/adr-audit';
import { initProject } from '../memory/starter';
import { diagnoseMemory, formatDoctor } from '../memory/doctor';

// Два способа управления поверх одного ядра run(): экран настроек в интерактивном терминале
// и подкоманды для RPC, -p и скриптов. Сигнатуры диалогов сверены 2026-09-14 с исходником
// тега v18.1.5 (packages/coding-agent/src/extensibility/extensions/types.ts):
// select(title, items: (string | {label, description})[], {initialIndex}) -> label | undefined,
// input(title, placeholder) -> string | undefined, confirm(title, message) -> boolean, mode "tui".
// Родная вкладка /settings -> Plugins не подходит: её значения глобальны для пользователя,
// а настройки памяти принадлежат проекту и едут с репозиторием.

export type CommandDeps = {
  deployed: (ctx: any) => boolean;
  notEnabled: string;
  store: (ctx: any) => any;
  architecture: (ctx: any) => { configured: boolean; ok: boolean; failures: string[] };
  health: () => string;
  commitsPaused: (ctx: any) => boolean;
  setPaused: (ctx: any, value: boolean) => void;
};

const HELP = [
  'Usage:',
  '  /huimem init         enable memory in this project: create missing starter files, never overwrite',
  '  /huimem pause        block commits in this project for this OMP process',
  '  /huimem resume       allow commits again',
  '  /huimem              memory state for this project',
  '  /huimem recall <N>   recall budget in characters (' + LIMITS.recallBudget.min + '–' + LIMITS.recallBudget.max + ')',
  '  /huimem limit <N>    injected context limit in characters (' + LIMITS.injectionLimit.min + '–' + LIMITS.injectionLimit.max + ')',
  '  /huimem arch         architecture rules and the check result',
  '  /huimem omp          OMP settings that affect memory',
  '  /huimem require <id>    deliver this record every turn, even when unrelated to the question (max ' + REQUIRED_MAX + ')',
  '  /huimem unrequire <id>  stop delivering it unconditionally',
  '  /huimem reset        restore the default limits',
  '  /huimem sync         retry publishing .memory/RECORDS.md from saved records',
  '  /huimem context      inspect the latest memory block prepared for OMP',
  '  /huimem doctor       diagnose memory, sources and task-file drift without repairs',
  '  /huimem adr-audit    propose moving legacy ADRs into the basis contract (dry run)',
  '  /huimem adr-audit apply   write that migration; originals are backed up',
].join('\n');

// Показываем, но не трогаем: это чужой конфиг, его меняет сам OMP.
const OMP_KEYS: [string, string][] = [
  ['memory.backend', "keep 'off': the transcript writer here is this extension"],
  ['providers.fetch', 'trafilatura extracts article text instead of the whole page'],
  ['includeWorkspaceTree', 'false keeps the file tree out of the context'],
  ['compaction.supersedeReads', 'true supersedes an earlier read of the same file'],
];

export function registerSettingsCommand(pi: any, deps: CommandDeps) {
  const send = (text: string) =>
    pi.sendMessage({ customType: 'huimem-settings', content: text, display: true });

  // Одно ядро для подкоманд и экрана настроек: экран вызывает те же действия, поэтому
  // проверки пределов, require и init не расходятся между двумя способами управления.
  async function run(verb: string | undefined, value: string | undefined, ctx: any, say: (text: string) => unknown = send) {
    if (verb === 'help' || verb === '--help') return say(HELP);
    if (verb === 'doctor') return say(formatDoctor(diagnoseMemory(ctx.cwd)));

    // Память включается явной командой в выбранном проекте, а не сама в каждом каталоге:
    // иначе база со стенограммой появлялась бы в чужих репозиториях (замерено 2026-09-08).
    if (verb === 'init') {
      const wasEnabled = deps.deployed(ctx);
      let r;
      try { r = initProject(ctx.cwd); } catch (e) { return say('Init failed: ' + String(e)); }
      const merge = r.differs.filter(p => ['AGENTS.md', '.omp/config.yml', '.omp/RULES.md'].includes(p));
      return say([
        wasEnabled ? `Project memory was already enabled in ${r.root}; only missing files were added.`
          : `Project memory ENABLED in ${r.root}. It works from your next message; no restart needed.`,
        r.created.length ? 'Created:\n  ' + r.created.join('\n  ') : 'Created: nothing, every starter file already exists.',
        r.differs.length ? 'Existing files kept as they are (not overwritten):\n  ' + r.differs.join('\n  ') : '',
        merge.length ? 'These may lack the memory rules shipped in the plugin starter/: ' + merge.join(', ') + '. Merge them by hand if you want those rules.' : '',
        r.gitignoreAdded.length ? '.gitignore: added ' + r.gitignoreAdded.join(', ') + ' so the local transcript database stays out of git.' : '.gitignore already excludes the memory database.',
        '',
        'Next: ask the agent to use the initmem skill to map the real code.',
        'Architecture rules are not configured yet (/huimem arch); records you must never lose: /huimem require <id>.',
      ].filter(Boolean).join('\n'));
    }

    if (!deps.deployed(ctx)) {
      return say(
        'Project memory is OFF here.\n' + deps.notEnabled +
        '\nRequires OMP and a configured main model. mnemopi is NOT required; huimem uses its own local SQLite.' +
        '\n\nStart omp in the project root and run /huimem init. Memory turns on with your next message; no restart needed.',
      );
    }

    const cfg = readSettings(ctx.cwd);
    if(verb==='pause' || verb==='resume') {
      deps.setPaused(ctx,verb==='pause');
      return say(verb==='pause'
        ? 'Commits PAUSED for this project in this OMP process. Records and checkpoints cannot be saved through project_memory. Transcript capture, diagnostics and file tools remain active. Restart clears the pause.'
        : 'Commits enabled for this project in this OMP process.');
    }
    const settingsFileExists = existsSync(resolve(ctx.cwd, SETTINGS_PATH));
    if (verb === 'context') {
      try {
        const store=deps.store(ctx);
        const receipt=store.lastContext(), retrieval=store.lastRetrieval();
        return say((receipt ? 'Last prepared memory block (not proof the model used it):\n'+JSON.stringify(receipt,null,2)
          : 'No memory block has been prepared for this project yet.')+
          '\nLatest retrieval (may be a different run; JS character counts, not tokens):\n'+JSON.stringify(retrieval,null,2));
      } catch(e) { return say('Context trace unavailable: '+String(e)); }
    }
    if (verb === 'sync') {
      try {
        const result=deps.store(ctx).sync();
        return say(`Readable registry: ${result.state}\n${result.path}` + (result.error ? '\n'+result.error : ''));
      } catch(e) { return say('Sync failed: '+String(e)); }
    }

    const setNumber = (field: 'recallBudget' | 'injectionLimit', limit: typeof LIMITS.recallBudget) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return say(`Expected a number between ${limit.min} and ${limit.max}. Current: ${cfg[field]}.`);
      const saved = writeSettings(ctx.cwd, { [field]: n } as any);
      const got = saved[field];
      // Значение вне пределов не отвергается молча и не принимается молча: говорим,
      // что записали на самом деле.
      return say(
        got === Math.round(n)
          ? `Saved: ${field} = ${got}. Applies from the next turn. File: ${SETTINGS_PATH}`
          : `Value ${n} is outside ${limit.min}-${limit.max}; saved the nearest allowed value: ${got}.`,
      );
    };

    if (verb === 'recall') return setNumber('recallBudget', LIMITS.recallBudget);
    if (verb === 'limit') return setNumber('injectionLimit', LIMITS.injectionLimit);

    if (verb === 'reset') {
      const saved = writeSettings(ctx.cwd, {
        recallBudget: LIMITS.recallBudget.default,
        injectionLimit: LIMITS.injectionLimit.default,
      });
      return say(`Limits restored to defaults: recall ${saved.recallBudget}, injection ${saved.injectionLimit}.`);
    }

    if (verb === 'arch') {
      const path = resolve(ctx.cwd, '.memory/architecture.json');
      const a = deps.architecture(ctx);
      let body: string;
      try { body = readFileSync(path, 'utf8').trim(); } catch { body = '(no such file)'; }
      return say(
        [
          a.configured
            ? (a.ok ? 'Rules are configured and no violation was found.' : 'Rules are configured and violated:\n  - ' + a.failures.join('\n  - '))
            : 'Rules are NOT configured. Architectural conformance is not verified; this is not a storage failure.',
          '',
          'File .memory/architecture.json:',
          body,
          '',
          'Edit this file outside an active session and start a new one: the extension blocks edits',
          'through file tools and reports POLICY_CHANGED when it changes mid-session.',
        ].join('\n'),
      );
    }

    if (verb === 'omp') {
      const rows = OMP_KEYS.map(([k, why]) => `  ${k.padEnd(28)} ${why}`);
      return say(
        ['OMP settings that affect memory. The plugin does not change them: this config is not its own.', '', ...rows, '',
          'Read current:  omp config get <key>',
          'Change:        omp config set <key> <value>',
          'Project values come from .omp/config.yml and override the global config.',
        ].join('\n'),
      );
    }

    if (verb === 'adr-audit') {
      try {
        const store = deps.store(ctx);
        const date = new Date().toISOString().slice(0, 10);
        const readEpisode = (id:string) => store.episode(id);
        const stale = 'Decisions saved without dependsOn track the hash of all canonical documents and will show STALE afterwards; records with dependsOn only if they list a rewritten ADR. User quotes are unchanged.';
        const describe = (i: any) =>
          i.state === 'has-basis' ? `  OK       ${i.path} — already has a basis section`
          : i.state === 'conflict' ? `  CONFLICT ${i.path} — ${i.reason}; no migration written`
          : i.state === 'unverified' ? `  UNVERIFIED ${i.path} <- ${i.recordId} — ${i.reason}; no migration written`
          : i.state === 'no-match' ? `  SKIP     ${i.path} — no accepted user decision names this document; nothing proposed`
          : i.state === 'ambiguous' ? `  SKIP     ${i.path} — several decisions name it (${i.candidates.join(', ')}); nothing chosen`
          : `  MIGRATE  ${i.path}  <-  ${i.recordId} v${i.version}\n           basis: ${i.quote.split('\n')[0].slice(0, 160)}\n           all original lines move under "Interpretation [?]"; nothing is deleted`;
        if (value === 'apply') {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const { written, skipped } = apply(ctx.cwd, store.latestRecords(), date, stamp,readEpisode);
          return say([
            `ADR migration applied: ${written.length} written, ${skipped.length} skipped.`,
            ...written.map(w => `  WROTE    ${w.path}  <-  ${w.recordId}\n           original: ${w.backup}`),
            ...skipped.map(describe),
            '', written.length ? stale : 'No documents migrated; see skip reasons above.',
          ].join('\n'));
        }
        const items = audit(ctx.cwd, store.latestRecords(), date,readEpisode);
        const pending = items.filter(i => i.state === 'migratable').length;
        return say([
          `ADR audit (dry run, nothing written): ${items.length} document(s), ${pending} can be migrated.`,
          ...items.map(describe), '',
          'A basis requires an accepted decision, an exact rationale inside its quote, and that exact quote in the stored user episode.',
          'No document is declared false. Unmatched or ambiguous documents are never guessed.',
          pending ? `Run /huimem adr-audit apply to write. Originals go to .memory/adr-backup/. ${stale}` : '',
        ].join('\n'));
      } catch (e) { return say('ADR audit failed: ' + String(e)); }
    }

    // Обязательные записи задаёт только пользователь: модель не может объявить удобное ей
    // правило необязательным, а файл настроек закрыт от её файловых инструментов.
    if (verb === 'require' || verb === 'unrequire') {
      if (!value) return say(`Required records: ${cfg.required.length ? cfg.required.join(', ') : 'none'}.\nUsage: /huimem ${verb} <id>`);
      if (verb === 'unrequire') {
        if (!cfg.required.includes(value)) return say(`${value} is not required. Required records: ${cfg.required.join(', ') || 'none'}.`);
        const saved = writeSettings(ctx.cwd, { required: cfg.required.filter(id => id !== value) });
        return say(`${value} is no longer required; it is still recalled when relevant. Required: ${saved.required.join(', ') || 'none'}.`);
      }
      if (cfg.required.includes(value)) return say(`${value} is already required.`);
      if (cfg.required.length >= REQUIRED_MAX) return say(`At most ${REQUIRED_MAX} required records. Remove one with /huimem unrequire <id> first.`);
      let record: any;
      try { record = deps.store(ctx).current(value); } catch (e) { return say('Memory unavailable: ' + String(e)); }
      if (!record) return say(`No record with id ${value}. Use the exact id shown in .memory/RECORDS.md.`);
      if (record.status === 'retired') return say(`${value} is retired; a retired record cannot be required.`);
      const saved = writeSettings(ctx.cwd, { required: [...cfg.required, value] });
      return say(`Required: ${saved.required.join(', ')}. ${value} v${record.version} is delivered every turn from the next one; if the budget cannot hold it, the memory block names it. File: ${SETTINGS_PATH}`);
    }

    if (verb) return say(`Unknown subcommand: ${verb}\n\n` + HELP);

    // Без аргументов — состояние.
    let counts = 'unavailable', projection='unavailable';
    try {
      const s = deps.store(ctx);
      const st = s.status();
      const {projection: view,...metrics}=st;
      counts = Object.entries(metrics).map(([k, v]) => `${k}=${v}`).join(' · ');
      projection = view.state + (view.error ? ' — '+view.error : '');
    } catch (e) { counts = 'ERROR: ' + String(e); }
    const a = deps.architecture(ctx);
    const err = deps.health();
    return say(
      [
        'huimem project memory',
        `Commits:            ${deps.commitsPaused(ctx) ? 'PAUSED (this process)' : 'enabled'}`,
        'Requires OMP + a main model. No mnemopi, memory server or additional model required.',
        '',
        `Storage:            ${counts}`,
        `Readable registry:  ${projection}`,
        `Architecture:       ${a.configured ? (a.ok ? 'configured, no violation' : 'VIOLATIONS: ' + a.failures.join('; ')) : 'not configured'}`,
        `Recall budget:      ${cfg.recallBudget} characters`,
        `Injection limit:    ${cfg.injectionLimit} characters`,
        `Required records:   ${cfg.required.length ? cfg.required.join(', ') : 'none'}`,
        `Settings file:      ${settingsFileExists ? SETTINGS_PATH : 'none, defaults apply'}`,
        err ? `Health:             ${err}` : 'Health:             no errors',
        '',
        HELP,
      ].join('\n'),
    );
  }

  pi.registerCommand('huimem', {
    description: 'huimem project memory: settings screen, or subcommands (/huimem help)',
    handler: async (args: any, ctx: any) => {
      const [verb, value] = String(args ?? '').trim().split(/\s+/).filter(Boolean);
      // Экран открывается только в интерактивном терминале; в RPC, -p и json остаётся текст.
      if (!verb && ctx?.hasUI && ctx?.mode === 'tui' && typeof ctx.ui?.select === 'function') return settingsScreen(ctx);
      return run(verb, value, ctx);
    },
  });

  // Экран настроек: пункт показывает текущее значение, Enter меняет его или выполняет действие.
  // Esc закрывает. Изменения идут через run(), поэтому пределы и проверки те же, что у подкоманд.
  async function settingsScreen(ctx: any) {
    const ui = ctx.ui;
    const note = (text: string) => ui.notify(text, 'info');
    let cursor = 0;
    for (;;) {
      if (!deps.deployed(ctx)) {
        const enable = 'Enable memory in this project';
        const pick = await ui.select(`huimem · ${ctx.cwd} · memory is OFF here`, [
          { label: enable, description: 'Creates missing starter files (.memory, .omp, AGENTS.md, .gitignore lines). Existing files are never overwritten.' },
          { label: 'Close', description: 'Memory stays off; nothing is created.' },
        ]);
        if (pick !== enable) return;
        await run('init', undefined, ctx);
        continue;
      }
      const cfg = readSettings(ctx.cwd);
      let records = '?', view = 'unavailable';
      try { const st = deps.store(ctx).status(); records = String(st.records); view = st.projection.state; }
      catch (e) { view = 'ERROR: ' + String(e); }
      const a = deps.architecture(ctx);
      const paused = deps.commitsPaused(ctx);
      // Действие возвращает true, если после него экран закрывается: вывод длинный и его нужно прочитать.
      const items: [string, string, () => Promise<boolean | void>][] = [
        [`Commits: ${paused ? 'PAUSED' : 'enabled'}`, 'Enter toggles. Pause blocks project_memory commit in this OMP process; a restart clears it.',
          async () => { await run(paused ? 'resume' : 'pause', undefined, ctx, note); }],
        [`Recall budget: ${cfg.recallBudget}`, `Characters of registry records per turn, ${LIMITS.recallBudget.min}–${LIMITS.recallBudget.max}.`,
          async () => editNumber(ctx, 'recall', 'Recall budget', cfg.recallBudget, LIMITS.recallBudget)],
        [`Injection limit: ${cfg.injectionLimit}`, `Characters of the whole memory block, ${LIMITS.injectionLimit.min}–${LIMITS.injectionLimit.max}.`,
          async () => editNumber(ctx, 'limit', 'Injection limit', cfg.injectionLimit, LIMITS.injectionLimit)],
        [`Required records: ${cfg.required.length ? cfg.required.join(', ') : 'none'}`, 'Records delivered every turn, even when unrelated to the question.',
          async () => requiredScreen(ctx)],
        [`Architecture: ${a.configured ? (a.ok ? 'no violation' : 'VIOLATIONS') : 'not configured'}`, 'Show the rules and the check result.',
          async () => { await run('arch', undefined, ctx); return true; }],
        [`Readable registry: ${view}`, 'Republish .memory/RECORDS.md from saved records.',
          async () => { await run('sync', undefined, ctx, note); }],
        ['Last memory block', 'Diagnostics of the block prepared for the model; not proof it was used.',
          async () => { await run('context', undefined, ctx); return true; }],
        ['Memory doctor', 'Inspect sources, required records and task drift; no repairs.',
          async () => { await run('doctor', undefined, ctx); return true; }],
        ['Legacy ADR migration', 'Shows the plan first and asks before writing anything.',
          async () => adrMigration(ctx)],
        ['OMP settings that affect memory', 'Shown only; the plugin does not change OMP config.',
          async () => { await run('omp', undefined, ctx); return true; }],
        ['Reset limits', `Recall ${LIMITS.recallBudget.default}, injection ${LIMITS.injectionLimit.default}. Required records stay.`,
          async () => { if (await ui.confirm('Reset limits?', `Recall budget ${LIMITS.recallBudget.default}, injection limit ${LIMITS.injectionLimit.default}. Required records are kept.`)) await run('reset', undefined, ctx, note); }],
        ['Close', 'Esc also closes.', async () => true],
      ];
      const health = deps.health();
      const pick = await ui.select(`huimem · ${ctx.cwd} · ${records} records${health ? ' · ' + health : ''}`,
        items.map(([label, description]) => ({ label, description })), { initialIndex: cursor });
      const index = items.findIndex(([label]) => label === pick);
      if (index < 0) return;
      cursor = index;
      if (await items[index][2]()) return;
    }
  }

  async function editNumber(ctx: any, verb: string, name: string, current: number, limit: { min: number; max: number }) {
    const value = await ctx.ui.input(`${name}, ${limit.min}–${limit.max} characters`, String(current));
    if (value === undefined || !value.trim()) return;
    await run(verb, value.trim(), ctx, (text: string) => ctx.ui.notify(text, 'info'));
  }

  async function requiredScreen(ctx: any) {
    const note = (text: string) => ctx.ui.notify(text, 'info');
    let cursor = 0;
    for (;;) {
      const cfg = readSettings(ctx.cwd);
      let rows: any[];
      try { rows = deps.store(ctx).latestRecords(); } catch (e) { ctx.ui.notify('Memory unavailable: ' + String(e), 'error'); return; }
      const active = rows.filter(r => r.data.status !== 'retired').slice(0, 200);
      const options: { label: string; description: string; id?: string }[] = active.map(r => ({
        label: `${cfg.required.includes(r.id) ? '[x]' : '[ ]'} ${r.id}`, id: r.id,
        description: `${r.data.kind} · ${r.data.status} · v${r.version} · ${String(r.data.text ?? '').replace(/\s+/g, ' ').slice(0, 90)}`,
      }));
      // Снятая с действия или удалённая обязательная запись видна, чтобы её можно было убрать из списка.
      for (const id of cfg.required.filter(id => !active.some(r => r.id === id)))
        options.push({ label: `[x] ${id} (not active)`, id, description: 'Retired or missing. Enter removes it from the list.' });
      if (!active.length) options.push({ label: 'No saved records yet', description: 'Records appear after the agent commits a decision, fact or task.' });
      options.push({ label: 'Back', description: '' });
      const pick = await ctx.ui.select(`Required records ${cfg.required.length}/${REQUIRED_MAX} · Enter toggles`,
        options.map(({ label, description }) => ({ label, description })), { initialIndex: cursor });
      const index = options.findIndex(o => o.label === pick);
      if (index < 0 || !options[index].id) return;
      cursor = index;
      const id = options[index].id!;
      await run(cfg.required.includes(id) ? 'unrequire' : 'require', id, ctx, note);
    }
  }

  async function adrMigration(ctx: any) {
    await run('adr-audit', undefined, ctx);
    let pending = 0;
    try {
      const store = deps.store(ctx);
      pending = audit(ctx.cwd, store.latestRecords(), new Date().toISOString().slice(0, 10), (id: string) => store.episode(id))
        .filter(i => i.state === 'migratable').length;
    } catch { return true; }
    if (pending && await ctx.ui.confirm(`Migrate ${pending} ADR document(s)?`,
      'Originals are copied byte-exact to .memory/adr-backup/ first. Linked conversation decisions will show STALE afterwards.'))
      await run('adr-audit', 'apply', ctx);
    return true;
  }
}
