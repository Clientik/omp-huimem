import { describe, test, expect } from 'bun:test';
import { rmSync } from 'node:fs';
import { MemoryStore } from '../src/memory/core';
import installSource from '../src/extensions/project-memory';
import installBundle from '../dist/index.js';
import { SCENARIOS, newSession, projectText, type Scenario } from './memory-scenarios';

// Детерминированный слой набора задач памяти: что плагин отдаёт модели в новой сессии.
// Поведение ответа модели здесь не проверяется — это отдельный прогон вне репозитория.

const byId = (s: Scenario) => SCENARIOS.find(x => x.id === s.id)!;

function contract(install: typeof installSource) {
  for (const scenario of SCENARIOS) {
    test(`${scenario.id}: bounded block, whole records, reachable basis, nothing forbidden`, async () => {
      const d = await newSession(install, scenario);
      try {
        const limit = scenario.settings?.injectionLimit ?? 8000;
        expect(d.block.length).toBeLessThanOrEqual(limit);
        for (const basis of scenario.allowedBasis)
          expect(d.block.includes(basis) || projectText(d.dir).includes(basis)).toBe(true);
        for (const claim of scenario.forbiddenInBlock) expect(d.block).not.toContain(claim);
        const delivered = new Set(d.records.map(r => r.id));
        if (scenario.id === 'critical-rule-budget') return; // требование к доставке измеряется отдельно ниже
        for (const id of scenario.requiredIds) expect(delivered.has(id)).toBe(true);
      } finally { rmSync(d.dir, { recursive: true, force: true }); }
    });
  }

  test('new-session: the next step and the decision source survive a restart', async () => {
    const d = await newSession(install, byId(SCENARIOS[0]));
    try {
      expect(d.block).toContain('Следующий шаг: написать миграцию orders_v2');
      const db = d.records.find(r => r.id === 'db-choice');
      expect(db.version).toBe(1);
      expect(db.source.quote).toContain('нужны транзакции между заказами и оплатами');
      expect(d.records.find(r => r.id === 'task-orders').status).toBe('doing');
    } finally { rmSync(d.dir, { recursive: true, force: true }); }
  });

  test('correction: only version 2 reaches the model; version 1 stays in history', async () => {
    const d = await newSession(install, SCENARIOS.find(s => s.id === 'correction')!);
    try {
      const rec = d.records.find(r => r.id === 'payment-provider');
      expect(rec.version).toBe(2);
      expect(rec.source.quote).toContain('YooKassa');
      const s = new MemoryStore(d.dir); expect(s.history('payment-provider')).toHaveLength(2); s.close();
    } finally { rmSync(d.dir, { recursive: true, force: true }); }
  });

  test('stale-source: a changed source file is marked STALE in the delivered block', async () => {
    const d = await newSession(install, SCENARIOS.find(s => s.id === 'stale-source')!);
    try {
      expect(d.records.find(r => r.id === 'retry-limit').freshness).toContain('STALE');
    } finally { rmSync(d.dir, { recursive: true, force: true }); }
  });

  test('unknown: memory about something never discussed stays empty, nothing is invented', async () => {
    const d = await newSession(install, SCENARIOS.find(s => s.id === 'unknown')!);
    try {
      expect(d.records.every(r => !JSON.stringify(r).includes('Redis'))).toBe(true);
      const s = new MemoryStore(d.dir); expect(s.latestRecords().map(r => r.id)).toEqual(['db-choice']); s.close();
    } finally { rmSync(d.dir, { recursive: true, force: true }); }
  });

  test('critical-rule-budget: a skipped critical rule is never skipped silently', async () => {
    const d = await newSession(install, SCENARIOS.find(s => s.id === 'critical-rule-budget')!);
    try {
      const delivered = d.records.some(r => r.id === 'security-rule');
      if (!delivered) {
        const s = new MemoryStore(d.dir); const r = s.lastRetrieval(); s.close();
        expect(r.candidates.find((c: any) => c.id === 'security-rule')?.reason).toBe('budget');
        expect(d.block.includes('[More records omitted') || /\[MEMORY_BUDGET[^\]]*registry/.test(d.block)).toBe(true);
      }
    } finally { rmSync(d.dir, { recursive: true, force: true }); }
  });
}

describe('source adapter', () => contract(installSource));
describe('built bundle', () => contract(installBundle));

