// СБОРКА БЛОКА ПАМЯТИ ПО ЦЕЛЫМ ЧАСТЯМ, А НЕ ОБРЕЗКОЙ ПО СИМВОЛУ.
// ЗАМЕРЕНО 2026-09-14 тестом до правки: обработчик context склеивал инструкции, выдержку
// документов и сводку чекпоинта, отдавал реестру полный бюджет, а затем резал весь блок
// slice(0, limit - 80). При лимите 5000 до модели не дошло ни одной записи реестра; при
// 2000 срез выбросил правила commit целиком — без какого-либо сообщения модели.
// Первая версия этой правки ставила пометку об опущении у каждой части отдельно, и при
// тесном бюджете сами пометки не помещались: реестр и чекпоинт снова пропадали молча.
// Поэтому пометка одна, общая, и место под неё резервируется заранее.
// Если всё помещается — блок отдаётся без изменений, резерв не применяется.
// Уступают место по порядку: недавние источники, сводка чекпоинта, выдержка документов
// сверх минимума, реестр. Реестр — только целыми записями. Обязательные правила не режутся
// посреди строки; если они сами не помещаются, пометка называет опущенные разделы.
import type { RetrievalResult } from './core';

export const PREVIEW_FLOOR = 600;
// ЗАМЕРЕНО 2026-10-19 на копии живого HUICAD (audit/release-0.6.8): при 20 записях блок упёрся
// в предел, и сводка чекпоинта дошла обрезанной до 218 символов из 780. Сводка кончается
// следующим шагом — «ответы пользователя на вопросы §19 архитектуры», — поэтому обрезка с начала
// теряет ровно то, ради чего чекпоинт и нужен. Отсюда и пол, и обрезка с двух концов.
export const CHECKPOINT_FLOOR = 500;

export type PackInput = {
  limit: number; recallBudget: number;
  status: string; sourceOrder: string; claimScope: string; commitRules: string;
  preview: string; recent: string; checkpoint: string;
  recall: (budget: number) => RetrievalResult;
};
export type PackResult = { content: string; registryOffset: number; retrieval: RetrievalResult; truncated: boolean };

const OPTIONAL = ['canonical file list', 'previous checkpoint', 'recent assistant sources', 'registry'];

// Вписать прозу в space символов: целиком, либо по границе строки или слова, либо никак.
export function clip(part: string, space: number): { text: string; state: 'whole' | 'trimmed' | 'omitted' } {
  if (part.length <= space) return { text: part, state: 'whole' };
  if (space >= 40) {
    const slice = part.slice(0, space - 1);
    const nl = slice.lastIndexOf('\n'), sp = slice.lastIndexOf(' ');
    const at = nl > slice.length / 2 ? nl : sp > slice.length / 2 ? sp : slice.length;
    const text = slice.slice(0, at).replace(/\s+$/, '') + '\n';
    if (text.trim()) return { text, state: 'trimmed' };
  }
  return { text: '', state: 'omitted' };
}

// Та же задача, но сохраняя конец: начало сводки говорит, что сделано, а конец — что дальше.
// Пропуск назван прямо в тексте, чтобы две половины не читались как одна фраза.
export const MIDDLE = ' […omitted; project_memory recall id=<task>…] ';
export function clipEnds(part: string, space: number): { text: string; state: 'whole' | 'trimmed' | 'omitted' } {
  if (part.length <= space) return { text: part, state: 'whole' };
  if (space < MIDDLE.length + 120) return clip(part, space);
  const room = space - MIDDLE.length - 1;
  const headRoom = Math.ceil(room * 0.6), tailRoom = room - headRoom;
  const head = part.slice(0, headRoom);
  const cut = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'));
  const tail = part.slice(part.length - tailRoom).replace(/^\S*\s/, '');
  const text = (cut > headRoom / 2 ? head.slice(0, cut) : head) + MIDDLE + tail;
  return { text: text.endsWith('\n') ? text : text + '\n', state: 'trimmed' };
}

// У чекпоинтов каждая строка — отдельная сводка со своим следующим шагом, поэтому урезается
// каждая, а не блок целиком: иначе выживают начало первой строки и конец последней.
export function clipLines(part: string, space: number): { text: string; state: 'whole' | 'trimmed' | 'omitted' } {
  if (part.length <= space) return { text: part, state: 'whole' };
  const lines = part.split('\n').filter(Boolean).map(l => l + '\n');
  if (lines.length < 2) return clipEnds(part, space);
  const even = Math.floor(space / lines.length);
  let left = space;
  const out: string[] = [], long: number[] = [];
  lines.forEach((l, n) => { if (l.length <= even) { out[n] = l; left -= l.length; } else { out[n] = ''; long.push(n); } });
  const share = long.length ? Math.floor(left / long.length) : 0;
  for (const n of long) { const c = clipEnds(lines[n], share); out[n] = c.text; }
  const text = out.join('');
  return text.trim() ? { text, state: 'trimmed' } : { text: '', state: 'omitted' };
}

export function budgetNotice(limit: number, omitted: string[], trimmed: string[]): string {
  if (!omitted.length && !trimmed.length) return '';
  return `[MEMORY_BUDGET: memory limit ${limit} reached;` +
    (omitted.length ? ` omitted: ${omitted.join(', ')};` : '') +
    (trimmed.length ? ` trimmed: ${trimmed.join(', ')};` : '') +
    ' use project_memory recall and read the source files for the rest.]\n';
}

