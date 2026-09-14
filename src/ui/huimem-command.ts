import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LIMITS, readSettings, writeSettings, SETTINGS_PATH } from '../memory/settings';
import { apply, audit } from '../memory/adr-audit';

// Форма диалогов ctx.ui (select/confirm/input) из документации и бинарника OMP не
// извлекается: доки перечисляют имена методов без сигнатур, бинарник минифицирован.
// Замерена только арность — select/confirm/input по 3 аргумента, editor 4. Поэтому
// здесь подкоманды, а не угаданный вызов диалога: так команда работает во всех режимах
// (интерактивный, -p, RPC, ACP) и проверяется прогоном, а не надеждой.
// Родной /memory у OMP устроен так же: view/stats/diagnose/sync/clear.

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
  '  /huimem pause        block commits in this project for this OMP process',
  '  /huimem resume       allow commits again',
  '  /huimem              memory state for this project',
  '  /huimem recall <N>   recall budget in characters (' + LIMITS.recallBudget.min + '–' + LIMITS.recallBudget.max + ')',
  '  /huimem limit <N>    injected context limit in characters (' + LIMITS.injectionLimit.min + '–' + LIMITS.injectionLimit.max + ')',
  '  /huimem arch         architecture rules and the check result',
  '  /huimem omp          OMP settings that affect memory',
  '  /huimem reset        restore the default limits',
  '  /huimem sync         retry publishing .memory/RECORDS.md from saved records',
  '  /huimem context      inspect the latest memory block prepared for OMP',
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
  const say = (text: string) =>
    pi.sendMessage({ customType: 'huimem-settings', content: text, display: true });

  pi.registerCommand('huimem', {
    description: 'huimem project memory: state and settings',
    handler: async (args: any, ctx: any) => {
      const argv = String(args ?? '').trim().split(/\s+/).filter(Boolean);
      const [verb, value] = argv;

      if (verb === 'help' || verb === '--help') return say(HELP);

      if (!deps.deployed(ctx)) {
        return say(
          'Project memory is OFF here.\n' + deps.notEnabled +
          '\nRequires OMP and a configured main model. mnemopi is NOT required; huimem uses its own local SQLite.' +
          '\n\nOnce deployed it turns on with your next message; no restart needed.',
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
          const stale = 'Decisions from conversation track the hash of canonical documents, so records linked to rewritten ADRs will show STALE afterwards. Their user quotes are unchanged.';
          const describe = (i: any) =>
            i.state === 'has-basis' ? `  OK       ${i.path} — already has a basis section`
            : i.state === 'no-match' ? `  SKIP     ${i.path} — no accepted user decision names this document; nothing proposed`
            : i.state === 'ambiguous' ? `  SKIP     ${i.path} — several decisions name it (${i.candidates.join(', ')}); nothing chosen`
            : `  MIGRATE  ${i.path}  <-  ${i.recordId} v${i.version}\n           basis: ${i.quote.split('\n')[0].slice(0, 160)}\n           all original lines move under "Interpretation [?]"; nothing is deleted`;
          if (value === 'apply') {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const { written, skipped } = apply(ctx.cwd, store.latestRecords(), date, stamp);
            return say([
              `ADR migration applied: ${written.length} written, ${skipped.length} skipped.`,
              ...written.map(w => `  WROTE    ${w.path}  <-  ${w.recordId}\n           original: ${w.backup}`),
              ...skipped.map(describe),
              '', written.length ? stale : 'Nothing needed migration.',
            ].join('\n'));
          }
          const items = audit(ctx.cwd, store.latestRecords(), date);
          const pending = items.filter(i => i.state === 'migratable').length;
          return say([
            `ADR audit (dry run, nothing written): ${items.length} document(s), ${pending} can be migrated.`,
            ...items.map(describe), '',
            'A basis is taken only from an accepted decision whose rationale is verified by code as an exact excerpt of the user quote.',
            'No document is declared false. Unmatched or ambiguous documents are never guessed.',
            pending ? `Run /huimem adr-audit apply to write. Originals go to .memory/adr-backup/. ${stale}` : '',
          ].join('\n'));
        } catch (e) { return say('ADR audit failed: ' + String(e)); }
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
          `Settings file:      ${settingsFileExists ? SETTINGS_PATH : 'none, defaults apply'}`,
          err ? `Health:             ${err}` : 'Health:             no errors',
          '',
          HELP,
        ].join('\n'),
      );
    },
  });
}
