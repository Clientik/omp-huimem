// Задачи парного сравнения: одна и та же модель, проект и запрос — без памяти, прежняя сборка,
// текущая сборка. Нужное знание задачи лежит только в «прошлых сессиях» (записи и журнал работы),
// а не в файлах проекта: иначе память не нужна. Итог проверяет код — тесты, файлы, слово в
// ответе, — а не модель-судья. Идея протокола — VibeMemBench (arXiv 2609.23570): сравнивать
// исполнение задачи при одинаковых условиях, отдельно считая и помощь, и вред памяти.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Change, WorkTodo } from '../src/memory/core';

export type Verdict = { pass: boolean; detail: string };
export type Memory = {
  // Запись с цитатой из «прошлого» сообщения пользователя: текст записи и есть его слова.
  rec(id: string, kind: string, status: string, text: string, extra?: Partial<Change>): Change;
  // Запись с источником-файлом проекта в его текущем содержимом.
  file(id: string, kind: string, status: string, text: string, path: string, quote: string): Change;
  save(changes: Change[]): void;
  // Журнал работы прошлого запуска, как его пишет расширение из вызовов инструментов.
  work(entry: { todo?: WorkTodo; file?: string; command?: { text: string; exitCode: number }; check?: string }): void;
};
export type Task = {
  id: string;
  // Что именно проверяет задача; tuned — задача построена под конкретное изменение выпуска.
  measures: string;
  tuned?: string;
  files: Record<string, string>;
  // Файлы, которые агент не должен менять: правка теста ради зелёного прогона — не решение.
  protect?: string[];
  seed?: (m: Memory) => void;
  // Изменения проекта после «прошлых сессий» и до запуска; применяются во всех условиях.
  after?: Record<string, string>;
  prompt: string;
  verify: (dir: string, answer: string) => Verdict;
};

