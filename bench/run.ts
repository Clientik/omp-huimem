// Парное сравнение памяти на исполняемых задачах (bench/tasks.ts) в настоящем OMP.
//   bun bench/run.ts [--conditions=off,v0.9.0,current] [--repeats=2] [--concurrency=3]
//                    [--model=ai1/qwen38-flash-next] [--tasks=id,id] [--timeout=600] [--keep]
// off — без расширения; vX.Y.Z — dist/index.js из git-тега; current — dist/index.js рабочей копии
// (сначала bun run build). Каждый прогон — новый временный проект, отдельный каталог сессий,
// встроенная память OMP выключена, skills/rules/расширения профиля не загружаются, куратор выключен.
// Шаги и токены берутся из журнала сессии OMP; итог задачи проверяет код. Результаты —
// bench/results/<время>.jsonl и .md (не коммитятся).
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MemoryStore } from '../src/memory/core';
import { TASKS, type Memory, type Task, type Verdict } from './tasks';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [key, value = 'true'] = a.replace(/^--/, '').split('=');
  return [key, value];
}));
const repo = resolve(import.meta.dir, '..');
const model = args.model ?? 'ai1/qwen38-flash-next';
const repeats = Number(args.repeats ?? 2), concurrency = Number(args.concurrency ?? 3);
const timeoutMs = Number(args.timeout ?? 600) * 1000;
const conditions = (args.conditions ?? 'off,v0.9.0,current').split(',');
const tasks = args.tasks ? TASKS.filter(t => args.tasks.split(',').includes(t.id)) : TASKS;
if (!tasks.length) throw new Error('no tasks selected');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const results = join(repo, 'bench/results');
mkdirSync(results, { recursive: true });
const out = join(results, `${stamp}.jsonl`);
const work = mkdtempSync(join(tmpdir(), 'huimem-bench-'));

const currentVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version as string;
const bundles = new Map(conditions.map(condition => {
  if (condition === 'off') return [condition, null] as const;
  if (condition === 'current') return [condition, { path: join(repo, 'dist/index.js'), version: currentVersion }] as const;
  const shown = Bun.spawnSync(['git', 'show', `${condition}:dist/index.js`], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
  if (shown.exitCode !== 0) throw new Error(`git show ${condition}:dist/index.js: ${shown.stderr}`);
  const path = join(work, `${condition}.js`);
  writeFileSync(path, shown.stdout);
  return [condition, { path, version: condition.replace(/^v/, '') }] as const;
}));

function write(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}
function prepare(task: Task, condition: string, dir: string) {
  write(dir, task.files);
  write(dir, { '.omp/config.yml': "memory:\n  backend: 'off'\nplan:\n  defaultOnStartup: false\n" });
  const bundle = bundles.get(condition);
  if (bundle) {
    write(dir, { '.memory/MEMORY.md': '# Memory\n', '.memory/settings.json': JSON.stringify({ curator: 'off' }) });
    const s = new MemoryStore(dir);
    try {
      const history = 'bench-history';
      const memory: Memory = {
        rec: (id, kind, status, text, extra = {}) => ({ id, kind, status, text, expectedVersion: 0,
          source: { episode: s.capture(history, 'user', text), quote: text }, ...(kind === 'decision' ? { rationale: text } : {}), ...extra }),
        file: (id, kind, status, text, path, quote) => ({ id, kind, status, text, expectedVersion: 0, source: s.fileSource(path, quote) }),
        // Без чекпоинта: иначе блок показал бы сводку «прошлой сессии», а журнал работы скрылся бы.
        save: changes => { for (let i = 0; i < changes.length; i += 30) s.commit(history, changes.slice(i, i + 30), 'history', { checkpoint: false }); },
        work: entry => s.recordWork('bench-previous-run', entry),
      };
      task.seed?.(memory);
      // База помечена версией условия: иначе блок открылся бы сводкой обновления, которой нет в работе.
      s.db.query("INSERT OR REPLACE INTO meta VALUES ('plugin',?)").run(bundle.version);
    } finally { s.close(); }
  }
  if (task.after) write(dir, task.after);
}
function sessionUsage(dir: string) {
  const usage = { requests: 0, toolCalls: 0, memoryCalls: 0, tokens: 0, freshTokens: 0 };
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    if (!name.endsWith('.jsonl')) continue;
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line.startsWith('{')) continue;
      const entry = JSON.parse(line);
      const message = entry.type === 'message' ? entry.message : null;
      if (message?.role !== 'assistant') continue;
      usage.requests++;
      const calls = (message.content ?? []).filter((p: { type?: string }) => p?.type === 'toolCall');
      usage.toolCalls += calls.length;
      usage.memoryCalls += calls.filter((p: { name?: string }) => p.name === 'project_memory').length;
      usage.tokens += message.usage?.totalTokens ?? 0;
      usage.freshTokens += (message.usage?.input ?? 0) + (message.usage?.output ?? 0);
    }
  }
  return usage;
}
const normalize = (s: string) => s.replace(/\r\n/g, '\n');
type BenchRow = { task: string; condition: string; repeat: number; pass: boolean; detail: string; exitCode: number; timedOut: boolean; wallMs: number;
  requests: number; toolCalls: number; memoryCalls: number; tokens: number; freshTokens: number; answer: string; stderr?: string };
