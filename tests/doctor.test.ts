import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {MemoryStore} from '../src/memory/core';
import {diagnoseMemory,formatDoctor} from '../src/memory/doctor';

function fixture(fn:(dir:string)=>void) {
  const dir=mkdtempSync(join(import.meta.dir,'doctor-test-'));
  try {fn(dir);} finally {rmSync(dir,{recursive:true,force:true});}
}
function enable(dir:string) {
  mkdirSync(join(dir,'.memory'),{recursive:true});
  writeFileSync(join(dir,'.memory/MEMORY.md'),'# Project memory');
}
function seed(s:MemoryStore,id='fact',kind='fact',status='active') {
  return {id,kind,status,text:'Keep the current design',expectedVersion:0,dependsOn:[],
    source:{episode:s.capture('r','user','Keep the current design'),quote:'Keep the current design'}};
}
const codes=(dir:string)=>diagnoseMemory(dir).issues.map(i=>i.code);

test('doctor does not create memory or initialize an enabled project',()=>fixture(dir=>{
  expect(codes(dir)).toEqual(['PROJECT_MEMORY_NOT_ENABLED']);
  expect(existsSync(join(dir,'.memory'))).toBe(false);
  enable(dir);
  expect(codes(dir)).toContain('MEMORY_DATABASE_MISSING');
  expect(existsSync(join(dir,'.memory/runtime'))).toBe(false);
}));

test.each(['pending','conflict'])('doctor reports %s publication without publishing or touching stored state',state=>fixture(dir=>{
  enable(dir);
  const s=new MemoryStore(dir);
  try {s.commit('r',[seed(s)],'saved');} finally {s.close();}
  const file=join(dir,'.memory/RECORDS.md'),db=join(dir,'.memory/runtime/state.sqlite');
  if(state==='pending') rmSync(file); else writeFileSync(file,'Human correction');
  const before=readFileSync(db);
  expect(codes(dir)).toContain('PROJECTION_'+state.toUpperCase());
  expect(readFileSync(db).equals(before)).toBe(true);
  if(state==='pending') expect(existsSync(file)).toBe(false);
  else expect(readFileSync(file,'utf8')).toBe('Human correction');
}));

test('doctor combines missing sources and dependencies, required, ADR and task drift',()=>fixture(dir=>{
  enable(dir);
  writeFileSync(join(dir,'source.txt'),'Use the current adapter');
  const s=new MemoryStore(dir);
  try {
    s.commit('r',[
      {...seed(s,'file'),source:s.fileSource('source.txt','Use the current adapter')},
      seed(s,'basis'),
      {...seed(s,'dependent'),dependsOn:[{id:'basis'}]},
      seed(s,'task','task','todo'),seed(s,'registry-only','task','doing'),
    ],'saved');
    // Simulate incomplete restore; doctor must report it, never repair it.
    s.db.exec("DELETE FROM versions WHERE id='basis'; DELETE FROM episodes");
  } finally {s.close();}
  rmSync(join(dir,'source.txt'));
  mkdirSync(join(dir,'.memory/adr'));
  writeFileSync(join(dir,'.memory/adr/0001.md'),'# Legacy decision\nNo quoted basis');
  writeFileSync(join(dir,'.memory/settings.json'),JSON.stringify({required:['missing']}));
  writeFileSync(join(dir,'.memory/todo.json'),JSON.stringify({tasks:[{id:'task',status:'done'}]}));
  const report=diagnoseMemory(dir);
  expect(report.issues.find(i=>i.code==='STALE_RECORD' && i.target==='file')?.message).toContain('missing');
  expect(report.issues.find(i=>i.code==='STALE_RECORD' && i.target==='dependent')?.message).toContain('basis is missing');
  for(const code of ['EPISODE_EVIDENCE_INVALID','REQUIRED_UNAVAILABLE','ADR_WITHOUT_BASIS','TASK_STATE_DIFFERS','TASK_NOT_IN_TODO'])
    expect(report.issues.map(i=>i.code)).toContain(code);
}));

test('invalid settings and task file do not hide independent ADR findings',()=>fixture(dir=>{
  enable(dir);
  writeFileSync(join(dir,'.memory/settings.json'),JSON.stringify({required:['кириллица']}));
  writeFileSync(join(dir,'.memory/todo.json'),JSON.stringify({tasks:[{id:'x',status:'active'}]}));
  mkdirSync(join(dir,'.memory/adr'));
  writeFileSync(join(dir,'.memory/adr/old.md'),'# Decision');
  const report=diagnoseMemory(dir);
  expect(report.unavailable).toContain('settings');
  expect(report.unavailable).toContain('task file');
  expect(report.issues.map(i=>i.code)).toContain('ADR_WITHOUT_BASIS');
}));

