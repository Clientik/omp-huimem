import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/core';
import { wikiPublish, wikiRead, wikiList, wikiLint, gitHistory } from '../src/memory/wiki';

function fixture(fn:(store:MemoryStore,root:string)=>void) {
  const root=mkdtempSync(join(tmpdir(),'huimem-wiki-')), store=new MemoryStore(root);
  try { fn(store,root); } finally { store.close(); rmSync(root,{recursive:true,force:true}); }
}
function record(store:MemoryStore,status='active',expectedVersion=0) {
  const quote='Use SQLite for local storage.', episode=store.capture('wiki','user',quote);
  store.commit('wiki',[{id:'storage',kind:'fact',status,text:quote,expectedVersion,source:{episode,quote},dependsOn:[]}],'Storage source');
}
const page={id:'storage-guide',title:'Storage guide',body:'Local storage uses SQLite. This is a derived explanation, not a decision.',records:[{id:'storage',version:1}]};

describe('source-backed derived wiki',()=>{
  test('publishes readable interpretation with explicit source versions, without changing authority',()=>fixture((store,root)=>{
    record(store);
    const authority=store.authority(), published=wikiPublish(store,page), read=wikiRead(store,page.id);
    expect(published.freshness).toBe('current');
    expect(read.found).toBe(true);
    if(!read.found) throw new Error('missing page');
    expect(read.body).toBe(page.body);
    expect(read.sources[0]).toMatchObject({id:'storage',version:1,valid:true,freshness:'current',status:'active'});
    expect(read.derived).toBe(true);
    expect(read.read).toContain('id=storage-guide');
    expect(store.authority()).toEqual(authority);
    expect(existsSync(join(root,'.memory/wiki/storage-guide.md'))).toBe(true);
    expect(wikiList(store,'SQLite').pages.map(p=>p.id)).toEqual(['storage-guide']);
    expect(wikiLint(store).issues).toEqual([]);
  }));

  test('accepted sources do not turn page interpretations into accepted records',()=>fixture(store=>{
    const quote='Use SQLite because it is local.', episode=store.capture('wiki','user',quote);
    store.commit('wiki',[{id:'storage',kind:'decision',status:'accepted',text:'Use SQLite.',rationale:'because it is local',expectedVersion:0,source:{episode,quote},dependsOn:[]}],'Storage decision');
    const published=wikiPublish(store,page);
    expect(published.derived).toBe(true);
    expect(published.sources[0].status).toBe('accepted');
    expect(store.current('storage-guide')).toBe(null);
    expect(store.history('storage')).toHaveLength(1);
  }));

  test('identical publish is a true no-op and stale optimistic hashes cannot overwrite',()=>fixture((store,root)=>{
    record(store);
    const first=wikiPublish(store,page), path=join(root,'.memory/wiki/storage-guide.md');
    const before=statSync(path).mtimeMs;
    expect(wikiPublish(store,{...page,expectedHash:first.hash}).unchanged).toBe(true);
    expect(statSync(path).mtimeMs).toBe(before);
    expect(()=>wikiPublish(store,{...page,body:'Changed interpretation.'})).toThrow('WIKI_CONFLICT');
    const changed=wikiPublish(store,{...page,body:'Changed interpretation.',expectedHash:first.hash});
    expect(changed.hash).not.toBe(first.hash);
    expect(()=>wikiPublish(store,{...page,expectedHash:first.hash})).toThrow('WIKI_CONFLICT');
  }));

  test('new record versions mark pages stale, and old pinned versions cannot publish',()=>fixture(store=>{
    record(store); wikiPublish(store,page); record(store,'active',1);
    const read=wikiRead(store,page.id);
    expect(read.freshness).toBe('STALE');
    if(!read.found) throw new Error('missing page');
    expect(read.sources[0].valid).toBe(false);
    expect(read.sources[0].currentVersion).toBe(2);
    expect(()=>wikiPublish(store,page)).toThrow('WIKI_SOURCE');
    expect(wikiLint(store).issues.some(x=>x.code==='WIKI_STALE')).toBe(true);
  }));

  test('changed file evidence becomes stale without rewriting the page',()=>fixture((store,root)=>{
    writeFileSync(join(root,'design.txt'),'SQLite stays local.');
    store.commit('wiki',[{id:'storage',kind:'fact',status:'active',text:'Storage stays local.',expectedVersion:0,source:store.fileSource('design.txt','SQLite stays local.'),dependsOn:[]}],'Storage source');
    wikiPublish(store,page);
    const path=join(root,'.memory/wiki/storage-guide.md'), bytes=readFileSync(path,'utf8');
    writeFileSync(join(root,'design.txt'),'Storage now changed.');
    expect(wikiRead(store,page.id).freshness).toBe('STALE');
    expect(()=>wikiPublish(store,page)).toThrow('WIKI_SOURCE');
    wikiList(store); wikiLint(store);
    expect(readFileSync(path,'utf8')).toBe(bytes);
  }));

  test('separate Wiki reads see file changes and external record updates after warm shared-source reads',()=>fixture((store,root)=>{
    const file=join(root,'design.txt'),original='SQLite stays local.';
    writeFileSync(file,original);
    store.commit('source',[{id:'storage',kind:'fact',status:'active',text:original,expectedVersion:0,source:store.fileSource('design.txt',original),dependsOn:[]}],'Storage source');
    wikiPublish(store,page);
    wikiPublish(store,{...page,id:'storage-backup',title:'Storage backup'});
    expect(wikiList(store).pages.map(p=>[p.id,p.freshness])).toEqual([['storage-backup','current'],['storage-guide','current']]);
    expect(wikiRead(store,page.id).freshness).toBe('current');
    expect(wikiLint(store).issues).toEqual([]);
    writeFileSync(file,'The storage implementation changed.');
    expect(wikiRead(store,page.id).freshness).toBe('STALE');
    expect(wikiList(store).pages.map(p=>[p.id,p.freshness])).toEqual([['storage-backup','STALE'],['storage-guide','STALE']]);
    expect(wikiLint(store).issues.map(issue=>issue.id)).toEqual(['storage-backup','storage-guide']);
    writeFileSync(file,original);
    expect(wikiList(store).pages.map(p=>p.freshness)).toEqual(['current','current']);
    const other=new MemoryStore(root);
    try {record(other,'active',1);} finally {other.close();}
    expect(wikiRead(store,page.id).sources?.[0].currentVersion).toBe(2);
    expect(wikiList(store).pages.map(p=>p.freshness)).toEqual(['STALE','STALE']);
    expect(()=>wikiPublish(store,{...page,body:'Must not publish from an old version.'})).toThrow('WIKI_SOURCE');
  }));

  test('proposals and retired records cannot become curated authority',()=>{
    for(const status of ['proposed','retired']) fixture(store=>{
      record(store,status);
      expect(()=>wikiPublish(store,page)).toThrow('WIKI_SOURCE');
      expect(wikiRead(store,page.id).found).toBe(false);
    });
  });

  test('unconfirmed episode evidence prevents publication',()=>fixture(store=>{
    record(store);
    store.db.query('DELETE FROM episodes').run();
    expect(()=>wikiPublish(store,page)).toThrow('WIKI_SOURCE');
  }));

  test('manual edits and human files are visible errors and never overwritten',()=>fixture((store,root)=>{
    record(store); wikiPublish(store,page);
    const path=join(root,'.memory/wiki/storage-guide.md');
    writeFileSync(path,'# Human notes\nDo not overwrite.');
    const read=wikiRead(store,page.id);
    expect(read.found).toBe(true);
    expect(read.freshness).toBe('STALE');
    expect(read.error).toContain('WIKI_CORRUPT');
    expect(()=>wikiPublish(store,page)).toThrow('WIKI_CORRUPT');
    expect(wikiLint(store).issues.some(x=>x.code==='WIKI_CORRUPT')).toBe(true);
    expect(readFileSync(path,'utf8')).toBe('# Human notes\nDo not overwrite.');
  }));

  test('embedded digest detects an edited generated body',()=>fixture((store,root)=>{
    record(store); wikiPublish(store,page);
    const path=join(root,'.memory/wiki/storage-guide.md');
    writeFileSync(path,readFileSync(path,'utf8').replace('Local storage uses SQLite.','Local storage uses Redis.'));

    expect(wikiRead(store,page.id).error).toContain('WIKI_CORRUPT');
    expect(()=>wikiPublish(store,page)).toThrow('WIKI_CORRUPT');
  }));

  // The publication itself runs under the scope database's immediate writer transaction; a file
  // left by a crashed publisher must not turn every later publication into WIKI_CONFLICT.
  test('a leftover lock file from an interrupted publisher does not block publication',()=>fixture((store,root)=>{
    record(store);
    mkdirSync(join(root,'.memory/wiki'));
    const lock=join(root,'.memory/wiki/.storage-guide.lock');
    writeFileSync(lock,'another publisher');
    expect(wikiPublish(store,page).unchanged).toBe(false);
    expect(existsSync(join(root,'.memory/wiki/storage-guide.md'))).toBe(true);
    expect(readFileSync(lock,'utf8')).toBe('another publisher');
  }));
  test('rejects traversal, secrets, empty sources, and symlink escape',()=>fixture((store,root)=>{
    record(store);
    expect(()=>wikiPublish(store,{...page,id:'../outside'})).toThrow('WIKI_ID');
    expect(()=>wikiPublish(store,{...page,body:'api_key=private-value'})).toThrow('WIKI_SECRET');
    expect(()=>wikiPublish(store,{...page,records:[]})).toThrow('WIKI_SOURCE');
    const outside=mkdtempSync(join(tmpdir(),'huimem-wiki-outside-'));
    try {
      symlinkSync(outside,join(root,'.memory/wiki'),'junction');
      expect(()=>wikiPublish(store,page)).toThrow('WIKI_PATH');
      expect(existsSync(join(outside,'storage-guide.md'))).toBe(false);
    } finally { rmSync(join(root,'.memory/wiki'),{force:true}); rmSync(outside,{recursive:true,force:true}); }
  }));

  test('missing and empty wiki reads do not create directories',()=>fixture((store,root)=>{
    expect(wikiRead(store,'missing').found).toBe(false);
    expect(wikiList(store).pages).toEqual([]);
    expect(wikiLint(store).issues).toEqual([]);
    expect(existsSync(join(root,'.memory/wiki'))).toBe(false);
    mkdirSync(join(root,'.memory/wiki'));
    writeFileSync(join(root,'.memory/wiki/empty.md'),'');
    expect(wikiRead(store,'empty').error).toContain('WIKI_CORRUPT');
  }));

  test('session storage roots keep curated pages out of the evidence root',()=>{
    const root=mkdtempSync(join(tmpdir(),'huimem-wiki-scope-')), storage=join(root,'session');
    mkdirSync(storage);
    const store=new MemoryStore(root,{storageRoot:storage});
    try {
      record(store); wikiPublish(store,page);
      expect(existsSync(join(storage,'.memory/wiki/storage-guide.md'))).toBe(true);
      expect(existsSync(join(root,'.memory/wiki/storage-guide.md'))).toBe(false);
    } finally { store.close(); rmSync(root,{recursive:true,force:true}); }
  });
});

