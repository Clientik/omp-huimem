import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Настройки принадлежат проекту и лежат рядом со знаниями, а не в конфиге OMP:
// чужой файл плагин не переписывает. Отсутствие файла — нормальное состояние.
export const SETTINGS_PATH = '.memory/settings.json';

// required — ID записей, которые выдаются в каждом ходе независимо от вопроса. Задаёт только
// пользователь командой /huimem require; правка файла инструментами модели заблокирована.
// enabled — выключатель памяти для этого проекта. Он принадлежит проекту и переживает перезапуск,
// в отличие от pause: пауза запрещает только commit и живёт в одном процессе OMP.
// documents — документы памяти, которые проект добавил к набору плагина. ЗАМЕРЕНО 2026-10-17
// на живом HUICAD: в проекте лежал .memory/DESIGN.md на 17 КБ, модель прочитала его 9 раз и
// сохранила из него запись, а блок при этом утверждал «nothing else is project memory» —
// неправду. Файла не было ни в перечне, ни в хеше канонического набора.
// subagentBlock — сколько памяти получает подагент. ЗАМЕРЕНО 2026-10-17 на живом HUICAD:
// четыре исследователя получили 98 вставок полного блока по 7,9 КБ за 385 секунд и не сделали
// ни одного вызова project_memory за 264 вызова инструментов. Правила сохранения им не нужны:
// они возвращают находки родителю, а сохраняет родитель. 'short' — состояние, правила
// доказательств, список файлов и записи; 'off' — ничего; 'full' — как у главного агента.
export type SubagentBlock = 'short' | 'full' | 'off';
export type Settings = { enabled: boolean; recallBudget: number; injectionLimit: number;
  required: string[]; documents: string[]; subagentBlock: SubagentBlock };
const subagentBlock = (v: unknown): SubagentBlock => v === 'full' || v === 'off' ? v : 'short';
export const REQUIRED_MAX = 10;
export const DOCUMENTS_MAX = 10;
const requiredIds = (v: unknown): string[] => Array.isArray(v)
  ? [...new Set(v.filter((x): x is string => typeof x === 'string' && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(x)))].slice(0, REQUIRED_MAX) : [];
// Только внутри .memory и только то, что не входит в набор иначе: ADR подбираются глоблм,
// RECORDS.md генерируется, settings.json и runtime — не документы памяти.
const FIXED = ['.memory/MEMORY.md', '.memory/PROJECT.md', '.memory/todo.json', '.memory/architecture.json'];
export const documentPath = (x: unknown): x is string => typeof x === 'string'
  && /^\.memory\/[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(x) && !x.includes('..') && !x.endsWith('/')
  && !FIXED.includes(x) && !x.startsWith('.memory/adr/') && !x.startsWith('.memory/runtime/')
  && x !== '.memory/RECORDS.md' && x !== '.memory/settings.json';
const documentList = (v: unknown): string[] => Array.isArray(v)
  ? [...new Set(v.filter(documentPath))].sort().slice(0, DOCUMENTS_MAX) : [];

// Пределы не косметические. recall в core.ts сам обрезает бюджет по 12000, а слишком
// маленькая вставка делает память бесполезной, слишком большая — съедает окно модели.
export const LIMITS = {
  // ЗАМЕРЕНО 2026-10-17 на живом HUICAD: выдержка канонических файлов занимала 2400 символов
  // блока и была заменена списком примерно на 600. Освободившееся отдано реестру: при 14
  // записях блок упирался в предел, и записи с проверенными источниками уже вытеснялись,
  // хотя именно они — сама память, а не документы вокруг неё.
  // ЗАМЕРЕНО 2026-10-19 на копии живого HUICAD (audit/release-0.6.8): реестр дорос до 20 записей
  // по ~650 символов каждая — 13 КБ, которые в блок не поместятся никогда. При пределе 8000 после
  // пола чекпоинта в блок доходило 5 записей, а строка с ID последних своих сообщений (её берут
  // для source.answers) вытеснялась совсем. Поднято ровно настолько, чтобы вернуть прежние 7
  // записей вместе с новыми гарантиями: +1000 символов блока — это ≈300 токенов на ход.
  recallBudget: { min: 500, max: 12000, default: 5200 },
  // Нижняя граница 3000: ЗАМЕРЕНО 2026-09-14, обязательные правила блока с пометкой бюджета занимают
  // 2210–2300 символов (пауза, сохранённый чекпоинт); при прежних 2000 правила commit опускались.
  injectionLimit: { min: 3000, max: 16000, default: 9000 },
} as const;

const clamp = (v: unknown, l: { min: number; max: number; default: number }) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(l.max, Math.max(l.min, Math.round(v))) : l.default;

// Файл настроек переживает смену версии плагина в обе стороны. ПРИЧИНА 2026-10-15:
// writeSettings пересобирал файл из известных полей, поэтому любая настройка, которой эта
// версия не знает, молча исчезала — достаточно было один раз выполнить /huimem off сборкой
// постарше, чтобы потерять настройки поновее. Незнакомые ключи сохраняются как есть.
function readRaw(root: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(resolve(root, SETTINGS_PATH), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  } catch { return {}; }
}
const KNOWN = ['enabled', 'recallBudget', 'injectionLimit', 'required', 'documents', 'subagentBlock'];
export function unknownKeys(root: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(readRaw(root)).filter(([k]) => !KNOWN.includes(k)));
}

export function readSettings(root: string): Settings {
  try {
    const raw = JSON.parse(readFileSync(resolve(root, SETTINGS_PATH), 'utf8'));
    return {
      // Отсутствие поля — память включена: прежние проекты продолжают работать как раньше.
      enabled: raw?.enabled !== false,
      recallBudget: clamp(raw?.recallBudget, LIMITS.recallBudget),
      injectionLimit: clamp(raw?.injectionLimit, LIMITS.injectionLimit),
      required: requiredIds(raw?.required),
      documents: documentList(raw?.documents),
      subagentBlock: subagentBlock(raw?.subagentBlock),
    };
  } catch {
    // Повреждённый или отсутствующий файл не должен ронять сессию: работаем на значениях
    // по умолчанию. Молчаливой подмены нет — /huimem показывает, что читается сейчас.
    return { enabled: true, recallBudget: LIMITS.recallBudget.default, injectionLimit: LIMITS.injectionLimit.default, required: [], documents: [], subagentBlock: 'short' };
  }
}

export function writeSettings(root: string, next: Partial<Settings>): Settings {
  const merged = { ...readSettings(root), ...next };
  const value: Settings = {
    enabled: merged.enabled !== false,
    recallBudget: clamp(merged.recallBudget, LIMITS.recallBudget),
    injectionLimit: clamp(merged.injectionLimit, LIMITS.injectionLimit),
    required: requiredIds(merged.required),
    documents: documentList(merged.documents),
    subagentBlock: subagentBlock(merged.subagentBlock),
  };
  // Известные поля перезаписываются проверенными значениями, чужие остаются нетронутыми.
  writeFileSync(resolve(root, SETTINGS_PATH), JSON.stringify({ ...unknownKeys(root), ...value }, null, 2) + '\n');
  return value;
}
