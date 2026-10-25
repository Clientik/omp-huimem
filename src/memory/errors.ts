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
  INVALID_ID: 'Use a non-empty ID of at most 100 characters containing ASCII letters A-Z/a-z, digits 0-9, underscore, dot, colon, slash or hyphen.',
  INVALID_TEXT: 'Supply non-empty text of at most 3000 characters.',
  INVALID_LINKS: 'Supply at most 20 links as record ID strings.',
  INVALID_EPISODE_OFFSET: 'Use episodes with id=<episode> and a non-negative safe integer offset from the returned offset/nextOffset. Offsets are UTF-16 positions and must not split a surrogate pair.',
  DUPLICATE_ID: 'Combine changes for the same ID into one entry per commit.',
  INVALID_CHECKPOINT: 'Supply a non-empty summary of at most 2000 characters and an array of at most 30 changes. An empty changes array is allowed.',
  INVALID_TASK_SCOPE: 'Use an existing task record ID, save that task in this commit, or omit task when the summary is not task-specific.',
  INVALID_DEPENDENCIES: 'Use at most 20 dependsOn entries, each with exactly one record id or project-relative file path. A record cannot depend on itself.',
  MISSING_DEPENDENCY: 'Recall the dependency ID. Use an existing record or create it in the same commit; do not invent a replacement basis.',
  DEPENDENCY_RETIRED: 'Review the retired basis and identify a supported current basis before changing dependsOn.',
  DEPENDENCY_VERSION: 'Recall the dependency and recheck the claim against its current version before retrying.',
  DEPENDENCY_HASH: 'Read the dependency file and recheck the claim against its current contents before retrying.',
  AUTHORITY_CHANGED: 'Reread the relevant project rules and sources, then reconsider the changes before retrying.',
  SOURCE_ORIGIN_REQUIRED: 'Add source.origin="user" for an exact current user quote, origin="file" with a relative path and exact file quote, or origin="episode" with the ID of an earlier message and an exact quote from it.',
  SOURCE_REQUIRED: 'Provide one source: the current user message, a stored episode, or a project file, with an exact quote.',
  SOURCE: 'Use exactly one source and a verbatim quote present in it. For the current user use origin="user" and quote only; for a file use origin="file", path and quote; for a stored message use origin="episode", episode and quote.',
  USER_SOURCE_REQUIRED: 'Use an exact quote from a real current user prompt, or origin="episode" with the full ID of an original stored user message. Agent-attributed curation guides are not user sources; keep unsupported assistant inferences proposed.',
  RATIONALE_REQUIRED: 'Supply a non-empty rationale of at most 2000 characters for a decision.',
  RATIONALE_SOURCE_REQUIRED: 'Copy rationale exactly from source.quote. Put additional interpretation in text or keep the decision proposed.',
  SOURCE_DERIVED: 'Use the original episode or source file; RECORDS.md, Wiki pages and runtime data are derived, not independent evidence.',
  SECRET_PATTERN: 'Remove credentials from the proposed text and summary. Use a non-secret exact excerpt as evidence.',
  PATH: 'Use a project-relative path that resolves inside this project, without links outside it.',
  COMMITS_PAUSED: 'Ask the user to run /huimem resume if saving should resume. Reads remain available; repeated commit calls will not clear the pause.',
  PROJECT_MEMORY_NOT_ENABLED: 'Ask the user to run /huimem init in the project root, then send a new message.',
  PROJECT_MEMORY_OFF: 'Memory is switched off for this project. Ask the user to run /huimem on if this work should be remembered; otherwise continue without memory and do not write .memory files by hand.',
  INVALID_MEMORY_SCOPE: 'Use scope=project (the default), personal, or session. Scope does not accept a filesystem root or enable personal memory.',
  PERSONAL_MEMORY_NOT_ENABLED: 'Ask the human to run /huimem personal on in this OMP profile. Project files and model tool calls cannot enable personal memory.',
  PERSONAL_MEMORY_UNAVAILABLE: 'Use a native OMP host with getAgentDir support, or inject the host agentDir when embedding the extension. Never substitute a project-controlled root.',
  SESSION_MEMORY_UNAVAILABLE: 'Start or resume a native OMP session with a non-empty session ID. Session scope cannot use a shared fallback ID.',
  INVALID_PERSONAL_SETTINGS: 'Preserve and repair the profile-owned huimem/permissions.json as a JSON object, then use /huimem personal on|off. Invalid permissions fail closed.',
  EPISODE_ID_COLLISION: 'Keep both original sources unchanged. Select the correct original episode; never overwrite an existing episode ID with different content or provenance.',
  SCOPE_PATH: 'Use an unlinked profile/project runtime directory. Remove the symbolic-link indirection outside the active agent; never redirect scoped memory to another root.',
  MAIN_AGENT_REQUIRED: 'Run /huimem learn from the main agent. Subagents return findings to their parent instead of initiating curation.',
  INVALID_WIKI_ACTION: 'Use op=wiki with action=list, read, publish, lint, history, plan or discover.',
  INVALID_LEARN_ACTION: 'Use op=learn action=status, next, read or complete. Reading a packet never acknowledges it.',
  LEARN_INPUT: 'Read one packet with op=learn action=next. Complete its exact id with a deliberate summary and outcome=recorded plus checked record versions, or nothing-durable with records=[].',
  LEARN_RECORD: 'Recall and check the exact current result record versions. Missing, changed, STALE or unsupported evidence cannot close a review.',
  LEARN_CONFLICT: 'Inspect op=learn action=read id=<packet> for an existing receipt, or request next again. Do not overwrite a different acknowledgement or skip a changed source.',
  LEARN_STATE: 'Preserve original episodes and learning metadata. Inspect the damaged or missing anchor and restore only verified data; do not clear the cursor to hide the error.',
  LEARN_ABORTED: 'The review was cancelled without advancing coverage. Request next when ready; saved source-backed records remain available.',
  INVALID_INDEX_ACTION: 'Use op=index action=status to inspect the derived index, or action=rebuild to rebuild it from original stored sources.',
  WIKI_ID: 'Use a bounded ASCII Wiki slug without traversal, or list existing pages with op=wiki action=list.',
  WIKI_SOURCE: 'Recall and verify exact current source record versions. Publish only fresh, supported sources; a Wiki summary cannot promote proposals or retired records.',
  WIKI_TITLE: 'Supply a non-empty short page title within the Wiki title limit.',
  WIKI_BODY: 'Supply a non-empty concise body within the Wiki body limit; preserve unsupported claims as unknown rather than inventing evidence.',
  WIKI_SECRET: 'Remove credentials and secret patterns from the title and body before publishing.',
  WIKI_CONFLICT: 'Read the current page and use its returned hash as expectedHash. Preserve concurrent edits.',
  WIKI_PATH: 'Use Wiki IDs rather than arbitrary output paths; generated pages must stay inside the selected scope Wiki directory without symbolic links.',
  WIKI_CORRUPT: 'Preserve the page and its human edits. Inspect the reported metadata or content corruption outside the agent before republishing; do not overwrite it blindly.',
  WIKI_QUERY: 'Use a bounded plain-text query for Wiki listing.',
  WIKI_LIMIT: 'Use a positive integer within the Wiki result limit.',
  GIT_PATH: 'Use a project-relative, non-traversing path inside the selected evidence root. Git history is not proof of rationale.',
  GIT_LIMIT: 'Use a positive integer within the supported Git history limit.',
  GIT_ABORTED: 'The history request was cancelled. Continue without claiming that Git history was checked.',
  GIT_TIMEOUT: 'Narrow the history path or result limit, then request Git history again only if needed.',
  GIT_OUTPUT: 'Narrow the history request; the local Git output exceeded its bounded response limit.',
  GIT_HISTORY: 'Check that the selected evidence root is a readable Git repository and inspect the reported Git error; do not invent history.',
  DATABASE_INTEGRITY: 'Stop memory writes and preserve the database and its WAL files. Restore a verified backup or investigate the corruption before reopening; do not delete the database to silence the error.',
  UNSUPPORTED_SCHEMA: 'Use a plugin version compatible with this database schema, or restore a compatible backup. Do not manually change the schema marker.',
  SCHEMA_MIGRATION_PENDING: 'Back up .memory/runtime if needed, then start a normal OMP conversation in this project; this plugin initializes an empty database or migrates schema 1. Doctor itself never writes. Do not change the schema marker manually.',
  FOREIGN_SCHEMA: 'The memory path contains a database that is not a huimem database. Preserve it, move it aside or choose a clean .memory/runtime/state.sqlite, then initialize huimem; do not let this plugin migrate the foreign schema.',
  UNKNOWN_OPERATION: 'Use status, recall, episodes, history, evidence, doctor, commit, wiki, index or learn as op.',
  INVALID_SETTINGS: 'Correct .memory/settings.json as a JSON object; required accepts at most 10 valid record IDs. Keep a copy before editing.',
  INVALID_TODO: 'Correct .memory/todo.json: tasks must be an array with unique IDs and valid task statuses. Compare with the registry before editing.',
  INVALID_POLICY: 'Correct .memory/architecture.json as JSON: with configured true, each rule needs an id, a non-empty files array of project-relative globs without "..", and a non-empty forbidden string. Keep a copy before editing.',
  POLICY_SCAN_LIMIT: 'Narrow the rule files globs in .memory/architecture.json; one rule may match at most 10000 files.',
  EISDIR: 'A directory stands where a file is expected. Move it aside and restore the expected file; do not delete its contents unreviewed.',
  DOCTOR_FILE_TOO_LARGE: 'Inspect the named file separately; doctor limits individual diagnostic document reads to 1 MiB. Do not truncate evidence to suppress this finding.',
};

