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

export type PackInput = {
  limit: number; recallBudget: number;
  status: string; sourceOrder: string; claimScope: string; commitRules: string;
  preview: string; recent: string; checkpoint: string;
  recall: (budget: number) => RetrievalResult;
};
export type PackResult = { content: string; registryOffset: number; retrieval: RetrievalResult; truncated: boolean };

const OPTIONAL = ['canonical preview', 'previous checkpoint', 'recent assistant sources', 'registry'];

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
  const whole = head(i.preview, i.recent, i.checkpoint);
  if (whole.length + natural.text.length <= i.limit)
    return { content: whole + natural.text, registryOffset: whole.length, retrieval: natural,
      truncated: natural.text.split('\n').some(l => l.startsWith('[More records omitted')) };

  // 2. Обязательные правила вместе с зарезервированной пометкой не помещаются.
  const required: [string, string][] = [['status', i.status], ['source order rules', i.sourceOrder],
    ['claim scope rules', i.claimScope], ['commit rules', i.commitRules]];
  const requiredLength = required.reduce((n, [, t]) => n + t.length, 0);
  const reserve = budgetNotice(i.limit, OPTIONAL, OPTIONAL).length;
  if (requiredLength + reserve > i.limit) {
    const exhausted = (names: string[]) =>
      `[MEMORY_BUDGET_EXHAUSTED: required memory instructions do not fit memory limit ${i.limit}; omitted: ${names.join(', ')}. ` +
      'Omitted rules still apply. Raise the limit with /huimem limit.]\n';
    let space = i.limit - exhausted([...required.map(([n]) => n), ...OPTIONAL]).length;
    let out = ''; const cut: string[] = [];
    for (const [name, text] of required) {
      if (text.length <= space) { out += text; space -= text.length; } else cut.push(name);
    }
    const content = out + exhausted([...cut, ...OPTIONAL]);
    return { content, registryOffset: content.length, retrieval: i.recall(0), truncated: true };
  }

  // 3. Распределение под давлением, с резервом под общую пометку.
  let space = i.limit - requiredLength - reserve;
  const omitted: string[] = [], trimmed: string[] = [];
  const previewFloor = Math.min(i.preview.length, PREVIEW_FLOOR);
  const registryBudget = Math.max(0, Math.min(i.recallBudget, space - previewFloor));
  let retrieval = i.recall(registryBudget);
  let registry = retrieval.text;
  // Заголовок реестра и его собственная пометка занимают место: при крошечном бюджете
  // вывод поиска больше бюджета. Тогда реестр не выдаётся, и это названо в пометке.
  if (registry.length > registryBudget) {
    registry = '';
    if (retrieval.totalCandidates > 0) omitted.push('registry');
  } else if (registry.split('\n').some(l => l.startsWith('[More records omitted'))) trimmed.push('registry');
  space -= registry.length;
  const parts: [string, string][] = [['canonical preview', i.preview], ['previous checkpoint', i.checkpoint], ['recent assistant sources', i.recent]];
  const placed: Record<string, string> = {};
  for (const [name, text] of parts) {
    const c = clip(text, space);
    placed[name] = c.text; space -= c.text.length;
    if (c.state === 'omitted') omitted.push(name); else if (c.state === 'trimmed') trimmed.push(name);
  }
  const top = head(placed['canonical preview'], placed['recent assistant sources'], placed['previous checkpoint']);
  const content = top + registry + budgetNotice(i.limit, omitted, trimmed);
  return { content, registryOffset: top.length, retrieval, truncated: omitted.length + trimmed.length > 0 };
}
