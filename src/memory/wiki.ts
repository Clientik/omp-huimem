import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { MemoryStore, normalizedRecordText, scrub, type CurrentRecord } from './core';

const DIRECTORY='.memory/wiki';
const MAX_BODY=12000, MAX_FILE=65536, MAX_SOURCES=20, MAX_SCAN=200, MAX_LIST=50;
const MARKER='<!-- huimem-wiki:v1 ';
const NOTICE='Derived interpretation, not independent evidence or proof of rationale. Source status and authority are not promoted by this page.';
const SOURCE_STATUSES:Record<string,readonly string[]>={fact:['active'],decision:['accepted'],procedure:['active'],navigation:['active'],task:['todo','doing','blocked','done'],question:['open','answered']};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const fail=(code:string,detail:string):never=>{ throw new Error(`${code}: ${detail}`); };
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
const address=(id:string)=>`project_memory op=wiki action=read id=${id}`;

export type WikiRecordRef={id:string;version:number};
export type WikiPublishInput={id:string;title:string;body:string;records:WikiRecordRef[];expectedHash?:string};
type StoredSource=WikiRecordRef & {kind:string;status:string;recordHash:string;evidenceHash:string};
type Metadata={schema:1;id:string;title:string;bodyLength:number;records:StoredSource[];hash:string};
export type WikiSource=WikiRecordRef & {kind:string;status:string;currentVersion:number|null;valid:boolean;evidence:boolean;freshness:'current'|'STALE';reasons:string[];read:string};
export type WikiPage={id:string;title:string;body:string;hash:string;freshness:'current'|'STALE';sources:WikiSource[];derived:true;read:string;path:string};
export type WikiReadResult=Partial<WikiPage> & {id:string;found:boolean;freshness:'current'|'STALE';error?:string};
export type WikiIssue={id?:string;code:string;detail:string};
type SourceCheck={record:CurrentRecord|null;evidence?:unknown};
type SourceChecks=Pick<Map<string,SourceCheck>,'get'>;
// A synchronous read owns this cache. Publication never reuses it across
// validation phases; the next read checks current files and versions again.
function readChecks(store:MemoryStore):SourceChecks {
  const records=new Map<string,SourceCheck>();
  let authority:ReturnType<MemoryStore['authority']>|undefined;
  const getAuthority=()=>authority ??= store.authority();
  return {get(id) {
    let check=records.get(id);
    if(!check) {check={record:store.current(id,getAuthority)};records.set(id,check);}
    return check;
  }};
}

