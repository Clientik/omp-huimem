import { describe, test, expect } from 'bun:test';
import { MemoryStore } from '../src/memory/core';

// ЗАМЕРЕНО 2026-10-15 на настоящем проекте HUICAD: выдержка резалась одним срезом, и три ADR
// исчезали из блока целиком — модель не знала, что они есть. Бюджет не вырос, раздача честная.
describe('canonical preview', () => {
  const doc = (path: string, size: number, mark = 'x') => ({ path, text: mark.repeat(size) });

  test('every document is named, even when its text does not fit', () => {
    const out = MemoryStore.preview([doc('.memory/MEMORY.md', 5000, 'a'), doc('.memory/PROJECT.md', 5000, 'b'),
      doc('.memory/todo.json', 5000, 'c'), doc('.memory/architecture.json', 5000, 'd')]);
    for (const p of ['.memory/MEMORY.md', '.memory/PROJECT.md', '.memory/todo.json', '.memory/architecture.json'])
      expect(out).toContain(p);
    // Содержимое каждого файла присутствует: место поделено, а не отдано первым по алфавиту.
    for (const mark of ['a', 'b', 'c', 'd']) expect(out).toContain(mark.repeat(40));
    expect(out.length).toBeLessThanOrEqual(2400);
  });

  test('the budget is never exceeded, whatever the shape', () => {
    const shapes = [
      [doc('.memory/MEMORY.md', 100000)],
      Array.from({ length: 40 }, (_, i) => doc(`.memory/doc${i}.md`, 3000)),
      [doc('.memory/MEMORY.md', 0), doc('.memory/PROJECT.md', 0)],
      [{ path: '.memory/adr/0001.md', nameOnly: true }, { path: '.memory/adr/0002.md', nameOnly: true }],
      [doc('.memory/MEMORY.md', 1200), { path: '.memory/adr/a.md', nameOnly: true }],
    ];
    for (const items of shapes) expect(MemoryStore.preview(items as any).length).toBeLessThanOrEqual(2400);
    // Крошечный бюджет: имена остаются, текста нет — молчаливой потери файла не происходит.
    const tight = MemoryStore.preview([doc('.memory/MEMORY.md', 5000), doc('.memory/todo.json', 5000)], 120);
    expect(tight).toContain('.memory/MEMORY.md');
    expect(tight).toContain('.memory/todo.json');
    expect(tight).toContain('[Not shown here; read the file.]');
  });

  test('a short document does not hoard space it cannot use', () => {
    const out = MemoryStore.preview([doc('.memory/architecture.json', 60, 's'), doc('.memory/MEMORY.md', 5000, 'm')]);
    expect(out).toContain('s'.repeat(60));
    // Остаток короткого файла уходит длинному, до его собственного предела в 900 символов.
    expect(out).toContain('m'.repeat(900));
  });

  test('per-document text stays capped at 900 characters', () => {
    const out = MemoryStore.preview([doc('.memory/MEMORY.md', 5000, 'm')]);
    expect(out).toContain('m'.repeat(900));
    expect(out).not.toContain('m'.repeat(901));
  });

  test('documents listed by name share one note instead of a copy each', () => {
    const out = MemoryStore.preview([doc('.memory/MEMORY.md', 500),
      { path: '.memory/adr/0001.md', nameOnly: true }, { path: '.memory/adr/0002.md', nameOnly: true },
      { path: '.memory/adr/README.md', nameOnly: true }]);
    expect(out.match(/read on demand/g)?.length).toBe(1);
    for (const p of ['.memory/adr/0001.md', '.memory/adr/0002.md', '.memory/adr/README.md']) expect(out).toContain(p);
  });

  test('windows paths are reported with forward slashes', () => {
    expect(MemoryStore.preview([{ path: '.memory\\adr\\0001.md', nameOnly: true }])).toContain('.memory/adr/0001.md');
  });
});