async function run(task: Task, condition: string, repeat: number): Promise<BenchRow> {
  const root = mkdtempSync(join(work, `${task.id}-${condition}-`));
  const dir = join(root, 'project'), sessions = join(root, 'sessions');
  mkdirSync(dir); mkdirSync(sessions);
  prepare(task, condition, dir);
  const bundle = bundles.get(condition);
  const cmd = ['omp', '--no-extensions', ...(bundle ? ['-e', bundle.path] : []), '--no-skills', '--no-rules', '--no-title',
    '--model', model, '--thinking', 'off', '--session-dir', sessions, '-p', task.prompt];
  const started = performance.now();
  const proc = Bun.spawn(cmd, { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
  const [answer, errors] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const wallMs = Math.round(performance.now() - started);
  let verdict: Verdict;
  try { verdict = task.verify(dir, answer); } catch (e) { verdict = { pass: false, detail: 'verify error: ' + String(e) }; }
  const touched = (task.protect ?? []).filter(path => normalize(readFileSync(join(dir, path), 'utf8')) !== normalize(task.files[path]));
  if (touched.length) verdict = { pass: false, detail: `protected files changed: ${touched.join(', ')}; ` + verdict.detail };
  const row: BenchRow = { task: task.id, condition, repeat, pass: verdict.pass, detail: verdict.detail, exitCode, timedOut, wallMs,
    ...sessionUsage(sessions), answer: answer.trim().slice(-400), stderr: exitCode ? errors.trim().slice(-300) : undefined };
  appendFileSync(out, JSON.stringify(row) + '\n');
  console.log(`${row.pass ? 'PASS' : 'FAIL'} ${task.id} ${condition} #${repeat} ${(wallMs / 1000).toFixed(0)}s ${row.requests} req — ${verdict.detail}`);
  if (!('keep' in args)) try { rmSync(root, { recursive: true, force: true }); } catch { /* sqlite may still be closing */ }
  return row;
}

const queue = tasks.flatMap(task => conditions.flatMap(condition => Array.from({ length: repeats }, (_, i) => ({ task, condition, repeat: i + 1 }))));
const rows: BenchRow[] = [];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  for (let item = queue.shift(); item; item = queue.shift()) rows.push(await run(item.task, item.condition, item.repeat));
}));

const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const cell = (list: typeof rows) => `${list.filter(r => r.pass).length}/${list.length}`;
const lines = [
  `# Memory bench ${stamp}`, '', `Model \`${model}\`, repeats ${repeats}, conditions ${conditions.join(', ')}.`, '',
  `| Task | ${conditions.map(c => `${c} pass`).join(' | ')} | ${conditions.map(c => `${c} requests`).join(' | ')} | ${conditions.map(c => `${c} ktok`).join(' | ')} |`,
  `|---|${conditions.map(() => '---:').join('|')}|${conditions.map(() => '---:').join('|')}|${conditions.map(() => '---:').join('|')}|`,
  ...tasks.map(task => {
    const by = (c: string) => rows.filter(r => r.task === task.id && r.condition === c);
    return `| ${task.id}${task.tuned ? ' *' : ''} | ${conditions.map(c => cell(by(c))).join(' | ')} | ${conditions.map(c => mean(by(c).map(r => r.requests)).toFixed(1)).join(' | ')} | ${conditions.map(c => (mean(by(c).map(r => r.tokens)) / 1000).toFixed(0)).join(' | ')} |`;
  }),
  `| **all** | ${conditions.map(c => cell(rows.filter(r => r.condition === c))).join(' | ')} | ${conditions.map(c => mean(rows.filter(r => r.condition === c).map(r => r.requests)).toFixed(1)).join(' | ')} | ${conditions.map(c => (mean(rows.filter(r => r.condition === c).map(r => r.tokens)) / 1000).toFixed(0)).join(' | ')} |`,
  '', '\\* task built around a specific change of the release; ktok — mean tokens processed per run (cached included).',
];
writeFileSync(join(results, `${stamp}.md`), lines.join('\n') + '\n');
console.log('\n' + lines.join('\n'));
if (!('keep' in args)) try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
