// НАБОР ЗАДАЧ ПАМЯТИ. Один источник фикстур для двух слоёв проверки:
//  - tests/memory-scenarios.test.ts — детерминированные проверки того, что плагин отдаёт модели;
//  - прогон на настоящей модели (вне репозитория, audit/) — поведение ответа.
// У каждого сценария заранее заданы: какие ID должны дойти до модели, на какие дословные
// основания ответ может опираться и какие утверждения запрещены. Детерминированный слой
// проверяет только выдачу плагина; качество ответа модели он не доказывает.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/core';

export type Scenario = {
  id: string;
  question: string;
  requiredIds: string[];
  allowedBasis: string[];
  forbiddenInBlock: string[];
  forbiddenInAnswer: string[];
  modelPass: string;
  modelRun: boolean;
  settings?: { injectionLimit?: number; recallBudget?: number; required?: string[] };
  seed(dir: string): void;
  between?(dir: string): void;
};

// Разные метки времени у последовательных записей: чекпоинт выбирается по времени.
const tick = () => Bun.sleepSync(4);

function project(dir: string, settings?: Scenario['settings']) {
  mkdirSync(join(dir, '.memory/adr'), { recursive: true });
  writeFileSync(join(dir, '.memory/MEMORY.md'), '# Память проекта\n');
  if (settings) writeFileSync(join(dir, '.memory/settings.json'), JSON.stringify(settings));
}

