// АТРИБУЦИЯ УРОВНЯ УТВЕРЖДЕНИЯ, А НЕ ДОКУМЕНТА.
// Прежняя пометка накрывала файл целиком: «это текст документа, не сообщение
// пользователя». Замерено 2026-09-10 тремя живыми прогонами: на старом ADR, где
// причинная связь дописана прозой, модель всё равно приписывала её пользователю.
// Обзор arXiv:2606.04990 называет это provenance-role collapse и указывает причину:
// атрибуция уровня документа «masks unsupported sub-claims» — статус «принято»
// распространяется на каждое предложение.
// Поэтому цитируемым объявляется только блок основания. У документа без такого блока
// цитируемой части нет вовсе: он не объявляется ложным, он перестаёт быть источником
// авторитета. Ложность по несовпадению строк не выводится — это отдельный класс ошибок.

// Заголовок ищется на нескольких языках: содержимое стартового набора русское,
// документация репозитория трёхъязычная, и механизм не должен зависеть от языка.
// Граница слова здесь через \p{L}, а НЕ через \b: в JavaScript \b определён только по
// ASCII, поэтому после кириллицы и иероглифов он не срабатывает и заголовок не находился.
const BASIS_HEADING = /^#{1,6}\s*(основание|basis|evidence|source|依据)(?![\p{L}\p{N}])/iu;
const HEADING = /^#{1,6}\s/;

export type Basis = { section: boolean; quotes: string[] };

export function readBasis(text: string): Basis {
  const lines = text.split('\n');
  const start = lines.findIndex(l => BASIS_HEADING.test(l.trim()));
  if (start < 0) return { section: false, quotes: [] };
  const quotes: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (HEADING.test(line)) break; // Следующий раздел: основание закончилось.
    const quoted = line.match(/^>\s?(.*)$/);
    if (quoted && quoted[1].trim()) quotes.push(quoted[1].trim());
  }
  return { section: true, quotes };
}

const TAIL =
  ' Cite the quoted basis when answering why; anything beyond it stays unverified even if the document reads as settled.' +
  ' The original source.quote in project_memory remains the primary evidence. Content below is preserved unchanged.]';

export function provenanceNote(basis: Basis): string {
  if (!basis.section)
    return '[huimem DOCUMENT_PROVENANCE: this document has NO basis section, so it carries no user evidence at all.' +
      ' Its accepted status verifies none of its sentences. Do not attribute any reason here to the user;' +
      ' if no original quote exists, say the basis is missing rather than supplying one.' + TAIL;
  if (!basis.quotes.length)
    return '[huimem DOCUMENT_PROVENANCE: the basis section contains no verbatim quote, so this document carries no user evidence.' +
      ' Treat every sentence here, including the decision itself, as unverified interpretation.' + TAIL;
  return `[huimem DOCUMENT_PROVENANCE: only the ${basis.quotes.length} quoted line(s) under the basis heading are user evidence.` +
    ' Every other sentence here — status, rationale prose, alternatives, consequences — is interpretation and is not verified by acceptance.' + TAIL;
}