test('doctor reports a pending schema-one migration without migrating, and the normal store then migrates it',()=>fixture(dir=>{
  enable(dir);
  const s=new MemoryStore(dir);
  s.db.exec("DROP TABLE projection; UPDATE meta SET value='1' WHERE key='schema'");
  s.close();
  const path=join(dir,'.memory/runtime/state.sqlite'),before=readFileSync(path);
  const issue=diagnoseMemory(dir).issues.find(i=>i.target==='database')!;
  expect(issue.code).toBe('SCHEMA_MIGRATION_PENDING');
  expect(issue.fix).toContain('normal OMP conversation');
  expect(issue.fix).not.toContain('compatible');
  expect(readFileSync(path).equals(before)).toBe(true);
  const db=new Database(path,{readonly:true});
  try {
    expect(db.query("SELECT value FROM meta WHERE key='schema'").get()).toEqual({value:'1'});
    expect(db.query("SELECT name FROM sqlite_master WHERE name='projection'").get()).toBeNull();
  } finally {db.close();}
  new MemoryStore(dir).close();
  expect(diagnoseMemory(dir).unavailable).not.toContain('database');
}));

test('doctor separates an uninitialized database file from an unknown schema',()=>fixture(dir=>{
  enable(dir);
  mkdirSync(join(dir,'.memory/runtime'));
  const path=join(dir,'.memory/runtime/state.sqlite');
  writeFileSync(path,'');
  expect(codes(dir)).toContain('SCHEMA_MIGRATION_PENDING');
  expect(readFileSync(path).length).toBe(0);
  rmSync(path);
  const s=new MemoryStore(dir);
  s.db.exec("UPDATE meta SET value='3' WHERE key='schema'");
  s.close();
  expect(codes(dir)).toContain('UNSUPPORTED_SCHEMA');
}));

test('read-only store rejects writes and doctor reports corrupt storage without replacing it',()=>fixture(dir=>{
  enable(dir);
  const writer=new MemoryStore(dir);writer.close();
  const reader=new MemoryStore(dir,{readOnly:true});
  try {expect(()=>reader.capture('r','user','Unexpected write')).toThrow();} finally {reader.close();}
  const path=join(dir,'.memory/runtime/state.sqlite');
  writeFileSync(path,'broken sqlite');
  const report=diagnoseMemory(dir);
  expect(report.unavailable).toContain('database');
  expect(report.issues.find(i=>i.target==='database')?.fix).toContain('preserve the database');
  expect(readFileSync(path,'utf8')).toBe('broken sqlite');
}));

test('doctor reads committed data of an open writer without changing tables, and the writer continues',()=>fixture(dir=>{
  enable(dir);
  const writer=new MemoryStore(dir);
  try {
    writer.commit('r',[seed(writer,'first')],'saved');
    const tables=()=>(writer.db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[])
      .map(t=>JSON.stringify(writer.db.query(`SELECT * FROM "${t.name}"`).all())).join('\n');
    const before=tables();
    const report=diagnoseMemory(dir);
    expect(report.unavailable).toEqual([]);
    expect(report.issues.map(i=>i.code)).toEqual([]);
    expect(tables()).toBe(before);
    writer.commit('r2',[seed(writer,'second')],'after doctor');
  } finally {writer.close();}
  const reader=new MemoryStore(dir,{readOnly:true});
  try {expect(reader.inspectRecords().map(r=>r.id).sort()).toEqual(['first','second']);} finally {reader.close();}
}));

test('doctor explains transitive, retired and changed dependencies and invalid episode evidence',()=>fixture(dir=>{
  enable(dir);
  const s=new MemoryStore(dir);
  try {
    s.commit('r',[seed(s,'c'),seed(s,'ret'),seed(s,'quoted'),
      {...seed(s,'dec','decision','accepted'),rationale:'Keep the current design'}],'base');
    s.commit('r',[{...seed(s,'b'),dependsOn:[{id:'c'}]},{...seed(s,'x'),dependsOn:[{id:'ret'}]}],'mid');
    s.commit('r',[{...seed(s,'a'),dependsOn:[{id:'b'}]}],'top');
    s.commit('r',[{...seed(s,'c'),text:'Changed design',expectedVersion:1},{...seed(s,'ret','fact','retired'),expectedVersion:1}],'change');
    const episode=(id:string)=>s.current(id)!.source.episode!;
    s.db.query("UPDATE episodes SET text='Different wording' WHERE id=?").run(episode('quoted'));
    s.db.query("UPDATE episodes SET role='assistant' WHERE id=?").run(episode('dec'));
  } finally {s.close();}
  const found=Object.fromEntries(diagnoseMemory(dir).issues.map(i=>[`${i.code}@${i.target}`,i.message]));
  expect(found['STALE_RECORD@a']).toBe('b is STALE (c changed: version 1 -> 2)');
  expect(found['STALE_RECORD@b']).toBe('c changed: version 1 -> 2');
  expect(found['STALE_RECORD@x']).toBe('ret was retired in version 2');
  expect(found['EPISODE_EVIDENCE_INVALID@quoted']).toBe('Saved quote is absent from its source episode.');
  expect(found['EPISODE_EVIDENCE_INVALID@dec']).toBe('Accepted decision no longer has a user source.');
  expect(found['STALE_RECORD@ret']).toBeUndefined();
}));

test('formatter caps findings and explicitly reports incomplete sections',()=>{
  const report={checked:['settings'],unavailable:['database'],issues:Array.from({length:51},(_,i)=>({
    severity:'warning' as const,code:'STALE_RECORD',target:'record-'+i,message:'Changed source',fix:'Recheck source',
  }))};
  const text=formatDoctor(report);
  expect(text).toContain('Unavailable: database');
  expect(text).toContain('1 additional findings omitted');
  expect(text).not.toContain('record-50');
});