function validateID(id:string) {
  if(typeof id!=='string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id)) fail('WIKI_ID','use a lowercase ASCII slug of at most 80 characters');
}
function validateRefs(refs:WikiRecordRef[]) {
  if(!Array.isArray(refs) || !refs.length || refs.length>MAX_SOURCES) fail('WIKI_SOURCE',`supply 1–${MAX_SOURCES} exact record/version references`);
  const seen=new Set<string>();
  for(const ref of refs) {
    if(!ref || typeof ref.id!=='string' || !/^[a-zA-Z0-9_.:/-]{1,100}$/.test(ref.id) || !Number.isSafeInteger(ref.version) || ref.version<1 || seen.has(ref.id))
      fail('WIKI_SOURCE','invalid or duplicate record/version reference');
    seen.add(ref.id);
  }
}
function inputCheck(input:WikiPublishInput) {
  validateID(input.id); validateRefs(input.records);
  if(typeof input.title!=='string' || !input.title.trim() || input.title.length>160 || /[\r\n\x00-\x1f]/.test(input.title)) fail('WIKI_TITLE','supply a single-line title of 1–160 characters');
  if(typeof input.body!=='string' || !input.body.trim() || input.body.length>MAX_BODY || /\x00/.test(input.body)) fail('WIKI_BODY',`supply a nonempty interpretation of at most ${MAX_BODY} UTF-16 units`);
  if(scrub(input.body)!==input.body || scrub(input.title)!==input.title) fail('WIKI_SECRET','remove secrets before publishing');
  if(input.expectedHash!==undefined && !/^[0-9a-f]{64}$/.test(input.expectedHash)) fail('WIKI_CONFLICT','expectedHash must be the hash returned by wiki read');
}

// Refuse symlinks at every component, even links pointing back inside the root.
// This keeps a curated output directory from becoming an alternate file writer.
function guardedDirectory(store:MemoryStore,create=false):string|null {
  const base=realpathSync(store.storageRoot);
  let path=base;
  for(const part of ['.memory','wiki']) {
    path=resolve(path,part);
    let st;
    try { st=lstatSync(path); }
    catch(error) {
      if(!missing(error)) throw error;
      if(!create) return null;
      try { mkdirSync(path,{mode:0o700}); } catch(e) { if((e as NodeJS.ErrnoException).code!=='EEXIST') throw e; }
      st=lstatSync(path);
    }
    if(!st.isDirectory() || st.isSymbolicLink() || realpathSync(path)!==path) fail('WIKI_PATH','wiki components must be ordinary directories inside storageRoot');
  }
  return path;
}
function readBytes(path:string):string|null {
  try {
    const st=lstatSync(path);
    if(!st.isFile() || st.isSymbolicLink()) fail('WIKI_PATH','page must be an ordinary file');
    if(st.size>MAX_FILE) fail('WIKI_CORRUPT','page exceeds the bounded file size');
    return readFileSync(path,'utf8');
  } catch(error) { if(missing(error)) return null; throw error; }
}
function prefix(title:string) { return `# ${title}\n\n${NOTICE}\n\n`; }
function encode(id:string,title:string,body:string,records:StoredSource[]) {
  const meta:Omit<Metadata,'hash'>={schema:1,id,title,bodyLength:body.length,records};
  const rest=prefix(title)+body+'\n\n## Source records (versions pinned by huimem)\n'+
    records.map(r=>`- ${r.id} v${r.version} (${r.kind}, ${r.status}): project_memory op=recall id=${r.id}`).join('\n')+'\n';
  const hash=digest(JSON.stringify(meta)+'\n'+rest);
  return {hash,bytes:MARKER+JSON.stringify({...meta,hash})+' -->\n'+rest};
}
function decode(bytes:string,id:string):{meta:Metadata;body:string} {
  try {
    const end=bytes.indexOf(' -->\n');
    if(!bytes.startsWith(MARKER) || end<0 || end>16000) throw new Error('missing runtime header');
    const meta=JSON.parse(bytes.slice(MARKER.length,end)) as Metadata;
    if(meta.schema!==1 || meta.id!==id || typeof meta.title!=='string' || !Number.isSafeInteger(meta.bodyLength) || meta.bodyLength<1 || meta.bodyLength>MAX_BODY || !/^[0-9a-f]{64}$/.test(meta.hash)) throw new Error('invalid runtime header');
    validateRefs(meta.records);
    if(meta.records.some(r=>typeof r.kind!=='string' || typeof r.status!=='string' || !/^[0-9a-f]{64}$/.test(r.recordHash) || !/^[0-9a-f]{64}$/.test(r.evidenceHash))) throw new Error('invalid source fingerprints');
    const rest=bytes.slice(end+' -->\n'.length), start=prefix(meta.title);
    if(!rest.startsWith(start)) throw new Error('edited header');
    const body=rest.slice(start.length,start.length+meta.bodyLength);
    const encoded=encode(id,meta.title,body,meta.records);
    if(encoded.bytes!==bytes) throw new Error('digest or generated content mismatch');
    inputCheck({id,title:meta.title,body,records:meta.records});
    return {meta,body};
  } catch(error) { return fail('WIKI_CORRUPT',`not an intact huimem-owned page; preserve human edits separately (${String(error).slice(0,180)})`); }
}
function sourceState(store:MemoryStore,ref:WikiRecordRef,stored?:StoredSource,checks?:SourceChecks):{view:WikiSource;snapshot?:StoredSource} {
  const check=checks?.get(ref.id), record=check ? check.record : store.current(ref.id);
  const evidence=check?.evidence ?? store.verifyRecord(ref.id);
  if(check) check.evidence=evidence;
  const reasons:string[]=[];
  if(!record) reasons.push('record missing');
  else {
    if(record.version!==ref.version) reasons.push(`version ${ref.version} changed to ${record.version}`);
    if(record.freshness==='STALE') reasons.push(...(record.staleReasons ?? ['record is STALE']));
    if(SOURCE_STATUSES[record.kind]?.includes(record.status)!==true) reasons.push(`unsupported source kind/status ${record.kind}/${record.status}`);
  }
  const confirmed=!!evidence && typeof evidence==='object' && 'match' in evidence && evidence.match===true;
  if(!confirmed) reasons.push('source evidence is unconfirmed');
  const snapshot=record ? {id:ref.id,version:record.version,kind:record.kind,status:record.status,recordHash:digest(JSON.stringify(record)),evidenceHash:digest(JSON.stringify(evidence))} : undefined;
  if(stored && snapshot && (stored.recordHash!==snapshot.recordHash || stored.evidenceHash!==snapshot.evidenceHash)) reasons.push('source fingerprint changed');
  const valid=reasons.length===0;
  return {view:{id:ref.id,version:ref.version,kind:stored?.kind ?? record?.kind ?? 'unknown',status:stored?.status ?? record?.status ?? 'unknown',currentVersion:record?.version ?? null,valid,evidence:confirmed,freshness:valid?'current':'STALE',reasons:reasons.slice(0,8),read:`project_memory op=recall id=${ref.id}`},snapshot};
}
function verifiedSources(store:MemoryStore,refs:WikiRecordRef[]) {
  return refs.map(ref=>{
    const state=sourceState(store,ref);
    if(!state.view.valid || !state.snapshot) return fail('WIKI_SOURCE',`${ref.id} v${ref.version}: ${state.view.reasons.join('; ')}`);
    return state.snapshot;
  });
}
function view(store:MemoryStore,meta:Metadata,body:string,checks?:SourceChecks):WikiPage {
  const sources=meta.records.map(ref=>sourceState(store,ref,ref,checks).view);
  return {id:meta.id,title:meta.title,body,hash:meta.hash,freshness:sources.every(s=>s.valid)?'current':'STALE',sources,derived:true,read:address(meta.id),path:`${DIRECTORY}/${meta.id}.md`};
}

function readPage(store:MemoryStore,id:string,checks?:SourceChecks):WikiReadResult {
  validateID(id);
  try {
    const directory=guardedDirectory(store);
    const bytes=directory ? readBytes(resolve(directory,`${id}.md`)) : null;
    if(bytes===null) return {id,found:false,freshness:'STALE'};
    const {meta,body}=decode(bytes,id);
    return {...view(store,meta,body,checks ?? readChecks(store)),found:true};
  } catch(error) { return {id,found:true,freshness:'STALE',error:String(error).slice(0,400),derived:true,read:address(id),path:`${DIRECTORY}/${id}.md`}; }
}
export function wikiRead(store:MemoryStore,id:string):WikiReadResult {
  return store.db.transaction(()=>readPage(store,id)).deferred();
}
function directoryIDs(store:MemoryStore):{ids:string[];truncated:boolean;issues:WikiIssue[]} {
  const directory=guardedDirectory(store);
  if(!directory) return {ids:[],truncated:false,issues:[]};
  const dir=opendirSync(directory), ids:string[]=[], issues:WikiIssue[]=[];
  let scanned=0,truncated=false;
  try {
    for(let entry;(entry=dir.readSync())!==null;) {
      if(++scanned>MAX_SCAN) { truncated=true; break; }
      if(!entry.name.endsWith('.md')) continue;
      const id=entry.name.slice(0,-3);
      if(!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id)) { issues.push({code:'WIKI_ID',detail:`Invalid wiki filename: ${entry.name.slice(0,100)}`}); continue; }
      ids.push(id);
    }
  } finally { dir.closeSync(); }
  return {ids:ids.sort(),truncated,issues};
}
export function wikiList(store:MemoryStore,query='',limit=20) {
  if(typeof query!=='string' || query.length>1000) fail('WIKI_QUERY','query must be at most 1000 characters');
  if(!Number.isSafeInteger(limit) || limit<1) fail('WIKI_LIMIT','limit must be a positive safe integer');
  return store.db.transaction(()=>{
    const cap=Math.min(limit,MAX_LIST), pages:Omit<WikiPage,'body'>[]=[], issues:WikiIssue[]=[];
    let scanned;
    try { scanned=directoryIDs(store); }
    catch(error) { return {pages,issues:[{code:'WIKI_PATH',detail:String(error).slice(0,400)}],truncated:false}; }
    const terms=query.toLocaleLowerCase().split(/\s+/).filter(Boolean), checks=readChecks(store);
    let matches=0;
    for(const id of scanned.ids) {
      const page=readPage(store,id,checks);
      if(page.error) { issues.push({id,code:'WIKI_CORRUPT',detail:page.error}); continue; }
      if(!page.found || !page.title || !page.sources) continue;
      const text=`${id}\n${page.title}\n${page.body}`.toLocaleLowerCase();
      if(!terms.every(term=>text.includes(term))) continue;
      matches++;
      if(pages.length<cap) { const {body:_,found:__,...summary}=page; pages.push(summary as Omit<WikiPage,'body'>); }
    }
    return {pages,issues:[...scanned.issues,...issues].slice(0,100),truncated:scanned.truncated || matches>cap};
  }).deferred();
}
export function wikiLint(store:MemoryStore) {
  return store.db.transaction(()=>{
    const issues:WikiIssue[]=[];
    let scanned;
    try { scanned=directoryIDs(store); }
    catch(error) { return {checked:0,issues:[{code:'WIKI_PATH',detail:String(error).slice(0,400)}],truncated:false}; }
    issues.push(...scanned.issues);
    const checks=readChecks(store);
    for(const id of scanned.ids) {
      const page=readPage(store,id,checks);
      if(page.error) issues.push({id,code:'WIKI_CORRUPT',detail:page.error});
      else if(!page.found || page.freshness==='STALE') issues.push({id,code:'WIKI_STALE',detail:page.sources?.filter(s=>!s.valid).map(s=>`${s.id} v${s.version}: ${s.reasons.join('; ')}`).join('\n').slice(0,1000) ?? 'page disappeared'});
    }
    return {checked:scanned.ids.length,issues:issues.slice(0,100),truncated:scanned.truncated || issues.length>100};
  }).deferred();
}
// Pages that cite one of `ids` and are STALE because of it. Reads only when a Wiki directory exists.
export function wikiStaleFor(store:MemoryStore,ids:string[],limit=10) {
  const wanted=new Set(ids), pages:{id:string;title:string;hash:string;read:string;sources:{id:string;version:number;currentVersion:number|null;reasons:string[]}[]}[]=[];
  if(!wanted.size || !guardedDirectory(store)) return {pages,truncated:false};
  return store.db.transaction(()=>{
    const scanned=directoryIDs(store), checks=readChecks(store);
    let matched=0;
    for(const id of scanned.ids) {
      const page=readPage(store,id,checks);
      if(page.error || !page.found || page.freshness!=='STALE' || !page.sources || !page.title || !page.hash || !page.read) continue;
      const sources=page.sources.filter(source=>wanted.has(source.id) && !source.valid)
        .map(({id,version,currentVersion,reasons})=>({id,version,currentVersion,reasons}));
      if(!sources.length) continue;
      if(++matched<=limit) pages.push({id,title:page.title,hash:page.hash,read:page.read,sources});
    }
    return {pages,truncated:scanned.truncated || matched>limit};
  }).deferred();
}

