import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, parse, relative, resolve, sep } from 'node:path';
import type { MemoryStore } from './core';

export type MemoryScope = 'project' | 'personal' | 'session';
export type EpisodeEvidence = { id: string; session: string; role: string; text: string; time: string };
export type EpisodeReader = { episode(id: string): EpisodeEvidence | null | undefined };

export function memoryScope(value: unknown): MemoryScope {
  if (value === undefined || value === 'project') return 'project';
  if (value === 'personal' || value === 'session') return value;
  throw new Error('INVALID_MEMORY_SCOPE: use project, personal or session');
}

// Reject links in every existing path component, not only the final directory.
export function guardScopePath(path: string): string {
  const full=resolve(path), base=parse(full).root;
  let current=base;
  for (const part of full.slice(base.length).split(sep).filter(Boolean)) {
    current=join(current,part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error('SCOPE_PATH: memory scope paths must not traverse symbolic links');
    } catch (error) {
      if (!error || typeof error!=='object' || !('code' in error) || error.code!=='ENOENT') throw error;
    }
  }
  return full;
}
export function personalRoot(agentDir: string): string {
  if (!agentDir || !resolve(agentDir)) throw new Error('PERSONAL_MEMORY_UNAVAILABLE: host agent directory is unavailable');
  return guardScopePath(join(agentDir,'huimem','personal'));
}
export function sessionRoot(projectRoot: string, sessionId: string): string {
  if (typeof sessionId !== 'string' || !sessionId.trim())
    throw new Error('SESSION_MEMORY_UNAVAILABLE: native OMP session ID is required; start or resume a native session');
  const id=createHash('sha256').update(sessionId).digest('hex');
  return guardScopePath(join(projectRoot,'.memory','runtime','scopes',id));
}
export function privateScopeDirectory(path: string): string {
  const full=guardScopePath(path);
  mkdirSync(full,{recursive:true,mode:0o700});
  chmodSync(full,0o700);
  return full;
}
export function readPersonalSettings(agentDir: string): {enabled: boolean} {
  const path=guardScopePath(join(agentDir,'huimem','permissions.json'));
  if (!existsSync(path)) return {enabled:false};
  try {
    const value: unknown=JSON.parse(readFileSync(path,'utf8'));
    return {enabled: typeof value==='object' && value!==null && 'enabled' in value && value.enabled===true};
  } catch {return {enabled:false};}
}
export function setPersonalEnabled(agentDir: string, enabled: boolean): void {
  const dir=privateScopeDirectory(join(agentDir,'huimem')),path=guardScopePath(join(dir,'permissions.json'));
  let previous: Record<string,unknown>={};
  if (existsSync(path)) {
    try {
      const value: unknown=JSON.parse(readFileSync(path,'utf8'));
      if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('object required');
      previous={...value};
    } catch {throw new Error('INVALID_PERSONAL_SETTINGS: preserve and repair the profile huimem permissions.json object');}
  }
  const temporary=join(dir,`.permissions-${randomUUID()}.tmp`);
  try {
    const fd=openSync(temporary,'wx',0o600);
    try {writeFileSync(fd,JSON.stringify({...previous,enabled})+'\n');fsyncSync(fd);} finally {closeSync(fd);}
    renameSync(temporary,path);chmodSync(path,0o600);
  } finally {if(existsSync(temporary)) unlinkSync(temporary);}
}
export function isWithinScope(path: string, root: string): boolean {
  const rel=relative(resolve(root),resolve(path));
  return rel==='' || (!rel.startsWith('..'+sep) && rel!=='..' && !parse(rel).root);
}
export function copyEpisodeEvidence(target: MemoryStore, source: EpisodeReader, id: string): void {
  const episode=source.episode(id);
  if (!episode || !['user','assistant'].includes(episode.role)) throw new Error('SOURCE: original episode is unavailable in this conversation');
  const old=target.episode(id);
  if (old) {
    if (['id','session','role','text','time'].some(key => old[key]!==episode[key as keyof EpisodeEvidence]))
      throw new Error('EPISODE_ID_COLLISION: the selected episode ID already has different original content');
    return;
  }
  target.db.query('INSERT INTO episodes (id,session,role,text,time) VALUES (?,?,?,?,?)')
    .run(episode.id,episode.session,episode.role,episode.text,episode.time);
}