export function memoryToolError(error:unknown,operation?:string,explicitCode?:string) {
  const legacy=String(error);
  const message=error instanceof Error ? error.message : legacy;
  const prefix=message.match(/^([A-Z][A-Z0-9_]*)(?=:|$)/)?.[1];
  const native=typeof (error as any)?.code==='string' ? (error as any).code : undefined;
  const code=explicitCode ?? native ?? prefix ?? 'MEMORY_ERROR';
  const storage=/^SQLITE/.test(code) || ['EACCES','EPERM','EROFS','ENOSPC','EIO'].includes(code);
  // A malformed or foreign database file is an integrity problem, not a permissions or space problem.
  const integrity=/^SQLITE_(CORRUPT|NOTADB)/.test(code);
  const fix=FIXES[code] ?? (integrity ? FIXES.DATABASE_INTEGRITY : storage
    ? 'Check project storage permissions, available space and memory health with /huimem. Resolve the storage problem before retrying a write.'
    : 'Inspect the error and memory state with /huimem. Correct its cause before retrying; do not repeat the unchanged request.');
  const diagnostic:MemoryDiagnostic={severity:'error',code,message,fix,target:operation ? `project_memory.${operation}` : 'project_memory'};
  return {
    content:[{type:'text' as const,text:legacy+'\nFix: '+fix}],
    details:{error:legacy,...diagnostic},
    isError:true as const,
  };
}