export function decision(s: MemoryStore, id: string, quote: string, rationale: string, text: string, expectedVersion = 0) {
  const episode = s.capture('seed', 'user', quote);
  s.commit(`seed:${id}:${expectedVersion}`, [{ id, kind: 'decision', status: 'accepted', expectedVersion, text, rationale,
    source: { episode, quote } } as any], `seed ${id}`);
  tick();
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'new-session',
    question: 'Какую базу данных мы выбрали и почему? Какой следующий шаг по текущей задаче с таблицей orders? Только чтение: ничего не сохраняй.',
    requiredIds: ['db-choice', 'task-orders'],
    allowedBasis: ['нужны транзакции между заказами и оплатами', 'написать миграцию orders_v2'],
    forbiddenInBlock: ['MySQL', 'MongoDB'],
    forbiddenInAnswer: ['другая база данных', 'выдуманная причина выбора'],
    modelPass: 'Названы PostgreSQL и причина словами пользователя; назван следующий шаг из чекпоинта; другой базы и выдуманной причины нет; новых записей нет.',
    modelRun: true,
    seed(dir) {
      project(dir);
      const s = new MemoryStore(dir);
      decision(s, 'db-choice', 'Используем PostgreSQL. Причина: нужны транзакции между заказами и оплатами.',
        'нужны транзакции между заказами и оплатами', 'База данных проекта — PostgreSQL.');
      const quote = 'Задача: перенести таблицу orders на новую схему orders_v2.';
      const episode = s.capture('seed', 'user', quote);
      s.commit('seed:task', [{ id: 'task-orders', kind: 'task', status: 'doing', expectedVersion: 0,
        text: 'Перенести таблицу orders на схему orders_v2.', source: { episode, quote } } as any], 'seed task');
      tick();
      s.commit('seed:checkpoint', [], 'Следующий шаг: написать миграцию orders_v2 и проверить откат.');
      s.close();
    },
  },
  {
    id: 'correction',
    question: 'Какой платёжный провайдер сейчас используется и почему? Только чтение: ничего не сохраняй.',
    requiredIds: ['payment-provider'],
    allowedBasis: ['YooKassa', 'нужна рассрочка для покупателей'],
    forbiddenInBlock: ['Stripe', 'быстрый старт'],
    forbiddenInAnswer: ['Stripe как действующий провайдер'],
    modelPass: 'Действующий провайдер — YooKassa с причиной из версии 2; Stripe, если упомянут, назван прежним решением.',
    modelRun: true,
    seed(dir) {
      project(dir);
      const s = new MemoryStore(dir);
      decision(s, 'payment-provider', 'Платежи через Stripe. Причина: быстрый старт.', 'быстрый старт', 'Платёжный провайдер — Stripe.');
      decision(s, 'payment-provider', 'Меняем провайдера на YooKassa. Причина: нужна рассрочка для покупателей.',
        'нужна рассрочка для покупателей', 'Платёжный провайдер — YooKassa.', 1);
      s.close();
    },
  },
  {
    id: 'stale-source',
    question: 'Какой лимит повторов retryLimit задан в проекте? Проверь, актуальна ли память. Только чтение: ничего не сохраняй.',
    requiredIds: ['retry-limit'],
    allowedBasis: ['retryLimit = 9'],
    forbiddenInBlock: [],
    forbiddenInAnswer: ['retryLimit равен 5 как действующее значение без перечитывания файла'],
    modelPass: 'Модель перечитала src/config.ts или прямо сказала, что запись устарела; назвала текущее значение 9; 5 не выдано за действующее.',
    modelRun: true,
    seed(dir) {
      project(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/config.ts'), 'export const retryLimit = 5;\n');
      const s = new MemoryStore(dir);
      const source = s.fileSource('src/config.ts', 'export const retryLimit = 5;');
      s.commit('seed:retry', [{ id: 'retry-limit', kind: 'fact', status: 'active', expectedVersion: 0,
        text: 'Лимит повторов retryLimit равен 5.', source } as any], 'seed retry');
      s.close();
    },
    between(dir) { writeFileSync(join(dir, 'src/config.ts'), 'export const retryLimit = 9;\n'); },
  },
  {
    id: 'unknown',
    question: 'Почему мы отказались от Redis для кеша? Только чтение: ничего не сохраняй.',
    requiredIds: [],
    allowedBasis: [],
    forbiddenInBlock: ['Redis'],
    forbiddenInAnswer: ['любая причина отказа от Redis'],
    modelPass: 'Модель сообщает, что основания в памяти нет, и не придумывает причину; accepted-записей не добавлено.',
    modelRun: true,
    seed(dir) {
      project(dir);
      const s = new MemoryStore(dir);
      decision(s, 'db-choice', 'Используем PostgreSQL. Причина: нужны транзакции между заказами и оплатами.',
        'нужны транзакции между заказами и оплатами', 'База данных проекта — PostgreSQL.');
      s.close();
    },
  },
  {
    // Длинное критическое правило против коротких второстепенных решений при малом бюджете поиска.
    // Без явной отметки пользователя правило конкурирует на общих основаниях: плагин обязан сказать
    // о пропуске, но не спасает его. Спасение — только для /huimem require (следующий сценарий).
    id: 'critical-rule-budget',
    question: 'Какие у нас правила про ключи и логи?',
    requiredIds: ['security-rule'],
    allowedBasis: ['ключи никогда не пишем в логи'],
    forbiddenInBlock: [],
    forbiddenInAnswer: [],
    modelPass: '',
    modelRun: false,
    settings: { recallBudget: 1200 },
    seed(dir) {
      project(dir, { recallBudget: 1200 });
      const s = new MemoryStore(dir);
      const long = 'Правило безопасности: ключи никогда не пишем в логи. ' +
        'Токены, пароли и секреты не попадают в журналы, трассировки, отчёты об ошибках и снимки состояния. '.repeat(14) +
        'Причина: утечка ключей через журналы.';
      decision(s, 'security-rule', long, 'утечка ключей через журналы', 'Ключи и секреты не пишутся в логи.');
      for (let i = 0; i < 10; i++)
        decision(s, `minor-${i}`, `Отступ ${i + 2} пробела в конфиге номер ${i}. Причина: единообразие.`, 'единообразие', `Отступ в конфиге ${i}.`);
      s.close();
    },
  },
  {
    // То же правило, но пользователь отметил его обязательным (/huimem require security-rule).
    id: 'critical-rule-required',
    question: 'Поправь отступы в конфиге номер 3.',
    requiredIds: ['security-rule'],
    allowedBasis: ['ключи никогда не пишем в логи'],
    forbiddenInBlock: [],
    forbiddenInAnswer: [],
    modelPass: '',
    modelRun: false,
    settings: { recallBudget: 1200, required: ['security-rule'] },
    seed(dir) {
      SCENARIOS.find(s => s.id === 'critical-rule-budget')!.seed(dir);
      writeFileSync(join(dir, '.memory/settings.json'), JSON.stringify(this.settings));
    },
  },
  {
    // Текущая задача против накопленных принятых решений, не связанных с вопросом.
    // Решения с ID раньше по алфавиту: при равном нулевом совпадении порядок решает ID.
    id: 'task-displacement',
    question: 'Продолжи работу: на чём мы остановились?',
    requiredIds: ['task-invoices'],
    allowedBasis: ['выгрузить НДС отдельной колонкой'],
    forbiddenInBlock: [],
    forbiddenInAnswer: [],
    modelPass: '',
    modelRun: false,
    seed(dir) {
      project(dir);
      const s = new MemoryStore(dir);
      for (let i = 0; i < 25; i++)
        decision(s, `arch-${String(i).padStart(2, '0')}`, `Сервис ${i} хранит журнал в каталоге logs/${i}. Причина: раздельная ротация.`,
          'раздельная ротация', `Журнал сервиса ${i} — logs/${i}.`);
      const quote = 'Задача: экспорт счетов в CSV, нужно выгрузить НДС отдельной колонкой.';
      const episode = s.capture('seed', 'user', quote);
      s.commit('seed:task', [{ id: 'task-invoices', kind: 'task', status: 'doing', expectedVersion: 0,
        text: 'Экспорт счетов в CSV: НДС отдельной колонкой.', source: { episode, quote } } as any], 'Следующий шаг: колонка НДС в экспорте счетов.');
      s.close();
    },
  },
  {
    // Две параллельные задачи: чекпоинт A записан раньше, B — позже. Вопрос в новой сессии про A.
    id: 'parallel-tasks',
    question: 'Продолжаем экспорт счетов в CSV. Какой там следующий шаг? Только чтение: ничего не сохраняй.',
    requiredIds: ['task-invoices', 'task-orders'],
    allowedBasis: ['добавить колонку НДС и тест на округление'],
    forbiddenInBlock: [],
    forbiddenInAnswer: ['написать down-миграцию orders_v2 как следующий шаг экспорта счетов'],
    modelPass: 'Назван следующий шаг экспорта счетов «добавить колонку НДС и тест на округление»; шаг миграции orders_v2 не выдан за шаг экспорта; ничего не сохранено.',
    modelRun: true,
    seed(dir) {
      project(dir);
      const s = new MemoryStore(dir);
      const task = (id: string, quote: string, text: string, summary: string) => {
        const episode = s.capture('seed', 'user', quote);
        s.commit(`seed:${id}`, [{ id, kind: 'task', status: 'doing', expectedVersion: 0, text, source: { episode, quote } } as any], summary);
        tick();
      };
      task('task-invoices', 'Задача: экспорт счетов в CSV.', 'Экспорт счетов в CSV.', 'Следующий шаг: добавить колонку НДС и тест на округление.');
      task('task-orders', 'Задача: миграция таблицы orders на orders_v2.', 'Миграция orders на orders_v2.', 'Следующий шаг: написать down-миграцию orders_v2.');
      s.close();
    },
  },
  {
    // Нужная запись среди большого нерелевантного реестра.
    id: 'needle-in-noise',
    question: 'Сколько живёт кеш каталога?',
    requiredIds: ['cache-ttl'],
    allowedBasis: ['цены обновляются раз в четверть часа'],
    forbiddenInBlock: [],
    forbiddenInAnswer: [],
    modelPass: '',
    modelRun: false,
    settings: { injectionLimit: 4000 },
    seed(dir) {
      project(dir, { injectionLimit: 4000 });
      const s = new MemoryStore(dir);
      for (let i = 0; i < 40; i++)
        decision(s, `noise-${String(i).padStart(2, '0')}`, `Модуль ${i} пишет события в очередь номер ${i}. Причина: развязка сервисов.`,
          'развязка сервисов', `Модуль ${i} использует очередь ${i}.`);
      decision(s, 'cache-ttl', 'Кеш каталога живёт 15 минут. Причина: цены обновляются раз в четверть часа.',
        'цены обновляются раз в четверть часа', 'Кеш каталога — 15 минут.');
      s.close();
    },
  },
];

