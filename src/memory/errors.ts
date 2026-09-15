export type MemoryDiagnostic = {
  severity: 'error'; code: string; message: string; fix: string; target: string;
};

// Recovery guidance belongs to the tool boundary. Core validation and transactions
// keep their existing errors; formatting a failure never retries or changes memory.
const FIXES: Record<string,string> = {
  VERSION_CONFLICT: 'Recall the record by id, review its current value and version, then use that version as expectedVersion. Do not overwrite an unseen correction.',
  MISSING_LINK: 'Recall each links ID. Use existing record IDs, or create the referenced records in the same commit; links are not file paths.',
  INVALID_STATUS: 'Use a status valid for the kind: fact/procedure/navigation = active, proposed, retired; decision = proposed, accepted, retired; task = todo, doing, done, blocked, retired.',
  INVALID_KIND: 'Use fact, decision, procedure, navigation, or task as kind.',
  INVALID_VERSION: 'Use expectedVersion=0 for a new ID; otherwise recall the ID and use its current non-negative integer version.',
  INVALID_ID: 'Use a non-empty ID of at most 100 characters containing letters, numbers, underscore, dot, colon, slash or hyphen.',
  INVALID_TEXT: 'Supply non-empty text of at most 3000 characters.',
  INVALID_LINKS: 'Supply at most 20 links as record ID strings.',
  DUPLICATE_ID: 'Combine changes for the same ID into one entry per commit.',
  INVALID_CHECKPOINT: 'Supply a non-empty summary of at most 2000 characters and an array of at most 30 changes. An empty changes array is allowed.',
  INVALID_TASK_SCOPE: 'Use an existing task record ID, save that task in this commit, or omit task when the summary is not task-specific.',
  INVALID_DEPENDENCIES: 'Use at most 20 dependsOn entries, each with exactly one record id or project-relative file path. A record cannot depend on itself.',
  MISSING_DEPENDENCY: 'Recall the dependency ID. Use an existing record or create it in the same commit; do not invent a replacement basis.',
  DEPENDENCY_RETIRED: 'Review the retired basis and identify a supported current basis before changing dependsOn.',
  DEPENDENCY_VERSION: 'Recall the dependency and recheck the claim against its current version before retrying.',
  DEPENDENCY_HASH: 'Read the dependency file and recheck the claim against its current contents before retrying.',
  AUTHORITY_CHANGED: 'Reread the relevant project rules and sources, then reconsider the changes before retrying.',
  SOURCE_ORIGIN_REQUIRED: 'Add source.origin="user" for an exact current user quote, or origin="file" with a relative path and exact file quote.',
  SOURCE_REQUIRED: 'Provide one source: the current user message, a stored episode, or a project file, with an exact quote.',
  SOURCE: 'Use exactly one source and a verbatim quote present in it. For the current user use origin="user" and quote only; for a file use origin="file", path and quote; for a stored message use origin="episode", episode and quote.',
  USER_SOURCE_REQUIRED: 'An accepted decision needs a stored user message. Use an exact user quote, or keep an unsupported inference proposed.',
  RATIONALE_REQUIRED: 'Supply a non-empty rationale of at most 2000 characters for a decision.',
  RATIONALE_SOURCE_REQUIRED: 'Copy rationale exactly from source.quote. Put additional interpretation in text or keep the decision proposed.',
  SOURCE_DERIVED: 'Use the original episode or source file; RECORDS.md is a generated view, not independent evidence.',
  SECRET_PATTERN: 'Remove credentials from the proposed text and summary. Use a non-secret exact excerpt as evidence.',
  PATH: 'Use a project-relative path that resolves inside this project, without links outside it.',
  COMMITS_PAUSED: 'Ask the user to run /huimem resume if saving should resume. Reads remain available; repeated commit calls will not clear the pause.',
  MEMORY_NOT_ENABLED: 'Ask the user to run /huimem init in the project root, then send a new message.',
  UNKNOWN_OPERATION: 'Use status, recall, episodes, history, evidence or commit as op.',
};

export function memoryToolError(error:unknown,operation?:string,explicitCode?:string) {
  const legacy=String(error);
  const message=error instanceof Error ? error.message : legacy;
  const prefix=message.match(/^([A-Z][A-Z0-9_]*)(?=:|$)/)?.[1];
  const native=typeof (error as any)?.code==='string' ? (error as any).code : undefined;
  const code=explicitCode ?? prefix ?? native ?? 'MEMORY_ERROR';
  const storage=/^SQLITE/.test(code) || ['EACCES','EPERM','EROFS','ENOSPC','EIO'].includes(code);
  const fix=FIXES[code] ?? (storage
    ? 'Check project storage permissions, available space and memory health with /huimem. Resolve the storage problem before retrying a write.'
    : 'Inspect the error and memory state with /huimem. Correct its cause before retrying; do not repeat the unchanged request.');
  const diagnostic:MemoryDiagnostic={severity:'error',code,message,fix,target:operation ? `project_memory.${operation}` : 'project_memory'};
  return {
    content:[{type:'text' as const,text:legacy+'\nFix: '+fix}],
    details:{error:legacy,...diagnostic},
    isError:true as const,
  };
}
