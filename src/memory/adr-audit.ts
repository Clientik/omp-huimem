// ПЕРЕНОС СТАРЫХ ADR В КОНТРАКТ — ДАННЫМИ РЕЕСТРА, А НЕ ПОСЛУШАНИЕМ МОДЕЛИ.
// Цитата и интерпретация разделяются в самом документе. Актуальные замеры и
// ограничения — в docs/VALIDATION.md; превосходство переноса пока не доказано.
// Источник цитаты — запись реестра, у которой причина проверена КОДОМ как дословная
// подстрока цитаты пользователя (RATIONALE_SOURCE_REQUIRED в core.ts): это единственное
// место, где атрибуция гарантирована не моделью.
// Проза не удаляется и не объявляется ложной — она целиком переносится под заголовок
// «Интерпретация [?]». Так же Zep поступает с опровергнутым фактом: закрывает, не стирает.
// Метки прямо в выводе read не ставятся: правка идёт в режиме hashline по номерам строк,
// и модель скопировала бы метки в сам файл.
import { readBasis } from './provenance';

export type LatestRecord = { id: string; version: number; data: any };
export type AuditItem =
  | { path: string; state: 'has-basis' }
  | { path: string; state: 'no-match' }
  | { path: string; state: 'ambiguous'; candidates: string[] }
  | { path: string; state: 'conflict'; reason:string }
  | { path: string; state: 'migratable'; recordId: string; version: number; episode: string; quote: string; proposed: string; sourceHash:string };

const norm = (p: string) => p.replaceAll('\\', '/');

// Годится только решение, чья цитата — свидетельство пользователя и чья причина
// дословно в ней содержится. Перепроверяем, а не полагаемся на то, что так было при записи.
export function eligible(data: any): boolean {
  return data?.kind === 'decision' && data?.status === 'accepted'
    && typeof data?.source?.episode === 'string' && data.source.episode.length > 0
    && typeof data?.source?.quote === 'string' && data.source.quote.trim().length > 0
    && typeof data?.rationale === 'string' && data.rationale.length > 0
    && data.source.quote.includes(data.rationale);
}

// Связь решения с документом должна быть явной: путь в тексте записи или в её ссылках.
// Совпадение по смыслу не выводится — это был бы тот же домысел, с которым боремся.
export function mentions(data: any, adrPath: string): boolean {
  const path = norm(adrPath);
  const escaped=path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const reference=new RegExp('(^|[\\s`"\'(<\\[])'+escaped+'(?=$|[\\s`"\')>\\],;:]|\\.(?:$|\\s))');
  const inText = typeof data?.text === 'string' && reference.test(norm(data.text));
  const inLinks = Array.isArray(data?.links) && data.links.some((l: any) => {
    if(typeof l!=='string') return false;
    const link=norm(l).replace(/^\.\//,'');
    return link===path || (!link.includes('/') && '.memory/adr/'+link===path);
  });
  return inText || inLinks;
}

export function migrate(original: string, record: { id: string; version: number; episode: string; quote: string }, date: string): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const hasTitle = /^#\s/.test(lines[0] ?? '');
  const title = hasTitle ? [lines[0], ''] : [];
  const rest = hasTitle ? lines.slice(1) : lines;
  // Цитата переносится построчно без обрамления: так она побайтово совпадает с реестром.
  const quoted = record.quote.split(/\r?\n/).map(line => '> ' + line);
  return [
    ...title,
    '## Основание',
    ...quoted,
    '',
    `Источник: запись реестра \`${record.id}\` v${record.version}, сообщение пользователя \`${record.episode}\`. Цитата перенесена из реестра без изменений.`,
    '',
    '## Интерпретация [?] — не подтверждено цитатой',
    '',
    'Ниже исходный текст документа без изменений. Статус «принято» относится к решению, а не к этим предложениям.',
    `<!-- huimem adr-audit ${date}: исходный текст начинается со следующей строки -->`,
    ...rest,
  ].join(eol);
}

