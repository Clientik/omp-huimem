// Версия сборки нужна в рантайме, а не только в package.json. База помечается тем, кто в неё
// писал, и при смене версии одна сессия получает однократную сводку изменений.
// ПРИЧИНА 2026-10-15: обновление плагина не доходит до живого разговора. OMP загружает расширение
// при старте процесса, поэтому `omp plugin upgrade` в открытом чате не меняет ничего, а после
// перезапуска с `-c` в контексте остаются ПРЕЖНИЕ правила памяти — модель видела их на каждом
// прошлом ходу, и компакция могла перенести их в свою сводку. Без явной сводки изменений
// модель продолжает работать по старым правилам, не зная, что они другие.
// Соответствие package.json проверяет scripts/check-package.ts.
export const PLUGIN_VERSION = '0.8.4';

// Одна строка на версию: только то, что меняет ПОВЕДЕНИЕ модели, уже видевшей прежний блок.
// Не журнал изменений для человека — его место в README. Длина важна: строка попадает в блок.
export const UPGRADE_NOTES: Record<string, string> = {
  '0.6.4': 'project memory can be switched off per project; publishing .memory/RECORDS.md is part of saving and not a reason to skip commit; durable facts must not stay only in hand-written .memory documents, and those documents are not re-verified with scripts',
  '0.6.5': 'an empty registry is now stated in this block instead of looking like a failed search',
  '0.6.6': 'the canonical file list above is the complete, fixed set and needs no discovery in the plugin source; a freshly compacted history is announced once, and its summary is not evidence',
  '0.6.7': 'the commit contract (kinds, statuses, source forms, versions, limits) is in the project_memory tool description — do not read the plugin source for it; project_memory now has op=doctor, a read-only diagnosis; op=episodes ranks matches, shows the matching part of a long message, takes role=user|assistant and id=<episode> for original message text; the canonical section is a list of files with sizes instead of their text, so read a file before relying on it; a project may add its own .memory documents to the canonical set',
  '0.6.8': 'check a saved quote against its message with project_memory op=evidence (id=<record>, id=<episode> with quote, or nothing at all for every record) instead of your own SQL over the memory database, and run op=doctor instead of importing doctor.ts; the block now names the records it had to omit, and recall id= takes several IDs separated by commas; a proposed decision is your proposal and only the user accepts it, so ask before building work an answer would redo; a question you are waiting on the user for is a record — kind=question, status=open — and stays in the block until it is answered or dropped; when the user answers by number, add source.answers=<ID of your message with the question>',
  '0.6.9': 'a question you are asking right now rests on the request that left the gap — source={origin:"user",quote:"the exact words you cannot act on"} — because your own message is not saved yet; origin="episode" needs episode=<ID> and only fits a question you asked in an earlier turn',
  '0.6.10': 'editing .memory documents no longer marks records STALE when their source is a saved message: the words of that message cannot change with a document, so there is nothing to recheck and no need to save them again unchanged. A file source and an explicit dependsOn behave as before. When a quote you need is in an earlier message rather than the current one, find it with episodes query=<text> role=user and cite source={origin:"episode",episode:"<ID>",quote:"<exact words>"}',
  '0.7.0': 'recall also searches exact source quotes and paths, preserving short technical tokens; original episodes use UTF-16 pages (offset with id, omit/null for search). Automatic context omits unrelated accepted decisions; use recall by ID for details. Project remains the default scope; session is isolated by native dialogue ID, personal needs the human /huimem personal on. Wiki pages are derived interpretations with pinned source versions, never evidence or acceptance. History search has a rebuildable local index; unchanged receipts/checkpoints need no repeat save',
  '0.8.0': 'learn next offers bounded original-source packets; complete acknowledges deliberate review with checked record versions or nothing-durable, without promoting evidence. Interrupted work stays pending and identical completion is a no-op. Wiki plan exposes supported uncovered records, stale pages, proposals and possible duplicates; discover navigates existing record links and backlinks. /huimem learn reviews one packet and a useful Wiki topic in one ordinary main-agent turn; no background model, deletion or competing compaction',
  '0.8.1': '/huimem learn preloads bounded original sources; no ID discovery is needed. Finish useful Wiki work, then complete once WITHOUT id in that intentional turn: runtime binds its project packet. Outside it, complete still requires the exact id. Wiki IDs are ASCII slugs without wiki: prefixes. Invalid review state stops before a model turn; failed or interrupted work stays pending',
  '0.8.2': '/huimem learn keeps its exact project packet through native recovery until the command settles; interruption still leaves unfinished work pending. Validation errors do not imply broken storage. Wiki read checks are scoped to one operation, never a TTL; new reads still detect changed sources. New captures redact recognized credential values; existing source history is not rewritten',
  '0.8.3': 'episodes id=<id> takes limit=<UTF-16 units> up to 12000 for longer original pages, and episodes search takes limit up to 10 hits. Prompts generated by the harness (plan approval, synthetic or agent-attributed messages) are stored as assistant text and cannot back origin=user or an accepted decision',
  '0.8.4': 'a commit result may list wikiStale pages it just made STALE and sameText records repeating another current record; act on them deliberately, nothing is merged or rejected. Inside /huimem learn, status (op=learn without action) is not completion: the supplied packet stays unacknowledged until action=complete',
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
