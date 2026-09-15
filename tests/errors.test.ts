import {test,expect} from 'bun:test';
import {memoryToolError} from '../src/memory/errors';

test.each([
  ['VERSION_CONFLICT: task-a','VERSION_CONFLICT','expectedVersion'],
  ['MISSING_LINK','MISSING_LINK','record IDs'],
  ['INVALID_STATUS','INVALID_STATUS','doing'],
  ['SOURCE_ORIGIN_REQUIRED: missing origin','SOURCE_ORIGIN_REQUIRED','origin="user"'],
  ['DEPENDENCY_VERSION: db changed','DEPENDENCY_VERSION','recheck'],
])('a recovery hint accompanies %s without changing its original error',(message,code,hint)=>{
  const error=new Error(message),result=memoryToolError(error,'commit');
  expect(result.isError).toBe(true);
  expect(result.details).toMatchObject({error:String(error),severity:'error',code,message,target:'project_memory.commit'});
  expect(result.details.fix).toContain(hint);
  expect(result.content[0].text.startsWith(String(error)+'\nFix: ')).toBe(true);
});

test('disabled memory, pause and unknown failures have explicit recovery paths',()=>{
  const disabled=memoryToolError('PROJECT_MEMORY_NOT_ENABLED: memory is off','status');
  expect(disabled.details.code).toBe('PROJECT_MEMORY_NOT_ENABLED');
  expect(disabled.details.fix).toContain('/huimem init');
  expect(memoryToolError('COMMITS_PAUSED: paused','commit').details.fix).toContain('user');
  expect(memoryToolError(new Error('Unexpected failure'),'commit').details.code).toBe('MEMORY_ERROR');
});

test('native storage failures keep their code and do not suggest changing evidence',()=>{
  const error=Object.assign(new Error('disk full'),{code:'SQLITE_FULL'});
  const result=memoryToolError(error,'commit');
  expect(result.details.code).toBe('SQLITE_FULL');
  expect(result.details.fix).toContain('available space');
  expect(result.details.error).toBe(String(error));
});

test('database and schema errors have specific recovery guidance and IDs are explicitly ASCII',()=>{
  expect(memoryToolError(new Error('DATABASE_INTEGRITY')).details.fix).toContain('verified backup');
  for(const code of ['SQLITE_CORRUPT','SQLITE_NOTADB']) {
    const d=memoryToolError(Object.assign(new Error('malformed'),{code})).details;
    expect(d.code).toBe(code);
    expect(d.fix).toContain('verified backup');
  }
  expect(memoryToolError(new Error('UNSUPPORTED_SCHEMA')).details.fix).toContain('compatible');
  expect(memoryToolError(new Error('INVALID_ID')).details.fix).toContain('ASCII');
});