export function plan(path: string, text: string, records: LatestRecord[], date: string): AuditItem {
  if (readBasis(text).section) return { path, state: 'has-basis' };
  const matched = records.filter(r => eligible(r.data) && mentions(r.data, path));
  if (!matched.length) return { path, state: 'no-match' };
  if (matched.length > 1) return { path, state: 'ambiguous', candidates: matched.map(r => r.id) };
  const r = matched[0];
  const rec = { id: r.id, version: r.version, episode: r.data.source.episode, quote: r.data.source.quote };
  return { path, state: 'migratable', recordId: rec.id, version: rec.version, episode: rec.episode, quote: rec.quote, proposed: migrate(text, rec, date),sourceHash:hash(text) };
}

// ---- Ввод-вывод ----
import { closeSync, fsyncSync, lstatSync, mkdirSync, readFileSync, writeFileSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safePath } from './core';

export const BACKUP_DIR = '.memory/adr-backup';
const hash=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');

// Check each directory before descending, so a pre-existing junction cannot send
// mkdir or the backup outside the project. Refuse links even when they point inside.
function backupDirectory(root:string,relative:string) {
  let current='';
  for(const part of relative.split('/')) {
    if(!part || part==='.' || part==='..') throw new Error('BACKUP_PATH');
    current=current ? current+'/'+part : part;
    const path=resolve(root,current);
    try { if(lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error('BACKUP_PATH: link or non-directory'); }
    catch(e:any) { if(e.code!=='ENOENT') throw e; mkdirSync(path); }
    safePath(root,current);
  }
}

export function publishPlan(root:string,item:Extract<AuditItem,{state:'migratable'}>,stamp:string) {
  if(!/^[A-Za-z0-9_-]+$/.test(stamp)) throw new Error('BACKUP_STAMP');
  if(!item.path.startsWith('.memory/adr/')) throw new Error('ADR_PATH');
  const source=safePath(root,item.path);
  const unchanged=()=>{
    if(!lstatSync(resolve(root,item.path)).isFile() || safePath(root,item.path)!==source)
      throw new Error('ADR_CHANGED: '+item.path);
    const bytes=readFileSync(source);
    if(hash(bytes)!==item.sourceHash) throw new Error('ADR_CHANGED: '+item.path);
    return bytes;
  };
  const original=unchanged();
  const backupRel=`${BACKUP_DIR}/${stamp}/${item.path.slice('.memory/adr/'.length)}`;
  backupDirectory(root,norm(dirname(backupRel)));
  const backup=resolve(root,backupRel);
  const backupFd=openSync(backup,'wx');
  try {writeFileSync(backupFd,original);fsyncSync(backupFd);} finally {closeSync(backupFd);}
  const temporary=resolve(dirname(source),`.huimem-adr-${randomUUID()}.tmp`);
  try {
    const fd=openSync(temporary,'wx');
    try {writeFileSync(fd,item.proposed,'utf8');fsyncSync(fd);} finally {closeSync(fd);}
    unchanged();
    renameSync(temporary,source);
  } finally {try {unlinkSync(temporary);} catch(e:any) {if(e.code!=='ENOENT') throw e;}}
  return {path:item.path,backup:backupRel,recordId:item.recordId};
}

export function listAdrs(root: string): string[] {
  return [...new Bun.Glob('.memory/adr/**/*.md').scanSync({ cwd: root, onlyFiles: true, followSymlinks: false })]
    .map(norm)
    .filter(p => p.split('/').pop()!.toLowerCase() !== 'readme.md')
    // Только обычный файл внутри проекта: ссылку переносить нельзя, запись ушла бы наружу.
    .filter(p => { try { return lstatSync(resolve(root, p)).isFile() && Boolean(safePath(root, p)); } catch { return false; } })
    .sort();
}

export function audit(root: string, records: LatestRecord[], date: string): AuditItem[] {
  return listAdrs(root).map(p => plan(p, readFileSync(resolve(root, p), 'utf8'), records, date));
}

// План строится заново из свежего чтения прямо перед записью: между показом и записью
// файл мог измениться, и переносить устаревший план нельзя.
export function apply(root: string, records: LatestRecord[], date: string, stamp: string) {
  const written: { path: string; backup: string; recordId: string }[] = [];
  const skipped: AuditItem[] = [];
  for (const item of audit(root, records, date)) {
    if (item.state !== 'migratable') { skipped.push(item); continue; }
    try {written.push(publishPlan(root,item,stamp));}
    catch(e:any) {
      if(String(e).includes('ADR_CHANGED')) skipped.push({path:item.path,state:'conflict',reason:String(e)});
      else throw e;
    }
  }
  return { written, skipped };
}