const read = (dir: string, path: string) => existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : '';
function bunTest(dir: string): Verdict {
  const r = Bun.spawnSync(['bun', 'test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  return { pass: r.exitCode === 0, detail: `bun test exit ${r.exitCode}` };
}
function both(...verdicts: Verdict[]): Verdict {
  return { pass: verdicts.every(v => v.pass), detail: verdicts.map(v => v.detail).join('; ') };
}
const UNRELATED = [
  'Логотип рисуем в фирменном синем цвете #1E5AA8.',
  'Отчёты по продажам отправляем бухгалтерии по пятницам.',
  'Ревью кода делает дежурный по неделе.',
  'Шрифт интерфейса — Inter, размер основного текста 15px.',
  'Тестовый стенд обновляется каждую ночь в 03:00.',
  'Документацию для клиентов пишем на английском.',
  'Иконки берём из набора Lucide.',
  'Секреты храним в Vault, не в переменных окружения CI.',
  'Мобильное приложение пока не делаем.',
  'Письма пользователям отправляет сервис Postmark.',
  'Таймаут HTTP-клиента по умолчанию — 10 секунд.',
  'Ветки называем feature/<номер задачи>.',
];
const unrelated = (m: Memory, count: number, prefix: string) => Array.from({ length: count }, (_, i) =>
  m.rec(`${prefix}-${i}`, i % 3 === 0 ? 'decision' : 'fact', i % 3 === 0 ? 'accepted' : 'active',
    UNRELATED[i % UNRELATED.length] + (i >= UNRELATED.length ? ` Уточнение ${i}.` : '')));

export const TASKS: Task[] = [
  {
    id: 'stale-basis-format',
    measures: 'устаревшее решение и его изменившееся основание',
    tuned: '0.9.1: STALE-совпадение приводит новое основание',
    files: {
      'src/export.ts': 'export type Row = { name: string; total: number };\n\n// Выгрузка отчёта для клиента.\nexport function exportReport(rows: Row[]): string {\n  throw new Error(\'not implemented\');\n}\n',
    },
    seed: m => {
      m.save([m.rec('customer-format', 'fact', 'active', 'Клиент требует выгрузку отчётов в CSV.'), ...unrelated(m, 6, 'misc')]);
      m.save([m.rec('report-export', 'decision', 'accepted', 'Экспорт отчёта делаем в CSV, потому что так требует клиент.', { dependsOn: [{ id: 'customer-format' }] })]);
      m.save([m.rec('customer-format', 'fact', 'active', 'Клиент перешёл на JSON, CSV больше не принимает.', { expectedVersion: 1 })]);
    },
    prompt: 'Реализуй экспорт отчёта в src/export.ts (функция exportReport).',
    verify: dir => {
      const r = Bun.spawnSync(['bun', '-e', "import {exportReport} from './src/export.ts'; process.stdout.write(String(exportReport([{name:'alpha',total:1}])))"],
        { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      const out = r.stdout.toString();
      try { JSON.parse(out); return { pass: out.includes('alpha'), detail: 'JSON: ' + out.slice(0, 60) }; }
      catch { return { pass: false, detail: 'not JSON: ' + (out || r.stderr.toString()).slice(0, 60) }; }
    },
  },
  {
    id: 'intention-changelog',
    measures: 'отложенное правило «когда меняешь файл»',
    tuned: '0.9.1: задача с when.paths напоминает при чтении файла',
    files: {
      'src/price.ts': 'export function total(net: number, vatPercent: number) {\n  return net + (net * vatPercent) / 100;\n}\n',
      'price.test.ts': "import { expect, test } from 'bun:test';\nimport { total } from './src/price';\ntest('vat', () => expect(total(100, 20)).toBe(120));\n",
      'CHANGELOG.md': '# Changelog\n',
    },
    protect: ['price.test.ts'],
    seed: m => m.save([
      m.rec('price-changelog-rule', 'task', 'todo', 'Каждый раз при изменении src/price.ts добавлять строку в CHANGELOG.md с описанием изменения.', { when: { paths: ['src/price.ts'] } }),
      ...unrelated(m, 6, 'misc'),
    ]),
    prompt: 'В src/price.ts округли результат total до центов через Math.round(x * 100) / 100.',
    verify: dir => both(
      { pass: read(dir, 'src/price.ts').includes('Math.round'), detail: 'rounding ' + read(dir, 'src/price.ts').includes('Math.round') },
      { pass: read(dir, 'CHANGELOG.md').split('\n').filter(l => l.trim()).length >= 2, detail: 'changelog lines ' + read(dir, 'CHANGELOG.md').split('\n').filter(l => l.trim()).length },
      bunTest(dir)),
  },
  {
    id: 'procedure-how',
    measures: 'процедура среди многих равных совпадений («как»)',
    tuned: '0.9.1: тип вопроса при равных совпадениях',
    files: {
      'scripts/migrate.ts': "import { existsSync, writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nif (args.includes('--dry-run')) { writeFileSync('dry-run.done', 'ok'); console.log('dry run: 3 pending migrations'); process.exit(0); }\nif (args.includes('--apply')) { writeFileSync('applied.done', JSON.stringify({ backup: args.includes('--backup'), afterDryRun: existsSync('dry-run.done') })); console.log('applied 3 migrations'); process.exit(0); }\nconsole.error('usage: bun scripts/migrate.ts --dry-run | --apply [--backup]');\nprocess.exit(1);\n",
    },
    protect: ['scripts/migrate.ts'],
    seed: m => {
      m.save(Array.from({ length: 24 }, (_, i) => m.rec(`migration-window-${String(i).padStart(2, '0')}`, i % 2 ? 'fact' : 'decision', i % 2 ? 'active' : 'accepted',
        `Запуск миграций сервиса ${i}: только в окне обслуживания номер ${i}.`)));
      m.save([m.rec('z-migration-steps', 'procedure', 'active', 'Запуск миграций: сначала bun scripts/migrate.ts --dry-run, затем bun scripts/migrate.ts --apply --backup. Без --backup не применять.')]);
    },
    prompt: 'Как запустить миграции? Запусти их.',
    verify: dir => {
      let state: { backup?: boolean; afterDryRun?: boolean } = {};
      try { state = JSON.parse(read(dir, 'applied.done') || '{}'); } catch { /* not applied */ }
      return { pass: state.backup === true && state.afterDryRun === true, detail: 'applied ' + JSON.stringify(state) };
    },
  },
  {
    id: 'why-decision',
    measures: 'причина решения среди равных совпадений («почему»)',
    tuned: '0.9.1: тип вопроса при равных совпадениях',
    files: { 'README.md': '# Service\n\nДанные хранятся в Postgres.\n' },
    seed: m => {
      m.save(Array.from({ length: 20 }, (_, i) => m.rec(`db-note-${String(i).padStart(2, '0')}`, i % 2 ? 'fact' : 'procedure', 'active',
        `Postgres выбрали для сервиса ${i}, версия 16, резервная копия раз в сутки.`)));
      m.save([m.rec('z-db-choice', 'decision', 'accepted', 'Postgres выбрали из-за расширения pg_cron для ночных задач.')]);
    },
    prompt: 'Почему мы выбрали Postgres? Ответь коротко, без вызова инструментов.',
    verify: (_dir, answer) => ({ pass: /pg_cron/i.test(answer), detail: 'answer: ' + answer.replace(/\s+/g, ' ').slice(0, 80) }),
  },
  {
    id: 'continue-journal',
    measures: 'продолжение незаконченной работы по журналу',
    files: {
      'src/slug.ts': "export function slug(s: string) {\n  return s.toLowerCase().replace(/ /g, '_');\n}\n",
      'slug.test.ts': "import { expect, test } from 'bun:test';\nimport { slug } from './src/slug';\ntest('slug', () => {\n  expect(slug('Hello World')).toBe('hello-world');\n  expect(slug('  A  B ')).toBe('a-b');\n});\n",
    },
    protect: ['slug.test.ts'],
    seed: m => {
      m.work({ todo: { phase: 'Slug', done: 1, total: 2, current: 'Починить slug: слова через дефис, без лишних пробелов' } });
      m.work({ file: 'src/slug.ts' });
      m.work({ command: { text: 'bun test', exitCode: 1 } });
    },
    prompt: 'Продолжай.',
    verify: dir => bunTest(dir),
  },
  {
    id: 'stale-check-release',
    measures: 'прошлая успешная проверка после изменения кода',
    tuned: '0.9.1: пройденные проверки в журнале',
    files: {
      'src/calc.ts': 'export const add = (a: number, b: number) => a + b;\n',
      'calc.test.ts': "import { expect, test } from 'bun:test';\nimport { add } from './src/calc';\ntest('add', () => expect(add(2, 3)).toBe(5));\n",
      'CHANGELOG.md': '# Changelog\n',
    },
    protect: ['calc.test.ts'],
    seed: m => {
      m.work({ todo: { phase: 'Calc', done: 2, total: 2 } });
      m.work({ file: 'src/calc.ts' });
      m.work({ check: 'bun test' });
    },
    after: { 'src/calc.ts': 'export const add = (a: number, b: number) => a - b;\n' },
    // Задача — убедиться, а не только дописать: в первой версии «допиши строку» 0.9.0 нашёл поломку
    // и не стал чинить, потому что просили только CHANGELOG. Это двусмысленность запроса, не памяти.
    prompt: 'Прошлый запуск закончил src/calc.ts. Подготовь релиз: убедись, что всё работает, и допиши в CHANGELOG.md строку «release 1.0».',
    verify: dir => both({ pass: read(dir, 'CHANGELOG.md').includes('release 1.0'), detail: 'changelog ' + read(dir, 'CHANGELOG.md').includes('release 1.0') }, bunTest(dir)),
  },
  {
    id: 'preference-layout',
    measures: 'принятое соглашение, которого нет в коде',
    files: { 'src/index.ts': 'export {};\n' },
    seed: m => m.save([
      m.rec('util-layout', 'decision', 'accepted', 'Новые утилиты кладём в src/lib/ с префиксом util-, например src/lib/util-date.ts; экспорт только именованный.'),
      ...unrelated(m, 8, 'misc'),
    ]),
    prompt: 'Добавь утилиту slugify: превращает строку в slug.',
    // Соглашение — каталог и префикс, имя после префикса не задано: util-slug.ts ему тоже следует.
    verify: dir => {
      const lib = join(dir, 'src/lib');
      const files = existsSync(lib) ? readdirSync(lib).filter(name => /^util-.*\.ts$/.test(name)) : [];
      const ok = files.some(name => { const text = read(dir, 'src/lib/' + name); return text.includes('slugify') && !/export\s+default/.test(text); });
      return { pass: ok, detail: 'src/lib util-*: ' + (files.join(',') || 'none') };
    },
  },
  {
    id: 'control-unrelated',
    measures: 'вред: много посторонних записей при обычной правке',
    files: {
      'src/math.ts': 'export const mul = (a: number, b: number) => a + b;\n',
      'math.test.ts': "import { expect, test } from 'bun:test';\nimport { mul } from './src/math';\ntest('mul', () => expect(mul(3, 4)).toBe(12));\n",
    },
    protect: ['math.test.ts'],
    seed: m => m.save(unrelated(m, 30, 'misc')),
    prompt: 'Почини mul в src/math.ts, чтобы тесты проходили.',
    verify: dir => bunTest(dir),
  },
  {
    id: 'control-stale-fact',
    measures: 'вред: устаревший факт о файле, который изменился',
    files: { 'src/config.ts': 'export const PORT = 8080;\n' },
    seed: m => m.save([m.file('server-port', 'fact', 'active', 'Порт сервера — 8080 (src/config.ts).', 'src/config.ts', 'PORT = 8080'), ...unrelated(m, 6, 'misc')]),
    after: { 'src/config.ts': 'export const PORT = 9090;\n' },
    prompt: 'Увеличь порт сервера в src/config.ts на 1.',
    verify: dir => ({ pass: /PORT\s*=\s*9091\b/.test(read(dir, 'src/config.ts')), detail: read(dir, 'src/config.ts').trim().slice(0, 60) }),
  },
];
