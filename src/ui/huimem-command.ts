import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LIMITS, REQUIRED_MAX, DOCUMENTS_MAX, documentPath, readSettings, writeSettings, SETTINGS_PATH } from '../memory/settings';
import { apply, audit } from '../memory/adr-audit';
import { initProject } from '../memory/starter';
import { diagnoseMemory, formatDoctor } from '../memory/doctor';
import { PLUGIN_VERSION, upgradeNotes } from '../memory/version';
import { learningStatus } from '../memory/learning';

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
  switchedOn: (ctx: any) => boolean;
  setEnabled: (ctx: any, value: boolean) => void;
  store: (ctx: any) => any;
  architecture: (ctx: any) => { configured: boolean; ok: boolean; failures: string[] };
  health: () => string;
  commitsPaused: (ctx: any) => boolean;
  setPaused: (ctx: any, value: boolean) => void;
  personalEnabled: () => Promise<boolean>;
  setPersonalEnabled: (value: boolean) => Promise<void>;
  learn: (ctx: Parameters<CommandDeps['store']>[0]) => Promise<void>;
  // Только чтение. Уровень размышления принадлежит OMP; память его показывает, но не меняет:
  // ЗАМЕРЕНО 2026-10-14 в HUICAD — проектный autoThinkingMaxEffort: high не перекрыл глобальный
  // max, и расхождение пришлось искать по файлам сессий. Метода может не быть в старом OMP.
  thinkingLevel: () => string | undefined;
  // OMP may leave the hooks running while the session tool set lacks project_memory (seen after plan approval).
  toolHidden: () => boolean;
  // Native ctx.agent.kind, with the older session-file fallback, is shown for provenance inspection.
  subagent: (ctx: any) => boolean;
};

const HELP = [
  'Usage:',
  '  /huimem init         enable memory in this project: create missing starter files, never overwrite',
  '  /huimem off          switch memory off in this project: no block, no capture, no commits',
  '  /huimem on           switch it back on',
  '  /huimem pause        block commits in this project for this OMP process',
  '  /huimem resume       allow commits again',
  '  /huimem personal on|off   explicitly allow or disable profile-owned personal memory (not project settings)',
  '  /huimem learn        review one source packet and curate useful Wiki knowledge in one ordinary main-agent turn',
  '  /huimem learn status inspect the review backlog without a model turn',
  '  /huimem              memory state for this project',
  '  /huimem recall <N>   recall budget in characters (' + LIMITS.recallBudget.min + '–' + LIMITS.recallBudget.max + ')',
  '  /huimem limit <N>    injected context limit in characters (' + LIMITS.injectionLimit.min + '–' + LIMITS.injectionLimit.max + ')',
  '  /huimem arch         architecture rules and the check result',
  '  /huimem omp          OMP settings that affect memory',
  '  /huimem require <id>    deliver this record every turn, even when unrelated to the question (max ' + REQUIRED_MAX + ')',
  '  /huimem unrequire <id>  stop delivering it unconditionally',
  '  /huimem include <path>  count a .memory document as canonical: listed in the block, hashed, tracked for staleness (max ' + DOCUMENTS_MAX + ')',
  '  /huimem exclude <path>  stop counting it',
  '  /huimem reset        restore the default limits',
  '  /huimem sync         retry publishing .memory/RECORDS.md from saved records',
  '  /huimem index [rebuild]   inspect or rebuild only the derived local search index',
  '  /huimem context      inspect the latest memory block prepared for OMP',
  '  /huimem doctor       diagnose memory, sources and task-file drift without repairs',
  '  /huimem adr-audit    propose moving legacy ADRs into the basis contract (dry run)',
  '  /huimem adr-audit apply   write that migration; originals are backed up',
].join('\n');

