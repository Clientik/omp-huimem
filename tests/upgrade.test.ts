import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/core';
import { PLUGIN_VERSION, UNKNOWN_SPAN, compareVersions, upgradeLine, upgradeNotes } from '../src/memory/version';
import { readSettings, writeSettings, unknownKeys } from '../src/memory/settings';
import { diagnoseMemory } from '../src/memory/doctor';

const project = () => {
  const dir = mkdtempSync(join(import.meta.dir, 'upgrade-test-'));
  mkdirSync(join(dir, '.memory'), { recursive: true });
  writeFileSync(join(dir, '.memory/MEMORY.md'), '# Память проекта');
  return dir;
};
const stamp = (dir: string, version: string | null) => {
  const s = new MemoryStore(dir);
  try {
    if (version === null) s.db.query("DELETE FROM meta WHERE key='plugin'").run();
    else s.db.query("INSERT OR REPLACE INTO meta VALUES ('plugin',?)").run(version);
    s.db.query("DELETE FROM meta WHERE key='upgradeFrom'").run();
  } finally { s.close(); }
};

describe('plugin version', () => {
  test('versions compare by number, not by string', () => {
    expect(compareVersions('0.6.10', '0.6.9')).toBe(1);
    expect(compareVersions('0.6.4', '0.6.4')).toBe(0);
    expect(compareVersions('0.7', '0.6.9')).toBe(1);
    expect(compareVersions('0.6.3', '0.6.5')).toBe(-1);
  });

  test('the summary covers every version between the old build and this one', () => {
    const notes = upgradeNotes('0.6.3', '0.6.5');
    expect(notes.length).toBe(2);
    expect(notes[0]).toContain('0.6.4');
    expect(notes[1]).toContain('0.6.5');
    // Обновление на один шаг не повторяет чужие изменения.
    expect(upgradeNotes('0.6.4', '0.6.5')).toEqual([`0.6.5: ${notes[1].split(': ').slice(1).join(': ')}`]);
    // Та же версия — сказать нечего, строки нет.
    expect(upgradeNotes('0.6.5', '0.6.5')).toEqual([]);
    expect(upgradeLine('0.6.5', '0.6.5')).toBe('');
    // Метки нет вовсе — база от сборки до 0.6.5: выдаётся вся сводка, иначе изменение
    // правил 0.6.4 не дойдёт до чата, запущенного на 0.6.3.
    expect(upgradeNotes(undefined, '0.6.5')).toEqual(notes);
    expect(upgradeNotes('unknown', '0.6.5')).toEqual(notes);
    expect(upgradeLine('unknown', '0.6.5')).toContain('PLUGIN_UPGRADED unknown -> 0.6.5');
    // Но сводка не растёт без предела: не длиннее трёх последних версий.
    expect(upgradeNotes(undefined, '0.6.5').length).toBeLessThanOrEqual(UNKNOWN_SPAN);
    const line = upgradeLine('0.6.3', '0.6.5');
    expect(line).toContain('PLUGIN_UPGRADED 0.6.3 -> 0.6.5');
    expect(line).toContain('the rules in this block are the current ones');
  });

  test('a fresh database is stamped without announcing an upgrade', () => {
    const dir = project(); try {
      const s = new MemoryStore(dir);
      try {
        expect(s.writerVersion()).toBe(PLUGIN_VERSION);
        expect(s.pendingUpgrade()).toBeNull();
      } finally { s.close(); }
      // Повторное открытие той же версией тоже молчит.
      const again = new MemoryStore(dir);
      try { expect(again.pendingUpgrade()).toBeNull(); } finally { again.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('an existing database written by an older build marks the transition once', () => {
    const dir = project(); try {
      stamp(dir, '0.6.3');
      const s = new MemoryStore(dir);
      try {
        expect(s.writerVersion()).toBe(PLUGIN_VERSION);
        expect(s.pendingUpgrade()).toEqual({ from: '0.6.3', to: PLUGIN_VERSION });
        s.clearUpgrade();
        expect(s.pendingUpgrade()).toBeNull();
      } finally { s.close(); }
      // Отметка снята — следующее открытие её не возвращает: сводка доставляется один раз.
      const again = new MemoryStore(dir);
      try { expect(again.pendingUpgrade()).toBeNull(); } finally { again.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a database from a build that stamped nothing still reports the transition', () => {
    const dir = project(); try {
      stamp(dir, null);
      const s = new MemoryStore(dir);
      try { expect(s.pendingUpgrade()).toEqual({ from: 'unknown', to: PLUGIN_VERSION }); } finally { s.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('doctor reports the writer version read-only and never stamps it itself', () => {
    const dir = project(); try {
      stamp(dir, '0.6.3');
      const before = readFileSync(join(dir, '.memory/runtime/state.sqlite'));
      const report = diagnoseMemory(dir);
      const found = report.issues.find(i => i.code === 'PLUGIN_UPGRADE_PENDING');
      expect(found?.severity).toBe('info');
      expect(found?.message).toContain('0.6.3');
      expect(found?.message).toContain(PLUGIN_VERSION);
      expect(report.checked).toContain('plugin version');
      // Доктор только читает: метка осталась прежней, файл не переписан.
      const after = new MemoryStore(dir, { readOnly: true });
      try { expect(after.writerVersion()).toBe('0.6.3'); } finally { after.close(); }
      expect(readFileSync(join(dir, '.memory/runtime/state.sqlite')).equals(before)).toBe(true);

      // База новее запущенной сборки — это не ошибка: данные совместимы, пока схема та же.
      stamp(dir, '9.9.9');
      const newer = diagnoseMemory(dir).issues.find(i => i.code === 'PLUGIN_OLDER_THAN_DATABASE');
      expect(newer?.severity).toBe('info');
      expect(newer?.message).toContain('9.9.9');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('settings survive a version change', () => {
  test('unknown keys are preserved when this version rewrites the file', () => {
    const dir = project(); try {
      writeFileSync(join(dir, '.memory/settings.json'), JSON.stringify({
        enabled: true, recallBudget: 2000, futureSetting: { nested: [1, 2] }, retentionDays: 30,
      }, null, 2));
      expect(unknownKeys(dir)).toEqual({ futureSetting: { nested: [1, 2] }, retentionDays: 30 });
      writeSettings(dir, { enabled: false });
      const raw = JSON.parse(readFileSync(join(dir, '.memory/settings.json'), 'utf8'));
      expect(raw.enabled).toBe(false);
      expect(raw.recallBudget).toBe(2000);
      // Поля чужой версии на месте: /huimem off их больше не стирает.
      expect(raw.futureSetting).toEqual({ nested: [1, 2] });
      expect(raw.retentionDays).toBe(30);
      // И читаются они по-прежнему строго: незнакомое не влияет на известные значения.
      expect(readSettings(dir).enabled).toBe(false);
      expect(readSettings(dir).recallBudget).toBe(2000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a broken or missing file still yields defaults and keeps nothing unknown', () => {
    const dir = project(); try {
      expect(unknownKeys(dir)).toEqual({});
      writeFileSync(join(dir, '.memory/settings.json'), '{ not json');
      expect(unknownKeys(dir)).toEqual({});
      writeFileSync(join(dir, '.memory/settings.json'), '[1,2,3]');
      expect(unknownKeys(dir)).toEqual({});
      const value = writeSettings(dir, { enabled: true });
      expect(value.enabled).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, '.memory/settings.json'), 'utf8')).enabled).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
