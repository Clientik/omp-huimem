// Версия сборки нужна в рантайме, а не только в package.json. База помечается тем, кто в неё
// писал, и при смене версии одна сессия получает однократную сводку изменений.
// ПРИЧИНА 2026-10-15: обновление плагина не доходит до живого разговора. OMP загружает расширение
// при старте процесса, поэтому `omp plugin upgrade` в открытом чате не меняет ничего, а после
// перезапуска с `-c` в контексте остаются ПРЕЖНИЕ правила памяти — модель видела их на каждом
// прошлом ходу, и компакция могла перенести их в свою сводку. Без явной сводки изменений
// модель продолжает работать по старым правилам, не зная, что они другие.
// Соответствие package.json проверяет scripts/check-package.ts.
export const PLUGIN_VERSION = '0.6.6';

// Одна строка на версию: только то, что меняет ПОВЕДЕНИЕ модели, уже видевшей прежний блок.
// Не журнал изменений для человека — его место в README. Длина важна: строка попадает в блок.
export const UPGRADE_NOTES: Record<string, string> = {
  '0.6.4': 'project memory can be switched off per project; publishing .memory/RECORDS.md is part of saving and not a reason to skip commit; durable facts must not stay only in hand-written .memory documents, and those documents are not re-verified with scripts',
  '0.6.5': 'an empty registry is now stated in this block instead of looking like a failed search',
  '0.6.6': 'the canonical file list above is the complete, fixed set and needs no discovery in the plugin source; a freshly compacted history is announced once, and its summary is not evidence',
};

// Сравнение версий по числовым частям: 0.6.10 новее 0.6.9, строковое сравнение этого не даёт.
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('.').map(n => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Сводка за все версии между прежней и текущей: обновление через две версии не теряет
// середину. Неизвестная прежняя версия — это база, помеченная сборкой до 0.6.5, то есть
// «что угодно постарше»: тогда выдаётся вся сводка, но не длиннее трёх последних версий.
// ПРИЧИНА: первый живой случай — чат, запущенный на 0.6.3, базу которого 0.6.4 не помечала;
// сводка только за текущую версию потеряла бы именно то изменение правил, ради которого всё.
export const UNKNOWN_SPAN = 3;
export function upgradeNotes(from: string | undefined, to: string = PLUGIN_VERSION): string[] {
  const versions = Object.keys(UPGRADE_NOTES).sort(compareVersions).filter(v => compareVersions(v, to) <= 0);
  const known = from && from !== 'unknown';
  const selected = known ? versions.filter(v => compareVersions(v, from!) > 0) : versions.slice(-UNKNOWN_SPAN);
  return selected.map(v => `${v}: ${UPGRADE_NOTES[v]}`);
}

// Строка для блока памяти. Пустая, если сказать нечего: молчаливое обновление лучше шума.
export function upgradeLine(from: string | undefined, to: string = PLUGIN_VERSION): string {
  const notes = upgradeNotes(from, to);
  if (!notes.length) return '';
  return `PLUGIN_UPGRADED ${from ?? 'unknown'} -> ${to}: ${notes.join(' | ')}. ` +
    'Earlier turns in this conversation were produced under the previous rules; the rules in this block are the current ones.\n';
}