// Показываем, но не трогаем: это чужой конфиг, его меняет сам OMP.
const OMP_KEYS: [string, string][] = [
  ['plan.defaultOnStartup', 'false: plan mode entered at startup, before plugins load, hides project_memory after plan approval'],
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
    if (verb==='personal') {
      if (value!=='on' && value!=='off')
        return say(`Personal memory is ${await deps.personalEnabled() ? 'ON' : 'OFF'} in this OMP profile. Usage: /huimem personal on|off. Only this human command changes permission.`);
      try {
        await deps.setPersonalEnabled(value==='on');
        return say(value==='on'
          ? 'Personal memory ON in this OMP profile. Use scope=personal explicitly to save; only selected original evidence is copied. Relevant personal records may use a small labelled share of context.'
          : 'Personal memory OFF in this OMP profile. No personal capture, reads, commits or injection; existing saved data is preserved.');
      } catch (error) {return say(String(error));}
    }
    if (verb==='learn') {
      try {
        if(value==='status') {
          if(!deps.deployed(ctx)) return say(deps.notEnabled);
          if(!deps.switchedOn(ctx)) return say('PROJECT_MEMORY_OFF: use /huimem on before inspecting learning.');
          return say(JSON.stringify(learningStatus(deps.store(ctx)),null,2));
        }
        if(value) return say('Usage: /huimem learn [status]');
        await deps.learn(ctx);
      } catch(error) {return say(String(error));}
      return;
    }
    if ((verb==='pause' || verb==='resume') && !deps.deployed(ctx) && await deps.personalEnabled()) {
      deps.setPaused(ctx,verb==='pause');
      return say(verb==='pause' ? 'Scoped commits PAUSED for this working directory in this OMP process; reads remain available.'
        : 'Scoped commits enabled for this working directory.');
    }
    if (verb === 'doctor') return say(formatDoctor(diagnoseMemory(ctx.cwd)));

    // Выключатель проекта. Он сильнее паузы: блок памяти не собирается, эпизоды не пишутся,
    // инструмент отвечает отказом. Состояние лежит в .memory/settings.json и переживает перезапуск.
    if (verb === 'off' || verb === 'on') {
      if (!deps.deployed(ctx)) return say(deps.notEnabled);
      const want = verb === 'on';
      if (deps.switchedOn(ctx) === want) return say(`Memory is already ${want ? 'on' : 'off'} in this project.`);
      deps.setEnabled(ctx, want);
      return say(want
        ? `Memory is ON from the next message: the block is injected again, messages are recorded and project_memory works. File: ${SETTINGS_PATH}`
        : `Memory is OFF from the next message: no memory block, no recorded messages, no commits. Saved records and files stay untouched; /huimem on restores it. File: ${SETTINGS_PATH}`);
    }

    // Память включается явной командой в выбранном проекте, а не сама в каждом каталоге:
    // иначе база со стенограммой появлялась бы в чужих репозиториях (замерено 2026-09-08).
    if (verb === 'init') {
      const wasEnabled = deps.deployed(ctx);
      let r;
      try { r = initProject(ctx.cwd); } catch (e) { return say('Init failed: ' + String(e)); }
      const merge = r.differs.filter(p => ['AGENTS.md', '.omp/config.yml', '.omp/RULES.md'].includes(p));
      // ЗАМЕРЕНО 2026-10-19 на тестовом проекте с моделью ai1: стартовый набор СОЗДАЁТ
      // .memory/DESIGN.md, но канонический набор его не содержит, и блок при этом называет свой
      // перечень полным. Та же нестыковка в живом HUICAD потребовала ручного /huimem include.
      // Регистрируем только файл, созданный этим init: в проекте с записями добавление набора
      // один раз помечает их STALE, и решать это пользователю, а не команде.
      const design = '.memory/DESIGN.md';
      let registered = '';
      if (r.created.includes(design)) {
        const current = readSettings(ctx.cwd);
        if (!current.documents.includes(design)) {
          writeSettings(ctx.cwd, { documents: [...current.documents, design] });
          registered = `Canonical set: added ${design}, the design document this init created, so the block lists it.`;
        }
      }
      return say([
        wasEnabled ? `Project memory was already enabled in ${r.root}; only missing files were added.`
          : `Project memory ENABLED in ${r.root}. It works from your next message; no restart needed.`,
        r.created.length ? 'Created:\n  ' + r.created.join('\n  ') : 'Created: nothing, every starter file already exists.',
        r.differs.length ? 'Existing files kept as they are (not overwritten):\n  ' + r.differs.join('\n  ') : '',
        merge.length ? 'These may lack the memory rules shipped in the plugin starter/: ' + merge.join(', ') + '. Merge them by hand if you want those rules.' : '',
        r.gitignoreAdded.length ? '.gitignore: added ' + r.gitignoreAdded.join(', ') + ' so the local transcript database stays out of git.' : '.gitignore already excludes the memory database.',
        registered,
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
    if (verb==='index') {
      if (!deps.switchedOn(ctx)) return say('PROJECT_MEMORY_OFF: use /huimem on before reading the index.');
      if (value && value!=='rebuild') return say('Usage: /huimem index [rebuild]');
      if (value==='rebuild' && deps.commitsPaused(ctx)) return say('COMMITS_PAUSED: use /huimem resume before rebuilding derived data.');
      try {
        const store=deps.store(ctx);
        return say(JSON.stringify(value==='rebuild' ? store.rebuildIndex() : store.searchStatus(),null,2));
      } catch(error) {return say(String(error));}
    }
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
        // События переживают веер подагентов, журнал вставок — нет: четыре исследователя
        // стирали его за шесть минут (audit/huicad-after-0.6.6), и проверить однократные
        // уведомления было нечем.
        const events=store.events(20) as any[];
        return say((receipt ? 'Last prepared memory block (not proof the model used it):\n'+JSON.stringify(receipt,null,2)
          : 'No memory block has been prepared for this project yet.')+
          '\nLatest retrieval (may be a different run; JS character counts, not tokens):\n'+JSON.stringify(retrieval,null,2)+
          '\nRecent memory events (newest first):\n'+(events.length
            ? events.map(e=>`  ${e.time.slice(0,19).replace('T',' ')}  ${e.kind}${e.detail ? ' — '+e.detail : ''}`).join('\n')
            : '  none recorded yet'));
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

    // Канонический набор задаёт пользователь, а не модель: файл настроек закрыт от её
    // файловых инструментов. ЗАМЕРЕНО 2026-10-17 в HUICAD: .memory/DESIGN.md на 17 КБ был
    // живым документом памяти — 9 чтений, источник сохранённой записи, — но в наборе его не
    // было, и блок утверждал, что кроме своего списка ничего памятью не является.
    if (verb === 'include' || verb === 'exclude') {
      const listed = cfg.documents.length ? cfg.documents.join(', ') : 'none';
      if (!value) return say(`Canonical documents added in this project: ${listed}.\nUsage: /huimem ${verb} <path inside .memory>`);
      if (verb === 'exclude') {
        if (!cfg.documents.includes(value)) return say(`${value} is not in the added set. Added: ${listed}.`);
        const saved = writeSettings(ctx.cwd, { documents: cfg.documents.filter(p => p !== value) });
        return say(`${value} is no longer canonical: it is not listed in the block and no longer tracked for staleness.\n`
          + `Added: ${saved.documents.join(', ') || 'none'}. File-sourced records without dependsOn will show STALE once, because the canonical set changed; records quoting a message are untouched.`);
      }
      if (cfg.documents.includes(value)) return say(`${value} is already canonical.`);
      if (!documentPath(value)) return say(
        `Not an addable path: ${value}\nUse a path inside .memory, for example .memory/DESIGN.md. `
        + 'MEMORY.md, PROJECT.md, todo.json, architecture.json and .memory/adr/** are always canonical; '
        + 'RECORDS.md and wiki/ are derived; settings.json and runtime/ are not documents.');
      if (cfg.documents.length >= DOCUMENTS_MAX) return say(`At most ${DOCUMENTS_MAX} added documents. Remove one with /huimem exclude <path> first.`);
      if (!existsSync(resolve(ctx.cwd, value))) return say(`No such file: ${value}. Create the document first; the set names real files.`);
      const saved = writeSettings(ctx.cwd, { documents: [...cfg.documents, value] });
      return say(`${value} is canonical from the next message: listed in the memory block, hashed with the set and tracked for staleness.\n`
        + `Added: ${saved.documents.join(', ')}. File: ${SETTINGS_PATH}\n`
        + 'File-sourced records without dependsOn will show STALE once: the canonical set changed, which is exactly what STALE reports. '
        + 'Recheck them or save corrected versions; nothing is deleted. A record quoting a message is not touched: its source cannot change with a document.');
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
    const on = deps.switchedOn(ctx);
    let counts = 'unavailable', projection='unavailable', learning='not read while memory is off';
    // Версия сборки видна всегда, даже при выключенной памяти: именно её сверяют после
    // `omp plugin upgrade`, когда непонятно, подхватил ли открытый чат новый плагин.
    let build = PLUGIN_VERSION;
    // Выключенная память не открывает базу: иначе /huimem сам создал бы её в выключенном проекте.
    if (!on) { counts = 'not read while memory is off'; projection = 'not read while memory is off'; }
    else try {
      const s = deps.store(ctx);
      const st = s.status();
      const {projection: view,...metrics}=st;
      counts = Object.entries(metrics).map(([k, v]) => `${k}=${v}`).join(' · ');
      projection = view.state + (view.error ? ' — '+view.error : '');
      const writer = s.writerVersion();
      const pending = s.pendingUpgrade();
      if (writer && writer !== PLUGIN_VERSION) build += ` · database last written by ${writer}`;
      if (pending) build += ` · upgrade summary from ${pending.from} is delivered to the model on the next message`;
      else if (writer === PLUGIN_VERSION) build += ' · database stamped by this version';
      try {
        const progress=learningStatus(s);
        learning=`${progress.pendingSources} pending source(s) · ${progress.reviewedBatches} reviewed packet(s); no background model`;
      } catch(error) {learning='ERROR: '+String(error);}
    } catch (e) { counts = 'ERROR: ' + String(e); }
    const a = on ? deps.architecture(ctx) : { configured: false, ok: false, failures: [] };
    const err = deps.health();
    const hidden = on && deps.toolHidden();
    return say(
      [
        'huimem project memory',
        `Plugin:             ${build}`,
        `Effort:             ${deps.thinkingLevel() ?? 'not reported by this OMP build'}`,
        `Memory:             ${on ? 'ON' : 'OFF (/huimem on to switch it back)'}`,
        ...(hidden ? ['Model tool:         WARNING: the project_memory tool is not available in this session. Open a new OMP window; '
          + 'set plan.defaultOnStartup: false in .omp/config.yml if it disappears after plan approval (/huimem omp).'] : []),
        `Commits:            ${deps.commitsPaused(ctx) ? 'PAUSED (this process)' : 'enabled'}`,
        `Personal memory:    ${await deps.personalEnabled() ? 'ON (this OMP profile)' : 'OFF (/huimem personal on to opt in)'}`,
        'Requires OMP + a main model. No mnemopi, memory server or additional model required.',
        `Storage:            ${counts}`,
        `Readable registry:  ${projection}`,
        `Learning:           ${learning}`,
        `Architecture:       ${a.configured ? (a.ok ? 'configured, no violation' : 'VIOLATIONS: ' + a.failures.join('; ')) : 'not configured (optional)'}`,
        `Recall budget:      ${cfg.recallBudget} characters`,
        `Injection limit:    ${cfg.injectionLimit} characters`,
        `Required records:   ${cfg.required.length ? cfg.required.join(', ') : 'none'}`,
        `Added documents:    ${cfg.documents.length ? cfg.documents.join(', ') : 'none (the plugin set only)'}`,
        `Subagent block:     ${cfg.subagentBlock}${deps.subagent(ctx) ? ' (this session is a subagent)' : ''}`,
        `Settings file:      ${settingsFileExists ? SETTINGS_PATH : 'none, defaults apply'}`,
        err ? `Health:             ${err}` : 'Health:             no errors',
        '',
        'Defaults work without changes. All commands: /huimem help',
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
        const personal=await deps.personalEnabled();
        const personalLabel=`Personal memory: ${personal ? 'ON' : 'OFF'}`;
        const pick = await ui.select(`huimem · ${ctx.cwd} · memory is OFF here`, [
          { label: enable, description: 'Creates missing starter files (.memory, .omp, AGENTS.md, .gitignore lines). Existing files are never overwritten.' },
          {label:personalLabel,description:'Explicit profile-owned opt-in; works without creating project memory. Enter toggles permission.'},
          { label: 'Close', description: 'Memory stays off; nothing is created.' },
        ]);
        if (pick===personalLabel) {await run('personal',personal ? 'off' : 'on',ctx,note);continue;}
        if (pick !== enable) return;
        await run('init', undefined, ctx);
        continue;
      }
      const cfg = readSettings(ctx.cwd);
      let records = '?', view = 'unavailable';
      // Пока память выключена, экран её не открывает: база не создаётся и не читается.
      if (!cfg.enabled) { records = 'off'; view = 'off'; }
      else try { const st = deps.store(ctx).status(); records = String(st.records); view = st.projection.state; }
      catch (e) { view = 'ERROR: ' + String(e); }
      const health = deps.health();
      const hidden = cfg.enabled && deps.toolHidden();
      // Главный экран — повседневное: включить, проверить, курировать. Всё остальное работает
      // со значениями по умолчанию и лежит в подменю, ничего не удалено.
      const items: MenuItem[] = [
        [`Memory: ${cfg.enabled ? 'ON' : 'OFF'}`,
          'Enter switches project memory off or on. Off means no memory block, no recorded messages and no commits; saved records stay.',
          async () => { await run(cfg.enabled ? 'off' : 'on', undefined, ctx, note); }],
        ['Check memory', hidden ? 'WARNING: project_memory is not available in this session. Shows the cause and the fix.'
          : 'Inspect sources, required records and task drift; no repairs.',
          async () => { await run(hidden ? 'omp' : 'doctor', undefined, ctx); return true; }],
        ['Curate Wiki from sources', 'Starts one intentional main-agent turn; summaries never become evidence.',
          async () => {await run('learn',undefined,ctx);return true;}],
        ['Advanced settings', 'Limits, required records, commits pause, personal memory, architecture rules, ADR migration.',
          async () => advancedScreen(ctx)],
        ['Diagnostics', 'Search index, readable registry, last memory block, OMP settings that affect memory.',
          async () => diagnosticsScreen(ctx, view)],
        ['Close', 'Esc also closes.', async () => true],
      ];
      const title = `huimem · ${ctx.cwd} · ${cfg.enabled ? records + ' records' : 'memory OFF'}`
        + (hidden ? ' · project_memory unavailable' : '') + (health ? ' · ' + health : '');
      const index = await pickItem(ctx, title, items, cursor);
      if (index < 0) return;
      cursor = index;
      if (await items[index][2]()) return;
    }
  }

  type MenuItem = [string, string, () => Promise<boolean | void>];
  async function pickItem(ctx: any, title: string, items: MenuItem[], cursor: number): Promise<number> {
    const pick = await ctx.ui.select(title, items.map(([label, description]) => ({ label, description })), { initialIndex: cursor });
    return items.findIndex(([label]) => label === pick);
  }
  // Подменю: Back или Esc возвращают на главный экран; длинный отчёт закрывает весь экран,
  // чтобы его можно было прочитать. Курсор остаётся на последнем пункте.
  async function subScreen(ctx: any, title: string, build: () => Promise<MenuItem[]>): Promise<boolean> {
    let cursor = 0;
    for (;;) {
      const items = [...await build(), ['Back', 'Return to the main screen.', async () => false] as MenuItem];
      const index = await pickItem(ctx, title, items, cursor);
      if (index < 0 || items[index][0] === 'Back') return false;
      cursor = index;
      if (await items[index][2]()) return true;
    }
  }
  function advancedScreen(ctx: any) {
    const note = (text: string) => ctx.ui.notify(text, 'info');
    return subScreen(ctx, 'Advanced settings · defaults work without changes', async () => {
      const cfg = readSettings(ctx.cwd);
      const a = cfg.enabled ? deps.architecture(ctx) : { configured: false, ok: false, failures: [] };
      const paused = deps.commitsPaused(ctx);
      const personal = await deps.personalEnabled();
      return [
        [`Recall budget: ${cfg.recallBudget}`, `Characters of registry records per turn, ${LIMITS.recallBudget.min}–${LIMITS.recallBudget.max}.`,
          async () => editNumber(ctx, 'recall', 'Recall budget', cfg.recallBudget, LIMITS.recallBudget)],
        [`Injection limit: ${cfg.injectionLimit}`, `Characters of the whole memory block, ${LIMITS.injectionLimit.min}–${LIMITS.injectionLimit.max}.`,
          async () => editNumber(ctx, 'limit', 'Injection limit', cfg.injectionLimit, LIMITS.injectionLimit)],
        [`Commits: ${paused ? 'PAUSED' : 'enabled'}`, 'Enter toggles. Pause blocks project_memory commit in this OMP process; a restart clears it.',
          async () => { await run(paused ? 'resume' : 'pause', undefined, ctx, note); }],
        [`Required records: ${cfg.required.length ? cfg.required.join(', ') : 'none'}`, 'Records delivered every turn, even when unrelated to the question.',
          async () => requiredScreen(ctx)],
        [`Personal memory: ${personal ? 'ON' : 'OFF'}`, 'Explicit profile-owned permission. Only selected evidence is copied when saving with scope=personal.',
          async () => {await run('personal',personal ? 'off' : 'on',ctx,note);}],
        [`Architecture: ${a.configured ? (a.ok ? 'no violation' : 'VIOLATIONS') : 'not configured (optional)'}`, 'Show the rules and the check result.',
          async () => { await run('arch', undefined, ctx); return true; }],
        ['Legacy ADR migration', 'Shows the plan first and asks before writing anything.',
          async () => adrMigration(ctx)],
        ['Reset limits', `Recall ${LIMITS.recallBudget.default}, injection ${LIMITS.injectionLimit.default}. Required records stay.`,
          async () => { if (await ctx.ui.confirm('Reset limits?', `Recall budget ${LIMITS.recallBudget.default}, injection limit ${LIMITS.injectionLimit.default}. Required records are kept.`)) await run('reset', undefined, ctx, note); }],
      ];
    });
  }
  function diagnosticsScreen(ctx: any, view: string) {
    const note = (text: string) => ctx.ui.notify(text, 'info');
    return subScreen(ctx, 'Diagnostics · read-only unless stated', async () => [
      ['Search index status', 'Inspect the rebuildable local sidecar; /huimem index rebuild explicitly rebuilds it.',
        async () => {await run('index',undefined,ctx);return true;}],
      [`Readable registry: ${view}`, 'Republish .memory/RECORDS.md from saved records.',
        async () => { await run('sync', undefined, ctx, note); }],
      ['Last memory block', 'Diagnostics of the block prepared for the model; not proof it was used.',
        async () => { await run('context', undefined, ctx); return true; }],
      ['OMP settings that affect memory', 'Shown only; the plugin does not change OMP config.',
        async () => { await run('omp', undefined, ctx); return true; }],
    ]);
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
