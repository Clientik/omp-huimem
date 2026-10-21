import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/core';
import { copyEpisodeEvidence, guardScopePath, personalRoot, readPersonalSettings, sessionRoot, setPersonalEnabled } from '../src/memory/scopes';

describe('local memory scopes', () => {
  test('profile permission is explicit, private, preserves unknown keys and fails closed', () => {
    const dir=mkdtempSync(join(tmpdir(),'huimem-scopes-'));
    try {
      expect(readPersonalSettings(dir).enabled).toBe(false);
      setPersonalEnabled(dir,true);
      expect(readPersonalSettings(dir).enabled).toBe(true);
      const path=join(dir,'huimem','permissions.json');
      writeFileSync(path,JSON.stringify({enabled:true,extra:'keep'}));
      setPersonalEnabled(dir,false);
      expect(JSON.parse(readFileSync(path,'utf8'))).toEqual({enabled:false,extra:'keep'});
      writeFileSync(path,'not json');
      expect(readPersonalSettings(dir).enabled).toBe(false);
      expect(() => setPersonalEnabled(dir,true)).toThrow('INVALID_PERSONAL_SETTINGS');
      expect(personalRoot(dir)).not.toBe(personalRoot(join(dir,'other-profile')));
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  test('native session identity is stable, isolated and cannot escape runtime', () => {
    expect(sessionRoot('/project','resume')).toBe(sessionRoot('/project','resume'));
    expect(sessionRoot('/project','resume')).not.toBe(sessionRoot('/project','fork'));
    expect(sessionRoot('/project','../../elsewhere')).toContain('scopes');
    expect(() => sessionRoot('/project','')).toThrow('SESSION_MEMORY_UNAVAILABLE');
  });
  test('scope paths reject linked directories before opening storage or permission files', () => {
    const dir=mkdtempSync(join(tmpdir(),'huimem-scope-link-'));
    try {
      mkdirSync(join(dir,'outside'));
      symlinkSync(join(dir,'outside'),join(dir,'linked'),'junction');
      expect(() => guardScopePath(join(dir,'linked','state.sqlite'))).toThrow('SCOPE_PATH');
      expect(() => personalRoot(join(dir,'linked'))).toThrow('SCOPE_PATH');
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  test('only selected original episodes transfer, with immutable identity and collision checks', () => {
    const dir=mkdtempSync(join(tmpdir(),'huimem-evidence-'));
    const source=new MemoryStore(join(dir,'source')),target=new MemoryStore(join(dir,'target'));
    try {
      const question=source.capture('original','assistant','Which units?');
      const answer=source.capture('original','user','Metric units.');
      source.capture('original','user','Unrelated private text.');
      copyEpisodeEvidence(target,source,question);
      copyEpisodeEvidence(target,source,answer);
      expect(target.episode(answer)).toEqual(source.episode(answer));
      const count=target.db.query<{n:number},[]>('SELECT COUNT(*) n FROM episodes').get();
      expect(count?.n).toBe(2);
      copyEpisodeEvidence(target,source,answer);
      target.db.query('UPDATE episodes SET text=? WHERE id=?').run('Changed',answer);
      expect(() => copyEpisodeEvidence(target,source,answer)).toThrow('EPISODE_ID_COLLISION');
    } finally {source.close();target.close();rmSync(dir,{recursive:true,force:true});}
  });
});