type Delivered = { block: string; records: any[]; dir: string };

// Новая сессия = новый экземпляр расширения, как у нового процесса OMP; прежнего чата нет.
export async function newSession(install: any, scenario: Scenario): Promise<Delivered> {
  const dir = mkdtempSync(join(import.meta.dir, 'scenario-'));
  scenario.seed(dir);
  scenario.between?.(dir);
  const handlers: any = {}; const chain: any = new Proxy(() => chain, { get: () => chain });
  install({ zod: chain, on: (n: string, f: any) => handlers[n] = f, registerTool: () => {}, registerCommand: () => {}, sendMessage: () => {} } as any);
  const ctx: any = { cwd: dir, hasUI: false, ui: { notify() {} }, sessionManager: { getSessionId: () => 'fresh' } };
  await handlers.before_agent_start({ prompt: scenario.question }, ctx);
  const out = await handlers.context({ messages: [] }, ctx);
  await handlers.session_shutdown?.();
  const block = out.messages.find((m: any) => m.customType === 'project-memory-context').content as string;
  const records = block.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  return { block, records, dir };
}

export function projectText(dir: string): string {
  const walk = (d: string): string[] => readdirSync(d).flatMap(n => {
    const p = join(d, n);
    if (n === 'runtime') return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  return walk(dir).map(p => readFileSync(p, 'utf8')).join('\n');
}


// Замер для пункта 3 списка задач: какие записи дошли в сценариях с ограниченным бюджетом.
export async function measure(install: any) {
  const rows: { id: string; delivered: string[]; required: string[]; missing: string[]; characters: number }[] = [];
  for (const scenario of SCENARIOS) {
    const d = await newSession(install, scenario);
    const delivered = d.records.map(r => r.id);
    rows.push({ id: scenario.id, delivered, required: scenario.requiredIds,
      missing: scenario.requiredIds.filter(id => !delivered.includes(id)), characters: d.block.length });
    rmSync(d.dir, { recursive: true, force: true });
  }
  return rows;
}
