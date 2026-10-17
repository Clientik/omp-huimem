import { describe, test, expect } from 'bun:test';
import { MemoryStore } from '../src/memory/core';

// ЗАМЕРЕНО 2026-10-17 на живом HUICAD (audit/huicad-after-0.6.6): выдержка канонических файлов
// стоила 2400 из 8000 символов блока, при 14 записях блок упирался в предел и уже вытеснял
// реестр с чекпоинтом, а сами файлы модель всё равно читала — 51 раз за сессию. Остаётся то,
// за чем в выдержку и ходили: что существует, зачем это и какого размера.
describe('canonical file list', () => {
  const doc = (path: string, size?: number) => ({ path, size });

  test('every canonical file is named with its purpose and size', () => {
    const out = MemoryStore.listing([doc('.memory/MEMORY.md', 20790), doc('.memory/PROJECT.md', 11798),
      doc('.memory/todo.json', 5741), doc('.memory/architecture.json', 32)]);
    expect(out).toContain('.memory/MEMORY.md — facts and constraints · 20790 chars');
    expect(out).toContain('.memory/todo.json — task state · 5741 chars');
    expect(out).toContain('does not verify their explanations');
    // Прежняя выдержка на тех же файлах занимала 2400 символов.
    expect(out.length).toBeLessThan(400);
  });

  test('a missing canonical file is named as missing, not silently dropped', () => {
    const out = MemoryStore.listing([doc('.memory/MEMORY.md', 10), doc('.memory/architecture.json')]);
    expect(out).toContain('.memory/architecture.json — architecture rules · MISSING');
  });

  test('a document added in settings is named as such', () => {
    const out = MemoryStore.listing([{ path: '.memory/DESIGN.md', size: 17395, label: 'project document, added in settings' }]);
    expect(out).toContain('.memory/DESIGN.md — project document, added in settings · 17395 chars');
  });

  test('many ADRs fold into one line instead of pushing the rest out', () => {
    const items = [doc('.memory/MEMORY.md', 500), doc('.memory/PROJECT.md', 500),
      ...Array.from({ length: 60 }, (_, i) => doc(`.memory/adr/${String(i).padStart(4, '0')}-decision.md`, 2000))];
    const out = MemoryStore.listing(items);
    expect(out).toContain('.memory/MEMORY.md');
    expect(out).toContain('.memory/PROJECT.md');
    expect(out).toContain('60 ADR document(s) in .memory/adr');
    expect(out.length).toBeLessThanOrEqual(1200);
  });

  test('a few ADRs are listed by name', () => {
    const out = MemoryStore.listing([doc('.memory/MEMORY.md', 500),
      doc('.memory/adr/0001-baseline.md', 4800), doc('.memory/adr/0002-hui-vue.md', 2600)]);
    expect(out).toContain('.memory/adr/0001-baseline.md · 4800 chars');
    expect(out).toContain('.memory/adr/0002-hui-vue.md · 2600 chars');
  });

  test('the budget holds even when nothing can be folded', () => {
    const items = Array.from({ length: 200 }, (_, i) => doc(`.memory/doc-with-a-long-name-${i}.md`, 1000));
    const out = MemoryStore.listing(items);
    expect(out.length).toBeLessThanOrEqual(1200);
    expect(out).toContain('more canonical document(s) not listed here');
    expect(out).toContain('.memory/doc-with-a-long-name-0.md');
  });

  test('windows paths are reported with forward slashes', () => {
    expect(MemoryStore.listing([{ path: String.raw`.memory\adr\0001.md`, size: 10 }])).toContain('.memory/adr/0001.md');
  });
});
