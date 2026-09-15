import {existsSync,lstatSync,readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {MemoryStore,safePath,architectureCheck} from './core';
import {memoryToolError} from './errors';
import {listAdrs} from './adr-audit';
import {readBasis} from './provenance';
import {projectionStatus} from './projection';
import {readSettings,LIMITS} from './settings';

export type DoctorIssue={severity:'error'|'warning'|'info';code:string;target:string;message:string;fix:string};
// partial: the section ran, but some of its inputs could not be read or were deliberately not followed.
export type DoctorReport={issues:DoctorIssue[];checked:string[];partial:string[];unavailable:string[]};

// This is an explicit diagnostic command, never a prompt hook. It opens the existing
// database read-only: no migrations, health writes, sync, capture or automatic repairs.
export function diagnoseMemory(root:string):DoctorReport {
  const report:DoctorReport={issues:[],checked:[],partial:[],unavailable:[]};
  const add=(severity:DoctorIssue['severity'],code:string,target:string,message:string,fix:string)=>
    report.issues.push({severity,code,target,message,fix});
  // read may call gap(note) when it completed without some of its inputs; the section is then reported as partial.
  // target names the file behind a file-backed section, so a failure points at what to open.
  const attempt=<T>(section:string,read:(gap:(note:string)=>void)=>T,target=section):T|undefined=>{
    try {
      const gaps:string[]=[];
      const value=read(note=>gaps.push(note));
      if(gaps.length) report.partial.push(`${section} (${gaps.join(', ')})`); else report.checked.push(section);
      return value;
    }
    catch(error) {
      const d=memoryToolError(error).details;
      report.unavailable.push(section);
      add('error',d.code,target,d.message,d.fix);
      return undefined;
    }
  };
  const text=(path:string)=>{
    const full=safePath(root,path);
    if(statSync(full).size>1024*1024) throw new Error('DOCTOR_FILE_TOO_LARGE: '+path);
    return readFileSync(full,'utf8');
  };
  const json=(path:string,code:string)=>{
    const raw=text(path);
    try {return JSON.parse(raw);} catch(error) {throw new Error(`${code}: ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);}
  };
  if(!existsSync(resolve(root,'.memory/MEMORY.md'))) {
    add('info','PROJECT_MEMORY_NOT_ENABLED','.memory/MEMORY.md','Project memory is not enabled.','Run /huimem init in the intended project root.');
    return report;
  }
  let records:ReturnType<MemoryStore['inspectRecords']>|undefined;
  if(existsSync(resolve(root,'.memory/runtime/state.sqlite'))) {
    let store:MemoryStore|undefined;
    try {
      store=attempt('database',()=>new MemoryStore(root,{readOnly:true}),'.memory/runtime/state.sqlite');
      if(store) {
        records=attempt('records',()=>store!.inspectRecords());
        if(records) attempt('episode evidence',()=>{
          for(const row of records!) {
            if(row.data.status==='retired' || !row.data.source.episode) continue;
            const source=store!.episode(row.data.source.episode);
            const problem=!source ? 'Source episode is missing.'
              : typeof source.text!=='string' || !source.text.includes(row.data.source.quote) ? 'Saved quote is absent from its source episode.'
              : row.data.kind==='decision' && row.data.status==='accepted' && source.role!=='user' ? 'Accepted decision no longer has a user source.' : undefined;
            if(problem) add('warning','EPISODE_EVIDENCE_INVALID',row.id,problem,
              'Inspect the original message and record history. Restore verified evidence or explicitly revise the record; do not invent a replacement quote.');
          }
        });
        const projection=attempt('readable registry',()=>projectionStatus(store!.db,root));
        if(projection && (projection.state==='conflict' || projection.state==='pending'))
          add('warning','PROJECTION_'+projection.state.toUpperCase(),projection.path,projection.error ?? 'Readable registry is not synchronized.',
            'Preserve and reconcile any manual edits, then run /huimem sync. Doctor does not publish files.');
      }
    } finally {store?.close();}
  } else {
    report.unavailable.push('database');
    add('warning','MEMORY_DATABASE_MISSING','.memory/runtime/state.sqlite','No memory database exists yet.',
      'Start a normal OMP conversation in this project to initialize memory; doctor does not create a database.');
  }
  if(records) for(const r of records) {
    if(r.data.status!=='retired' && r.staleReasons.length)
      add('warning','STALE_RECORD',r.id,r.staleReasons.join('; '),'Recall this record and recheck its original sources before saving a corrected version.');
  }
  const settings=attempt('settings',()=>{
    if(existsSync(resolve(root,'.memory/settings.json'))) {
      const raw=json('.memory/settings.json','INVALID_SETTINGS');
      if(!raw || typeof raw!=='object' || Array.isArray(raw)) throw new Error('INVALID_SETTINGS: expected a JSON object');
      if(raw.required!==undefined && (!Array.isArray(raw.required) || raw.required.length>10 || raw.required.some((x:unknown)=>typeof x!=='string' || !/^[a-zA-Z0-9_.:/-]{1,100}$/.test(x))))
        throw new Error('INVALID_SETTINGS: required must contain at most 10 valid record IDs');
      // readSettings silently falls back to limits; say which value is actually in effect.
      const used=readSettings(root);
      for(const key of ['recallBudget','injectionLimit'] as const) {
        const l=LIMITS[key];
        if(raw[key]!==undefined && raw[key]!==used[key])
          add('warning','SETTING_ADJUSTED','.memory/settings.json',
            `${key} ${JSON.stringify(raw[key])} is not an integer within ${l.min}–${l.max}; ${used[key]} is used.`,
            `Set ${key} with /huimem ${key==='recallBudget' ? 'recall' : 'limit'} or the settings screen, which apply the same limits.`);
      }
    }
    return readSettings(root);
  },'.memory/settings.json');
  if(records && settings) for(const id of settings.required) {
    const row=records.find(r=>r.id===id);
    if(!row || row.data.status==='retired') add('warning','REQUIRED_UNAVAILABLE',id,row ? 'Required record is retired.' : 'Required record is missing.',
      'Review the required list with /huimem require. Restore the intended record or explicitly unrequire it.');
  }
  // Each ADR is read on its own: one oversized or unreadable document must not hide findings for the others.
  attempt('ADR basis',gap=>{
    // listAdrs skips links on purpose (a write through them would leave the project); name them instead of hiding them.
    const dir=resolve(root,'.memory/adr');
    const links=!existsSync(dir) ? [] : lstatSync(dir).isSymbolicLink() ? ['.memory/adr']
      : [...new Bun.Glob('.memory/adr/**').scanSync({cwd:root,onlyFiles:false,followSymlinks:false})]
        .map(p=>p.split('\\').join('/')).filter(p=>lstatSync(resolve(root,p)).isSymbolicLink()).sort();
    for(const link of links)
      add('warning','ADR_NOT_CHECKED',link,'Link in the ADR directory is not followed; documents behind it are not checked.',
        'Keep project ADRs as regular files inside .memory/adr, or move the link out of that directory.');
    if(links.length) gap(`${links.length} link(s) not followed`);
    const paths=listAdrs(root);
    let unreadable=0;
    for(const path of paths) {
      try {
        if(!readBasis(text(path)).section)
          add('warning','ADR_WITHOUT_BASIS',path,'No basis section is present.',
            'Run /huimem adr-audit to inspect possible migration. Existing basis sections are not authenticated by doctor.');
      } catch(error) {
        unreadable++;
        const d=memoryToolError(error).details;
        add('error',d.code,path,d.message,d.fix);
      }
    }
    if(unreadable) gap(`${unreadable} of ${paths.length} unreadable`);
  },'.memory/adr');
  if(existsSync(resolve(root,'.memory/architecture.json'))) attempt('architecture',()=>{
    const result=architectureCheck(root,json('.memory/architecture.json','INVALID_POLICY'));
    if(result.configured && !result.ok) for(const failure of result.failures)
      add('warning','ARCHITECTURE_FAILED','.memory/architecture.json',failure,'Inspect /huimem arch and reconcile the code with the project policy.');
  },'.memory/architecture.json');
  if(existsSync(resolve(root,'.memory/todo.json'))) attempt('task file',()=>{
    const todo=json('.memory/todo.json','INVALID_TODO');
    if(!Array.isArray(todo?.tasks)) throw new Error('INVALID_TODO: expected a tasks array');
    const seen=new Set<string>(),fileOnly:string[]=[];
    for(const task of todo.tasks) {
      if(typeof task?.id!=='string' || !task.id || !['todo','doing','done','blocked','retired'].includes(task.status))
        throw new Error('INVALID_TODO: each task needs an id and a valid task status');
      if(seen.has(task.id)) throw new Error('INVALID_TODO: duplicate task ID '+task.id);
      seen.add(task.id);
      if(!records) continue;
      const row=records.find(r=>r.id===task.id);
      if(row && row.data.kind!=='task')
        add('warning','TASK_ID_KIND_DIFFERS',task.id,`todo.json lists a task, but the registry record with this ID is a ${row.data.kind}.`,
          'Check which item the ID should name; rename one of them intentionally. Neither copy is changed automatically.');
      else if(!row) fileOnly.push(task.id);
      else if(row.data.status!==task.status)
        add('warning','TASK_STATE_DIFFERS',task.id,`todo.json: ${task.status}; registry: ${row.data.status}.`,
          'Compare todo.json with the task record and its source; reconcile intentionally. Neither copy is overwritten automatically.');
    }
    if(!records) return;
    // Membership gaps are aggregated: the plugin does not sync the two task lists, so per-ID findings would
    // crowd status conflicts out of the 50-finding output in any project that only uses one of them.
    const listed=(ids:string[])=>ids.slice(0,10).join(', ')+(ids.length>10 ? ` and ${ids.length-10} more` : '');
    if(fileOnly.length)
      add('warning','TASKS_NOT_IN_REGISTRY','.memory/todo.json',`${fileOnly.length} todo.json task(s) have no registry record: ${listed(fileOnly)}.`,
        'Decide whether these tasks should be saved as task records; doctor does not synchronize the two representations.');
    const registryOnly=records.filter(r=>r.data.kind==='task' && r.data.status!=='retired' && !seen.has(r.id)).map(r=>r.id);
    if(registryOnly.length)
      add(seen.size ? 'warning' : 'info','TASKS_NOT_IN_TODO','.memory/todo.json',
        `${registryOnly.length} registry task(s) are absent from ${seen.size ? '' : 'the empty '}todo.json: ${listed(registryOnly)}.`,
        'Decide whether these tasks belong in the task file; doctor does not synchronize the two representations.');
  },'.memory/todo.json');
  else if(records?.some(r=>r.data.kind==='task' && r.data.status!=='retired'))
    add('warning','TODO_FILE_MISSING','.memory/todo.json','Registry tasks exist but the task file is absent.','Review the project task-file convention before recreating it.');
  return report;
}

export function formatDoctor(report:DoctorReport):string {
  const issues=report.issues.slice(0,50);
  return [
    'huimem doctor — diagnostic only; no repairs applied.',
    report.issues.length ? `${report.issues.length} finding(s).` : 'No findings in the completed checks; this is not a guarantee of semantic correctness.',
    `Checked: ${report.checked.join(', ') || 'none'}.`,
    ...(report.partial.length ? ['Partial: '+report.partial.join(', ')+'.'] : []),
    ...(report.unavailable.length ? ['Unavailable: '+report.unavailable.join(', ')+'.'] : []),
    ...issues.map(i=>`${i.severity.toUpperCase()} ${i.code} — ${i.target}\n  ${i.message}\n  Fix: ${i.fix}`),
    ...(report.issues.length>issues.length ? [`${report.issues.length-issues.length} additional findings omitted; address the listed issues and rerun.`] : []),
  ].join('\n');
}