export function packContext(i: PackInput): PackResult {
  const head = (preview: string, recent: string, checkpoint: string) =>
    i.status + i.sourceOrder + i.claimScope + preview + recent + checkpoint + i.commitRules;

  // 1. Всё помещается — прежний вывод без изменений.
  const natural = i.recall(i.recallBudget);
  const requiredLabel='REQUIRED records (IDs: project_memory status)';
  const optional=natural.requiredCount ? [...OPTIONAL,requiredLabel] : OPTIONAL;
  // Пометка о пропуске называет количество и ID записей: «[13 record(s) omitted by budget: …]».
  const incomplete=(r:RetrievalResult)=>r.truncated ?? /\[\d+ record\(s\) omitted/.test(r.text);
  const visibleOmission=(r:RetrievalResult)=>/\[(\d+ record\(s\) omitted|REQUIRED)/.test(r.text);
  const whole = head(i.preview, i.recent, i.checkpoint);
  if (whole.length + natural.text.length <= i.limit && (!incomplete(natural) || visibleOmission(natural)))
    return { content: whole + natural.text, registryOffset: whole.length, retrieval: natural,
      truncated: incomplete(natural) };

  // 2. Обязательные правила вместе с зарезервированной пометкой не помещаются.
  const required: [string, string][] = [['status', i.status], ['source order rules', i.sourceOrder],
    ['claim scope rules', i.claimScope], ['commit rules', i.commitRules]];
  const requiredLength = required.reduce((n, [, t]) => n + t.length, 0);
  const reserve = budgetNotice(i.limit, optional, optional).length;
  if (requiredLength + reserve > i.limit) {
    const exhausted = (names: string[]) =>
      `[MEMORY_BUDGET_EXHAUSTED: required memory instructions do not fit memory limit ${i.limit}; omitted: ${names.join(', ')}. ` +
      'Omitted rules still apply. Raise the limit with /huimem limit.]\n';
    let space = i.limit - exhausted([...required.map(([n]) => n), ...optional]).length;
    let out = ''; const cut: string[] = [];
    for (const [name, text] of required) {
      if (text.length <= space) { out += text; space -= text.length; } else cut.push(name);
    }
    const content = out + exhausted([...cut, ...optional]);
    return { content, registryOffset: content.length, retrieval: i.recall(0), truncated: true };
  }

  // 3. Распределение под давлением, с резервом под общую пометку.
  let space = i.limit - requiredLength - reserve;
  const omitted: string[] = [], trimmed: string[] = [];
  const previewFloor = Math.min(i.preview.length, PREVIEW_FLOOR);
  // Пол чекпоинта: реестр уступает место последним, и на тесном бюджете он забирал всё, что
  // осталось от сводки. Запись, не попавшую в блок, теперь можно позвать по ID из пометки о
  // пропуске; потерянный следующий шаг позвать нельзя — о нём больше нигде не сказано.
  const checkpointFloor = Math.min(i.checkpoint.length, CHECKPOINT_FLOOR);
  const registryBudget = Math.max(0, Math.min(i.recallBudget, space - previewFloor - checkpointFloor));
  // Тот же бюджет — тот же результат поиска: повторный вызов (≈100 мс на большой памяти) не нужен.
  let retrieval = registryBudget === i.recallBudget ? natural : i.recall(registryBudget);
  let registry = retrieval.text;
  // Заголовок реестра и его собственная пометка занимают место: при крошечном бюджете
  // вывод поиска больше бюджета. Тогда реестр не выдаётся, и это названо в пометке.
  if (registry.length > registryBudget) {
    registry = '';
    if (retrieval.totalCandidates > 0) omitted.push('registry');
  } else if (incomplete(retrieval)) {
    if(!registry) omitted.push('registry'); else trimmed.push('registry');
  }
  if(retrieval.requiredOmissions?.length) {
    if(!registry) omitted.push(requiredLabel); else trimmed.push(requiredLabel);
  }
  space -= registry.length;
  const parts: [string, string][] = [['canonical file list', i.preview], ['previous checkpoint', i.checkpoint], ['recent assistant sources', i.recent]];
  // Сначала минимумы, потом остаток в прежнем порядке уступок. Прежде список файлов получал
  // ВСЁ оставшееся место первым, и сводка чекпоинта уступала раньше него, хотя оба пола уже
  // были вычтены из бюджета реестра: место, сбережённое для сводки, уходило списку файлов.
  const allow: Record<string, number> = {};
  for (const [name, floor] of [['canonical file list', previewFloor], ['previous checkpoint', checkpointFloor]] as [string, number][]) {
    allow[name] = Math.min(floor, space); space -= allow[name];
  }
  for (const [name, text] of parts) {
    const add = Math.max(0, Math.min(text.length - (allow[name] ?? 0), space));
    allow[name] = (allow[name] ?? 0) + add; space -= add;
  }
  const placed: Record<string, string> = {};
  for (const [name, text] of parts) {
    const c = name === 'previous checkpoint' ? clipLines(text, allow[name]) : clip(text, allow[name]);
    placed[name] = c.text; space += allow[name] - c.text.length;
    if (c.state === 'omitted') omitted.push(name); else if (c.state === 'trimmed') trimmed.push(name);
  }
  const top = head(placed['canonical file list'], placed['recent assistant sources'], placed['previous checkpoint']);
  const content = top + registry + budgetNotice(i.limit, omitted, trimmed);
  return { content, registryOffset: top.length, retrieval, truncated: omitted.length + trimmed.length > 0 };
}
