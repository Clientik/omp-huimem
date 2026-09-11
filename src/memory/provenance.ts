// АТРИБУЦИЯ УРОВНЯ УТВЕРЖДЕНИЯ, А НЕ ДОКУМЕНТА.
// Прежняя пометка накрывала файл целиком: «это текст документа, не сообщение
// пользователя». Замерено 2026-09-10 тремя живыми прогонами: на старом ADR, где
// причинная связь дописана прозой, модель всё равно приписывала её пользователю.
// Обзор arXiv:2606.04990 называет это provenance-role collapse и указывает причину:
// атрибуция уровня документа «masks unsupported sub-claims» — статус «принято»
// распространяется на каждое предложение.
// Блок основания выделяет заявленные цитаты, но не подтверждает их авторство.
// Без сверки с исходным сообщением даже оформленная цитата остаётся непроверенной.

// Заголовок ищется на нескольких языках: содержимое стартового набора русское,
// документация репозитория трёхъязычная, и механизм не должен зависеть от языка.
// Граница слова здесь через \p{L}, а НЕ через \b: в JavaScript \b определён только по
// ASCII, поэтому после кириллицы и иероглифов он не срабатывает и заголовок не находился.
const BASIS_HEADING = /^#{1,6}\s*(основание|basis|evidence|source|依据)(?![\p{L}\p{N}])/iu;
const HEADING = /^#{1,6}\s/;

export type Basis = { section: boolean; quotes: string[] };

export function readBasis(text: string): Basis {
  let lines = text.split('\n');
  // OMP read wraps the excerpt in [path#hash] and prefixes lines with N:.
  // Decode only that envelope; never strip numbers from ordinary Markdown.
  if (/^\[[^\]\r\n]+#[a-zA-Z0-9]+\]\s*$/.test(lines[0] ?? ''))
    lines = lines.slice(1).map(line => line.replace(/^\d+:/, ''));
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
  ' Verify attribution against the original user message (project_memory source.quote and its user episode), not Markdown formatting.' +
  ' If that evidence is unavailable, report attribution as unverified; do not invent or repair a quote. Content below is preserved unchanged.]';

export function provenanceNote(basis: Basis): string {
  if (!basis.section)
    return '[huimem DOCUMENT_PROVENANCE: NO basis section is visible in this excerpt; the rest of the document may contain one.' +
      ' Its accepted status verifies none of its sentences. This excerpt establishes no user attribution.' + TAIL;
  if (!basis.quotes.length)
    return '[huimem DOCUMENT_PROVENANCE: the visible basis section contains no verbatim quote; it may be incomplete.' +
      ' User attribution is unverified.' + TAIL;
  return `[huimem DOCUMENT_PROVENANCE: ${basis.quotes.length} quoted line(s) are visible under a basis heading, but their authorship is unverified. They are document claims, not authenticated user evidence.` +
    ' Every other sentence here — status, rationale prose, alternatives, consequences — is interpretation and is not verified by acceptance.' + TAIL;
}