describe('local on-demand git history',()=>{
  test('returns real commit metadata for a literal path, not inferred rationale',async()=>{
    const root=mkdtempSync(join(tmpdir(),'huimem-wiki-git-'));
    try {
      for(const args of [['init'],['config','user.name','Wiki Test'],['config','user.email','wiki@example.invalid']]) {
        const result=Bun.spawnSync(['git',...args],{cwd:root}); expect(result.exitCode).toBe(0);
      }
      writeFileSync(join(root,'--notes.txt'),'local history');
      expect(Bun.spawnSync(['git','add','--','--notes.txt'],{cwd:root}).exitCode).toBe(0);
      expect(Bun.spawnSync(['git','commit','-m','Document local storage'],{cwd:root}).exitCode).toBe(0);
      const result=await gitHistory(root,'--notes.txt');
      expect(result.commits[0]).toMatchObject({author:'Wiki Test',subject:'Document local storage'});
      expect(result.commits[0].commit).toMatch(/^[0-9a-f]{40,64}$/);
      expect(result.historyNotRationale).toBe(true);
      expect(result.commits[0].time).toMatch(/^\d{4}-\d\d-\d\dT/);
      await expect(gitHistory(root,'../outside')).rejects.toThrow('GIT_PATH');
      const controller=new AbortController(); controller.abort();
      await expect(gitHistory(root,'--notes.txt',10,controller.signal)).rejects.toThrow('GIT_ABORTED');
    } finally { rmSync(root,{recursive:true,force:true}); }
  });
});
