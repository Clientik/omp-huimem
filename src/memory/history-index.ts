import { Database } from 'bun:sqlite';
import { chmodSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';

export type HistoryIndexStatus = { state:'cold'|'pending'|'ready'|'degraded'|'disabled'; path:string; entries?:number; error?:string };
export type IndexedEpisode = { id:string; role:string; time:string; length:number; sourceRowid:number };
const MARKER='huimem-history-1';
const encode=(word:string)=>'t'+Buffer.from(word,'utf8').toString('hex');

// The primary schema stays untouched so older plugins can still open it. Tokens,
// not another raw transcript, live in this disposable sidecar. Exact technical
// tokens are encoded before FTS tokenization (C#, C++ and Go stay distinct).
export class HistoryIndex {
  private db?:Database;
  private dirty:'rebuild'|'append'|undefined='rebuild';
  private lastRowid=0;
  private entries=0;
  private sideVersion=-1;
  private failure='';
  readonly path:string;
  constructor(private primary:Database,storageRoot:string,private tokenize:(text:string)=>string[],private exact:(term:string)=>boolean) {
    this.path=resolve(storageRoot,'.memory/runtime/search.sqlite');
  }
  close() {this.db?.close();this.db=undefined;}
  invalidate() {this.dirty='rebuild';}
  appended() {if(!this.dirty) this.dirty='append';}
  status():HistoryIndexStatus {
    return {state:this.failure?'degraded':!this.db?'cold':this.dirty?'pending':'ready',path:this.path,
      ...(this.db?{entries:this.entries}:{}),...(this.failure?{error:this.failure}:{})};
  }
  private open() {
    if(this.db) return this.db;
    try {
      const st=lstatSync(this.path);
      if(!st.isFile() || st.isSymbolicLink()) throw new Error('INDEX_PATH: expected a regular, non-symlink sidecar');
    } catch(e:any) {if(e.code!=='ENOENT') throw e;}
    const db=new Database(this.path,{create:true,strict:true});
    try {
      const tables=db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
      if(tables.length) {
        const marker=tables.some(t=>t.name==='meta') ? (db.query("SELECT value FROM meta WHERE key='format'").get() as any)?.value : undefined;
        if(marker!==MARKER || tables.some(t=>!['meta','documents','terms','terms_data','terms_idx','terms_docsize','terms_config'].includes(t.name)))
          throw new Error('INDEX_FOREIGN: preserve this file elsewhere before rebuilding the history index');
      }
      db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents(source_rowid INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,role TEXT,time TEXT,length INTEGER,tokens TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS terms USING fts5(tokens,content='documents',content_rowid='source_rowid');
        CREATE TRIGGER IF NOT EXISTS documents_insert AFTER INSERT ON documents BEGIN
          INSERT INTO terms(rowid,tokens) VALUES(new.source_rowid,new.tokens); END;
        CREATE TRIGGER IF NOT EXISTS documents_delete AFTER DELETE ON documents BEGIN
          INSERT INTO terms(terms,rowid,tokens) VALUES('delete',old.source_rowid,old.tokens); END;`);
      db.query("INSERT OR IGNORE INTO meta VALUES ('format',?)").run(MARKER);
      chmodSync(this.path,0o600);
      this.db=db;
      // A connection-local data_version is not a persistent source revision.
      // Reconcile on first use, including after rollback to an old plugin.
      this.dirty='rebuild';
      return db;
    } catch(e) {db.close();throw e;}
  }
  private synchronize() {
    if(this.failure) throw new Error(this.failure);
    try {
      const db=this.open();
      const version=(db.query('PRAGMA data_version').get() as any).data_version as number;
      if(this.sideVersion!==-1 && version!==this.sideVersion) this.dirty='rebuild';
      if(!this.dirty) return db;
      const rebuild=this.dirty==='rebuild';
      let last=this.lastRowid,added=0;
      // One source snapshot and one sidecar transaction: no half-indexed view.
      this.primary.transaction(()=>db.transaction(()=>{
        if(rebuild) {db.exec('DELETE FROM documents');last=0;}
        const rows=this.primary.query('SELECT rowid sourceRowid,id,role,time,text FROM episodes WHERE rowid>? ORDER BY rowid');
        const insert=db.query('INSERT INTO documents(source_rowid,id,role,time,length,tokens) VALUES(?,?,?,?,?,?)');
        for(const row of rows.iterate(last) as Iterable<{sourceRowid:number;id:string;role:string;time:string;text:string}>) {
          const tokens=[...new Set(this.tokenize(row.text))].map(encode).join(' ');
          insert.run(row.sourceRowid,row.id,row.role,row.time,row.text.length,tokens);
          last=row.sourceRowid;added++;
        }
      }).immediate()).deferred();
      this.lastRowid=last;
      this.entries=rebuild?added:this.entries+added;
      this.dirty=undefined;
      this.sideVersion=(db.query('PRAGMA data_version').get() as any).data_version;
      return db;
    } catch(e) {
      this.failure=String(e);
      throw e;
    }
  }
  rebuild():HistoryIndexStatus {
    this.failure='';this.dirty='rebuild';
    try {this.synchronize();} catch { /* status exposes the error; primary evidence remains untouched */ }
    return this.status();
  }
  find(terms:string[],role?:string,limit=500):{items:IndexedEpisode[];total:number} {
    const db=this.synchronize();
    const query=terms.map(t=>'"'+encode(t)+'"'+(this.exact(t)?'':'*')).join(' OR ');
    if(!query) return {items:[],total:0};
    const filter=role?' AND d.role=?':'';
    const args=role?[query,role]:[query];
    const total=(db.query('SELECT COUNT(*) n FROM terms JOIN documents d ON d.source_rowid=terms.rowid WHERE terms MATCH ?'+filter).get(...args) as any).n;
    const items=db.query('SELECT d.id,d.role,d.time,d.length,d.source_rowid sourceRowid FROM terms JOIN documents d ON d.source_rowid=terms.rowid WHERE terms MATCH ?'+filter+
      ' ORDER BY bm25(terms),d.time DESC,d.source_rowid DESC LIMIT ?').all(...args,Math.max(1,Math.min(500,limit))) as IndexedEpisode[];
    return {items,total};
  }
}
