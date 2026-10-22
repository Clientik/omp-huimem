import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { scrub, type MemoryStore } from './core';
import type { WikiRecordRef } from './wiki';

// One ledger in the existing primary database, not another fact store. Older
// schema-2 writers ignore these namespaced meta keys and keep their own tables.
const STATE_KEY='learning.v1', RECEIPT_PREFIX='learning.v1.receipt:';
const MAX_CHARACTERS=12000, MAX_SOURCES=8, CONTEXT_BEFORE=400;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const fail=(code:string,detail:string):never=>{throw new Error(`${code}: ${detail}`);};
type Cursor={position:number;id:string;offset:number;hash:string;complete:boolean};
type State={schema:1;cursor:Cursor|null;reviewedBatches:number;lastPacket:string|null};
export type LearningSource={id:string;role:'user'|'assistant';time:string;offset:number;endOffset:number;length:number;hash:string;text:string;contextBefore:string};
export type LearningReceipt={id:string;time:string;outcome:'recorded'|'nothing-durable';summary:string;records:WikiRecordRef[];sources:Omit<LearningSource,'text'|'contextBefore'>[];inputHash:string};
export type LearningCompletion={id:string;outcome:'recorded'|'nothing-durable';summary:string;records?:WikiRecordRef[]};
const nonnegative=(value:unknown):value is number=>typeof value==='number' && Number.isSafeInteger(value) && value>=0;
const digestPattern=/^[a-f0-9]{64}$/;
const object=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==='object' && !Array.isArray(value);
function isCursor(value:unknown):value is Cursor {
  return object(value) && nonnegative(value.position) && value.position>0 && typeof value.id==='string' && !!value.id
    && nonnegative(value.offset) && typeof value.hash==='string' && digestPattern.test(value.hash) && typeof value.complete==='boolean';
}
function isRef(value:unknown):value is WikiRecordRef {
  return object(value) && typeof value.id==='string' && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(value.id) && nonnegative(value.version) && value.version>0;
}
function isSourceRef(value:unknown):value is Omit<LearningSource,'text'|'contextBefore'> {
  return object(value) && typeof value.id==='string' && (value.role==='user' || value.role==='assistant') && typeof value.time==='string'
    && nonnegative(value.offset) && nonnegative(value.endOffset) && nonnegative(value.length) && value.offset<=value.endOffset && value.endOffset<=value.length
    && typeof value.hash==='string' && digestPattern.test(value.hash);
}
function isReceipt(value:unknown):value is LearningReceipt {
  return object(value) && typeof value.id==='string' && typeof value.time==='string' && (value.outcome==='recorded' || value.outcome==='nothing-durable')
    && typeof value.summary==='string' && typeof value.inputHash==='string' && digestPattern.test(value.inputHash)
    && Array.isArray(value.sources) && value.sources.every(isSourceRef) && Array.isArray(value.records) && value.records.every(isRef);
}
function readState(store:MemoryStore):State {
  // Fixed SELECT over the schema-owned TEXT column; parse its JSON below before use.
  const row=store.db.query('SELECT value FROM meta WHERE key=?').get(STATE_KEY) as {value:string}|null;
  if(!row) return {schema:1,cursor:null,reviewedBatches:0,lastPacket:null};
  let state:unknown;
  try {state=JSON.parse(row.value);} catch {return fail('LEARN_STATE','learning metadata is not valid JSON; preserve it for inspection');}
  if(!object(state) || state.schema!==1 || !nonnegative(state.reviewedBatches) || (state.lastPacket!==null && typeof state.lastPacket!=='string'))
    return fail('LEARN_STATE','unsupported or damaged learning metadata; preserve it for inspection');
  const cursor=state.cursor;
  if(cursor!==null && !isCursor(cursor)) return fail('LEARN_STATE','damaged learning cursor; do not reset it to skip sources');
  return {schema:1,cursor,reviewedBatches:state.reviewedBatches,lastPacket:state.lastPacket};
}
function anchor(store:MemoryStore,cursor:Cursor|null,checkText:boolean) {
  if(!cursor) return;
  // Column shapes are fixed by this schema-owned SELECT, not by external JSON.
  const row=store.db.query(`SELECT id${checkText?',text':''} FROM episodes WHERE rowid=?`).get(cursor.position) as {id:string;text?:string}|null;
  if(!row || row.id!==cursor.id || (checkText && (hash(row.text!)!==cursor.hash || cursor.offset>row.text!.length || (cursor.complete && cursor.offset!==row.text!.length))))
    fail('LEARN_STATE','the reviewed source anchor changed or disappeared; preserve original episodes and inspect the ledger');
}
function boundary(id:string) {
  const match=typeof id==='string' ? /^learn1:([1-9]\d*):(\d+):([a-f0-9]{64})$/.exec(id) : null;
  if(!match || !nonnegative(Number(match[1])) || !nonnegative(Number(match[2]))) return fail('LEARN_INPUT','use the exact packet id returned by learn action=next');
  return {position:Number(match[1]),offset:Number(match[2])};
}
function splits(text:string,at:number) {
  return at>0 && at<text.length && /[\uD800-\uDBFF]/.test(text[at-1]) && /[\uDC00-\uDFFF]/.test(text[at]);
}
function packet(store:MemoryStore,through?:{position:number;offset:number}) {
  const state=readState(store), before=state.cursor;
  anchor(store,before,true);
  const sources:LearningSource[]=[];
  let characters=0, after=before;
  const comparison=before && !before.complete ? '>=' : '>';
  // A bounded reader exits early. Own and finalize its statement: Bun's cached
  // query iterator retains its cursor after break and cannot safely be rebound.
  const statement=store.db.prepare(`SELECT rowid AS position,id,role,time,text FROM episodes WHERE rowid ${comparison} ? AND rowid<=? ORDER BY rowid LIMIT ?`);
  try {
    // Column shapes are fixed by the schema-owned SELECT above.
    const rows=statement.iterate(before?.position ?? 0,through?.position ?? Number.MAX_SAFE_INTEGER,MAX_SOURCES) as
      Iterable<{position:number;id:string;role:'user'|'assistant';time:string;text:string}>;
    for(const row of rows) {
      if(row.role!=='user' && row.role!=='assistant') fail('LEARN_STATE',`source ${row.id} has an unsupported original role`);
      const offset=before && row.position===before.position ? before.offset : 0;
      if(splits(row.text,offset)) fail('LEARN_STATE','source cursor splits a UTF-16 surrogate pair');
      let contextAt=Math.max(0,offset-CONTEXT_BEFORE);
      if(splits(row.text,contextAt)) contextAt--;
      const contextBefore=row.text.slice(contextAt,offset), left=MAX_CHARACTERS-characters-contextBefore.length;
      if(left<2 && row.text.length>offset) break;
      let endOffset=Math.min(row.text.length,offset+left,through?.position===row.position ? through.offset : Infinity);
      if(endOffset<offset) break;
      if(splits(row.text,endOffset)) endOffset--;
      const text=row.text.slice(offset,endOffset), sourceHash=hash(row.text);
      sources.push({id:row.id,role:row.role,time:row.time,offset,endOffset,length:row.text.length,hash:sourceHash,text,contextBefore});
      after={position:row.position,id:row.id,offset:endOffset,hash:sourceHash,complete:endOffset===row.text.length};
      characters+=contextBefore.length+text.length;
      if(!after.complete || characters>=MAX_CHARACTERS) break;
    }
  } finally {statement.finalize();}
  // The upper boundary is encoded in the offer. Appended messages cannot enlarge
  // that offer between next and complete; no reservation write or lease is needed.
  const sourceRefs=sources.map(({text:_,contextBefore:__,...source})=>source);
  const fingerprint=hash(JSON.stringify({schema:1,scope:resolve(store.storageRoot),before,sources:sourceRefs}));
  const id=sources.length ? `learn1:${after!.position}:${after!.offset}:${fingerprint}` : null;
  return {state,after,view:{id,sources,characters,characterLimit:MAX_CHARACTERS,sourceLimit:MAX_SOURCES,coverageIsNotEvidence:true as const}};
}
export function learningStatus(store:MemoryStore) {
  const state=readState(store), cursor=state.cursor;
  anchor(store,cursor,false);
  // COUNT always returns one numeric row for this fixed aggregate.
  const count=store.db.query('SELECT COUNT(*) n FROM episodes WHERE rowid>?').get(cursor?.position ?? 0) as {n:number};
  const pending=count.n+(cursor && !cursor.complete ? 1 : 0);
  return {pendingSources:pending,partialSource:!!cursor && !cursor.complete,reviewedBatches:state.reviewedBatches,lastPacket:state.lastPacket,coverageIsNotEvidence:true as const};
}
export function learningNext(store:MemoryStore) {return packet(store).view;}
export function learningRead(store:MemoryStore,id:string):LearningReceipt & {found:true;coverageIsNotEvidence:true} | {id:string;found:false} {
  boundary(id);
  // Fixed SELECT over the schema-owned TEXT column; validate the persisted JSON.
  const row=store.db.query('SELECT value FROM meta WHERE key=?').get(RECEIPT_PREFIX+id) as {value:string}|null;
  if(!row) return {id,found:false};
  let receipt:unknown;
  try {receipt=JSON.parse(row.value);} catch {return fail('LEARN_STATE','review receipt is damaged; preserve it for inspection');}
  if(!isReceipt(receipt) || receipt.id!==id) return fail('LEARN_STATE','review receipt is invalid; preserve it for inspection');
  return {...receipt,found:true,coverageIsNotEvidence:true};
}
export function learningComplete(store:MemoryStore,input:LearningCompletion,signal?:AbortSignal) {
  const cancelled=()=>{if(signal?.aborted) fail('LEARN_ABORTED','the review was cancelled; coverage was not advanced');};
  cancelled();
  const through=boundary(input.id), refs=input.records ?? [];
  if(!['recorded','nothing-durable'].includes(input.outcome) || typeof input.summary!=='string' || !input.summary.trim() || input.summary.length>2000 || scrub(input.summary)!==input.summary
    || !Array.isArray(refs) || refs.length>30 || (input.outcome==='recorded' ? refs.length===0 : refs.length!==0))
    fail('LEARN_INPUT','supply outcome=recorded with 1–30 checked record versions, or nothing-durable with no records, and a non-secret review summary of 1–2000 characters');
  const seen=new Set<string>();
  for(const ref of refs) {
    if(!isRef(ref) || seen.has(ref.id)) fail('LEARN_INPUT','record references need distinct existing IDs and exact positive versions');
    seen.add(ref.id);
  }
  const records=refs.map(({id,version})=>({id,version})).sort((a,b)=>a.id.localeCompare(b.id));
  const inputHash=hash(JSON.stringify({outcome:input.outcome,summary:input.summary,records}));
  return store.db.transaction(()=>{
    cancelled();
    const previous=learningRead(store,input.id);
    if(previous.found) {
      if(previous.inputHash!==inputHash) fail('LEARN_CONFLICT','this packet already has a different review result; read its receipt instead of replacing it');
      const {found:_,coverageIsNotEvidence:__,...receipt}=previous;
      return {unchanged:true,receipt,coverageIsNotEvidence:true as const};
    }
    const current=packet(store,through);
    if(!current.view.id || current.view.id!==input.id) fail('LEARN_CONFLICT','the packet sources or coverage prefix changed; request next again and review the current packet');
    for(const ref of records) {
      const record=store.current(ref.id), evidence=store.verifyRecord(ref.id);
      if(!record || record.version!==ref.version || record.freshness==='STALE' || !('match' in evidence) || evidence.match!==true)
        fail('LEARN_RECORD',`${ref.id} v${ref.version} is missing, changed, STALE or unsupported by its source; recall and check it before completing`);
    }
    const receipt:LearningReceipt={id:input.id,time:new Date().toISOString(),outcome:input.outcome,summary:input.summary,records,
      sources:current.view.sources.map(({text:_,contextBefore:__,...source})=>source),inputHash};
    const state:State={schema:1,cursor:current.after,reviewedBatches:current.state.reviewedBatches+1,lastPacket:input.id};
    cancelled();
    store.db.query('INSERT INTO meta(key,value) VALUES(?,?)').run(RECEIPT_PREFIX+input.id,JSON.stringify(receipt));
    store.db.query('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(STATE_KEY,JSON.stringify(state));
    return {unchanged:false,receipt,coverageIsNotEvidence:true as const};
  }).immediate();
}