// Workbench projections reuse record versions and edges. No parallel entity
// store, model-authored authority, Markdown link parser or hidden worker.
function workbench(store:MemoryStore) {
  const records=store.inspectRecords(), checks:SourceChecks=new Map(records.map(row=>[row.id,{record:{
    ...row.data,version:row.version,freshness:row.staleReasons.length ? 'STALE' : 'source unchanged or conversation',
    ...(row.staleReasons.length ? {staleReasons:row.staleReasons} : {}),
  }}]));
  const pages:WikiPage[]=[], issues:WikiIssue[]=[];
  let truncated=false;
  try {
    const scanned=directoryIDs(store);
    truncated=scanned.truncated;issues.push(...scanned.issues);
    for(const id of scanned.ids) {
      const page=readPage(store,id,checks);
      if(page.error) issues.push({id,code:'WIKI_CORRUPT',detail:page.error});
      else if(page.found && page.sources && page.title && page.body && page.hash) {
        // readPage builds the complete in-process WikiPage view on this success branch.
        const complete=page as WikiPage;
        pages.push(complete);
      }
    }
  } catch(error) {issues.push({code:'WIKI_PATH',detail:String(error).slice(0,400)});truncated=true;}
  return {records,checks,pages,issues,truncated};
}
function workLimit(limit:number) {
  if(!Number.isSafeInteger(limit) || limit<1) fail('WIKI_LIMIT','limit must be a positive safe integer');
  return Math.min(limit,MAX_LIST);
}
export function wikiPlan(store:MemoryStore,query='',limit=20) {
  const cap=workLimit(limit);
  if(typeof query!=='string' || query.length>1000) fail('WIKI_QUERY','query must be at most 1000 characters');
  const terms=query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches=(text:string)=>terms.every(term=>text.toLocaleLowerCase().includes(term));
  const snapshot=workbench(store), covered=new Set<string>();
  for(const page of snapshot.pages) if(page.freshness==='current')
    for(const source of page.sources) covered.add(`${source.id}@${source.version}`);
  const uncovered:unknown[]=[], review:unknown[]=[], groups=new Map<string,WikiRecordRef[]>();
  for(const row of snapshot.records) {
    const record=row.data;
    if(record.status==='retired' || !matches(`${row.id}\n${record.text}`)) continue;
    const summary={id:row.id,version:row.version,kind:record.kind,status:record.status,preview:record.text.slice(0,240),read:`project_memory op=recall id=${row.id}`};
    const state=sourceState(store,{id:row.id,version:row.version},undefined,snapshot.checks);
    if(!state.view.valid) {review.push({...summary,reasons:state.view.reasons});continue;}
    if(!covered.has(`${row.id}@${row.version}`)) uncovered.push(summary);
    const key=JSON.stringify([record.kind,record.status,normalizedRecordText(record.text)]);
    const group=groups.get(key) ?? [];
    group.push({id:row.id,version:row.version});groups.set(key,group);
  }
  const updates=snapshot.pages.filter(page=>page.freshness==='STALE' && matches(`${page.id}\n${page.title}\n${page.sources.map(source=>source.id).join(' ')}`))
    .map(({id,title,hash,sources,read})=>({id,title,hash,read,sources:sources.filter(source=>!source.valid)}));
  const duplicates=[...groups.values()].filter(group=>group.length>1)
    .map(records=>({records,reason:'Same kind, status and normalized text; compare sources before any deliberate merge. No deletion or semantic equivalence is implied.'}));
  return {derived:true,coverageIsNotEvidence:true,sourceCoverageComplete:!snapshot.truncated && snapshot.issues.length===0,
    scanned:{records:snapshot.records.length,pages:snapshot.pages.length},
    counts:{uncovered:uncovered.length,updates:updates.length,review:review.length,duplicates:duplicates.length},
    uncovered:uncovered.slice(0,cap),updates:updates.slice(0,cap),review:review.slice(0,cap),duplicates:duplicates.slice(0,cap),issues:snapshot.issues.slice(0,100),
    truncated:snapshot.truncated || snapshot.issues.length>100 || [uncovered,updates,review,duplicates].some(items=>items.length>cap)};
}
type WikiEdge={kind:'shared-source'|'links'|'dependsOn';direction:'shared'|'incoming'|'outgoing';from:string;to:string};
export function wikiDiscover(store:MemoryStore,id:string,limit=20) {
  validateID(id);
  const cap=workLimit(limit), snapshot=workbench(store), seed=snapshot.pages.find(page=>page.id===id);
  if(!seed) {
    const issue=snapshot.issues.find(issue=>issue.id===id);
    return {id,found:!!issue,...(issue ? {error:issue.detail,freshness:'STALE'} : {}),derived:true,
      issues:snapshot.issues.slice(0,100),truncated:snapshot.truncated || snapshot.issues.length>100};
  }
  const sourceIDs=new Set(seed.sources.map(source=>source.id));
  const related:{id:string;title:string;freshness:WikiPage['freshness'];read:string;via:WikiEdge[]}[]=[];
  const edges=(page:WikiPage)=>{
    const result:{kind:'links'|'dependsOn';from:string;to:string}[]=[];
    for(const source of page.sources) {
      if(!source.valid) continue; // An old page cannot acquire edges from a newer record version.
      const record=snapshot.checks.get(source.id)?.record;
      if(!record || record.version!==source.version) continue;
      for(const to of record.links ?? []) result.push({kind:'links',from:source.id,to});
      for(const dependency of record.dependsOn ?? []) if('id' in dependency) result.push({kind:'dependsOn',from:source.id,to:dependency.id});
    }
    return result;
  };
  const outgoing=edges(seed);
  for(const page of snapshot.pages) {
    if(page.id===id) continue;
    const targets=new Set(page.sources.map(source=>source.id)), via:WikiEdge[]=[];
    for(const source of sourceIDs) if(targets.has(source)) via.push({kind:'shared-source',direction:'shared',from:source,to:source});
    for(const edge of outgoing) if(targets.has(edge.to)) via.push({...edge,direction:'outgoing'});
    for(const edge of edges(page)) if(sourceIDs.has(edge.to)) via.push({...edge,direction:'incoming'});
    if(via.length) {
      const unique=new Map(via.map(edge=>[JSON.stringify(edge),edge]));
      related.push({id:page.id,title:page.title,freshness:page.freshness,read:page.read,via:[...unique.values()]});
    }
  }
  return {id,found:true,freshness:seed.freshness,derived:true,connectionsAreNotEvidence:true,
    related:related.slice(0,cap),issues:snapshot.issues.slice(0,100),truncated:snapshot.truncated || related.length>cap || snapshot.issues.length>100};
}
function syncDirectory(path:string) {
  let fd:number|undefined;
  try { fd=openSync(path,'r'); fsyncSync(fd); }
  catch(error) {
    // Windows does not expose directory fsync through Node. File fsync and atomic rename still apply.
    if(!['EINVAL','EPERM','EISDIR','EBADF','ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { if(fd!==undefined) closeSync(fd); }
}

export function wikiPublish(store:MemoryStore,input:WikiPublishInput):WikiPage & {unchanged:boolean} {
  inputCheck(input);
  // Verify before creating any output directory, then again under the SQLite writer lock.
  verifiedSources(store,input.records);
  const directory=guardedDirectory(store,true)!, path=resolve(directory,`${input.id}.md`);
  let temp:string|undefined;
  // Mutual exclusion is the scope database's immediate writer transaction, shared by every publisher of this Wiki.
  try {
    return store.db.transaction(()=>{
      const records=verifiedSources(store,input.records), encoded=encode(input.id,input.title,input.body,records);
      if(Buffer.byteLength(encoded.bytes,'utf8')>MAX_FILE) fail('WIKI_BODY','encoded page exceeds the bounded file size');
      const before=readBytes(path), old=before===null ? null : decode(before,input.id);
      if(input.expectedHash!==undefined && old?.meta.hash!==input.expectedHash) fail('WIKI_CONFLICT','expectedHash differs from current page');
      if(before===encoded.bytes) return {...view(store,old!.meta,old!.body),unchanged:true};
      if(before!==null && input.expectedHash===undefined) fail('WIKI_CONFLICT','read the existing page and provide expectedHash before replacing it');
      temp=resolve(directory,`.${input.id}-${randomUUID()}.tmp`);
      const fd=openSync(temp,'wx',0o600);
      try { writeFileSync(fd,encoded.bytes,'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
      if(guardedDirectory(store)!==directory || readBytes(path)!==before) fail('WIKI_CONFLICT','page changed during publication');
      const checked=verifiedSources(store,input.records);
      if(JSON.stringify(checked)!==JSON.stringify(records)) fail('WIKI_SOURCE','source changed during publication');
      // A hard link is an atomic no-clobber creation. Existing owned pages use a guarded rename.
      if(before===null) {
        try { linkSync(temp,path); } catch(error) { if((error as NodeJS.ErrnoException).code==='EEXIST') return fail('WIKI_CONFLICT','page appeared during publication'); throw error; }
        unlinkSync(temp); temp=undefined;
      } else { renameSync(temp,path); temp=undefined; }
      syncDirectory(directory);
      const {meta,body}=decode(encoded.bytes,input.id);
      return {...view(store,meta,body),unchanged:false};
    }).immediate();
  } finally { if(temp) unlinkSync(temp); }
}

export type GitCommit={commit:string;author:string;time:string;subject:string};
function historyPath(root:string,path:string) {
  if(typeof path!=='string' || !path || path.length>1000 || path.includes('\0') || isAbsolute(path) || /^[a-z]:/i.test(path) || path.split(/[\\/]/).some(part=>part==='..')) fail('GIT_PATH','use a relative path inside the evidence root');
  const base=realpathSync(root), full=resolve(base,path), rel=relative(base,full);
  if(!rel || rel.startsWith('..') || isAbsolute(rel)) fail('GIT_PATH','use a file or directory path inside the evidence root');
  let current=base;
  for(const part of rel.split(/[\\/]/)) {
    current=resolve(current,part);
    try { if(lstatSync(current).isSymbolicLink()) fail('GIT_PATH','symlink paths are not supported'); }
    catch(error) { if(missing(error)) break; throw error; }
  }
  return {base,path:rel.replaceAll('\\','/')};
}

export async function gitHistory(root:string,path:string,limit=10,signal?:AbortSignal):Promise<{path:string;commits:GitCommit[];historyNotRationale:true;truncated:boolean}> {
  const selected=historyPath(root,path);
  if(!Number.isSafeInteger(limit) || limit<1) fail('GIT_LIMIT','limit must be a positive safe integer');
  if(signal?.aborted) fail('GIT_ABORTED','history request aborted');
  const cap=Math.min(50,limit), maxBytes=65536;
  const {promise,resolve:resolveResult,reject}=Promise.withResolvers<{path:string;commits:GitCommit[];historyNotRationale:true;truncated:boolean}>();
    const child=spawn('git',['--no-pager','--literal-pathspecs','log','--no-show-signature','--no-mailmap',`-n${cap+1}`,'--format=%H%x00%an%x00%aI%x00%s%x00','--',selected.path],{cwd:selected.base,windowsHide:true,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'},stdio:['ignore','pipe','pipe']});
    const chunks:Buffer[]=[], errors:Buffer[]=[];
    let bytes=0,errorBytes=0,stopped:Error|undefined;
    const stop=(code:string,detail:string)=>{ if(!stopped) { stopped=new Error(`${code}: ${detail}`); child.kill(); } };
    const abort=()=>stop('GIT_ABORTED','history request aborted');
    const timer=setTimeout(()=>stop('GIT_TIMEOUT','local history exceeded five seconds'),5000);
    signal?.addEventListener('abort',abort,{once:true});
    const cleanup=()=>{ clearTimeout(timer); signal?.removeEventListener('abort',abort); };
    child.stdout.on('data',(chunk:Buffer)=>{ bytes+=chunk.length; if(bytes>maxBytes) stop('GIT_OUTPUT','history exceeded 64 KiB; request fewer commits'); else chunks.push(chunk); });
    child.stderr.on('data',(chunk:Buffer)=>{ errorBytes+=chunk.length; if(errorBytes<=4096) errors.push(chunk); });
    child.on('error',error=>{ cleanup(); reject(stopped ?? new Error(`GIT_HISTORY: ${error.message}`)); });
    child.on('close',code=>{
      cleanup();
      if(stopped) { reject(stopped); return; }
      if(code!==0) { reject(new Error(`GIT_HISTORY: ${Buffer.concat(errors).toString('utf8').trim().slice(0,500) || `git exited ${code}`}`)); return; }
      const parts=Buffer.concat(chunks).toString('utf8').split('\0'), commits:GitCommit[]=[];
      try {
        for(let at=0;at+3<parts.length;at+=4) {
          const commit=parts[at].trim(), author=parts[at+1], time=parts[at+2], subject=parts[at+3];
          if(!/^[0-9a-f]{40,64}$/.test(commit) || !/^\d{4}-\d\d-\d\dT/.test(time)) fail('GIT_HISTORY','unexpected git log output');
          commits.push({commit,author,time,subject});
        }
        resolveResult({path:selected.path,commits:commits.slice(0,cap),historyNotRationale:true,truncated:commits.length>cap});
      } catch(error) { reject(error); }
    });
    if(signal?.aborted) abort();
  return promise;
}
