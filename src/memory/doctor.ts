import {existsSync,readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {MemoryStore,safePath,architectureCheck} from './core';
import {memoryToolError} from './errors';
import {listAdrs} from './adr-audit';
import {readBasis} from './provenance';
import {projectionStatus} from './projection';
import {readSettings} from './settings';

export type DoctorIssue={severity:'error'|'warning'|'info';code:string;target:string;message:string;fix:string};
export type DoctorReport={issues:DoctorIssue[];checked:string[];unavailable:string[]};

// This is an explicit diagnostic command, never a prompt hook. It opens the existing
// database read-only: no migrations, health writes, sync, capture or automatic repairs.
export function diagnoseMemory(root:string):DoctorReport {
  const report:DoctorReport={issues:[],checked:[],unavailable:[]};
  const add=(severity:DoctorIssue['severity'],code:string,target:string,message:string,fix:string)=>
    report.issues.push({severity,code,target,message,fix});
  const attempt=<T>(section:string,read:()=>T):T|undefined=>{
    try {const value=read();report.checked.push(section);return value;}
    catch(error) {
      const d=memoryToolError(error).details;
      report.unavailable.push(section);
      add('error',d.code,section,d.message,d.fix);
      return undefined;
    }
  };
  const text=(path:string)=>{
    const full=safePath(root,path);
    if(statSync(full).size>1024*1024) throw new Error('DOCTOR_FILE_TOO_LARGE: '+path);
    return readFileSync(full,'utf8');
  };
  if(!existsSync(resolve(root,'.memory/MEMORY.md'))) {
    add('info','PROJECT_MEMORY_NOT_ENABLED','.memory/MEMORY.md','Project memory is not enabled.','Run /huimem init in the intended project root.');
    return report;
  }
  let records:ReturnType<MemoryStore['inspectRecords']>|undefined;
  if(existsSync(resolve(root,'.memory/runtime/state.sqlite'))) {
    let store:MemoryStore|undefined;
    try {
      store=attempt('database',()=>new MemoryStore(root,{readOnly:true}));
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
      const raw=JSON.parse(text('.memory/settings.json'));
      if(!raw || typeof raw!=='object' || Array.isArray(raw)) throw new Error('INVALID_SETTINGS: expected a JSON object');
      if(raw.required!==undefined && (!Array.isArray(raw.required) || raw.required.length>10 || raw.required.some((x:unknown)=>typeof x!=='string' || !/^[a-zA-Z0-9_.:/-]{1,100}$/.test(x))))
        throw new Error('INVALID_SETTINGS: required must contain at most 10 valid record IDs');
    }
    return readSettings(root);
  });
  if(records && settings) for(const id of settings.required) {
    const row=records.find(r=>r.id===id);
    if(!row || row.data.status==='retired') add('warning','REQUIRED_UNAVAILABLE',id,row ? 'Required record is retired.' : 'Required record is missing.',
      'Review the required list with /huimem require. Restore the intended record or explicitly unrequire it.');
  }
  attempt('ADR basis',()=>{
    for(const path of listAdrs(root)) if(!readBasis(text(path)).section)
      add('warning','ADR_WITHOUT_BASIS',path,'No basis section is present.',
        'Run /huimem adr-audit to inspect possible migration. Existing basis sections are not authenticated by doctor.');
  });
  if(existsSync(resolve(root,'.memory/architecture.json'))) attempt('architecture',()=>{
    const result=architectureCheck(root,JSON.parse(text('.memory/architecture.json')));
    if(result.configured && !result.ok) for(const failure of result.failures)
      add('warning','ARCHITECTURE_FAILED','.memory/architecture.json',failure,'Inspect /huimem arch and reconcile the code with the project policy.');
  });
  if(existsSync(resolve(root,'.memory/todo.json'))) attempt('task file',()=>{
    const todo=JSON.parse(text('.memory/todo.json'));
    if(!Array.isArray(todo?.tasks)) throw new Error('INVALID_TODO: expected a tasks array');
    const seen=new Set<string>();
    for(const task of todo.tasks) {
      if(typeof task?.id!=='string' || !task.id || !['todo','doing','done','blocked','retired'].includes(task.status))
        throw new Error('INVALID_TODO: each task needs an id and a valid task status');
      if(seen.has(task.id)) throw new Error('INVALID_TODO: duplicate task ID '+task.id);
      seen.add(task.id);
      if(!records) continue;
      const row=records.find(r=>r.id===task.id && r.data.kind==='task');
      if(!row || row.data.status!==task.status)
        add('warning','TASK_STATE_DIFFERS',task.id,row ? `todo.json: ${task.status}; registry: ${row.data.status}.` : 'Task exists in todo.json but not in the registry.',
          'Compare todo.json with the task record and its source; reconcile intentionally. Neither copy is overwritten automatically.');
    }
    if(records) for(const row of records.filter(r=>r.data.kind==='task' && r.data.status!=='retired'))
      if(!seen.has(row.id)) add('warning','TASK_NOT_IN_TODO',row.id,'Registry task is absent from todo.json.',
        'Decide whether this task belongs in the task file; doctor does not synchronize the two representations.');
  });
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
    ...(report.unavailable.length ? ['Unavailable: '+report.unavailable.join(', ')+'.'] : []),
    ...issues.map(i=>`${i.severity.toUpperCase()} ${i.code} — ${i.target}\n  ${i.message}\n  Fix: ${i.fix}`),
    ...(report.issues.length>issues.length ? [`${report.issues.length-issues.length} additional findings omitted; address the listed issues and rerun.`] : []),
  ].join('\n');
}
