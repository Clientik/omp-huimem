import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Настройки принадлежат проекту и лежат рядом со знаниями, а не в конфиге OMP:
// чужой файл плагин не переписывает. Отсутствие файла — нормальное состояние.
export const SETTINGS_PATH = '.memory/settings.json';

// required — ID записей, которые выдаются в каждом ходе независимо от вопроса. Задаёт только
// пользователь командой /huimem require; правка файла инструментами модели заблокирована.
// enabled — выключатель памяти для этого проекта. Он принадлежит проекту и переживает перезапуск,
// в отличие от pause: пауза запрещает только commit и живёт в одном процессе OMP.
export type Settings = { enabled: boolean; recallBudget: number; injectionLimit: number; required: string[] };
export const REQUIRED_MAX = 10;
const requiredIds = (v: unknown): string[] => Array.isArray(v)
  ? [...new Set(v.filter((x): x is string => typeof x === 'string' && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(x)))].slice(0, REQUIRED_MAX) : [];

// Пределы не косметические. recall в core.ts сам обрезает бюджет по 12000, а слишком
// маленькая вставка делает память бесполезной, слишком большая — съедает окно модели.
export const LIMITS = {
  // ЗАМЕРЕНО 2026-10-17 на живом HUICAD: выдержка канонических файлов занимала 2400 символов
  // блока и была заменена списком примерно на 600. Освободившееся отдано реестру: при 14
  // записях блок упирался в предел, и записи с проверенными источниками уже вытеснялись,
  // хотя именно они — сама память, а не документы вокруг неё.
  recallBudget: { min: 500, max: 12000, default: 4800 },
  // Нижняя граница 3000: ЗАМЕРЕНО 2026-09-14, обязательные правила блока с пометкой бюджета занимают
  // 2210–2300 символов (пауза, сохранённый чекпоинт); при прежних 2000 правила commit опускались.
  injectionLimit: { min: 3000, max: 16000, default: 8000 },
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
const KNOWN = ['enabled', 'recallBudget', 'injectionLimit', 'required'];
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
    };
  } catch {
    // Повреждённый или отсутствующий файл не должен ронять сессию: работаем на значениях
    // по умолчанию. Молчаливой подмены нет — /huimem показывает, что читается сейчас.
    return { enabled: true, recallBudget: LIMITS.recallBudget.default, injectionLimit: LIMITS.injectionLimit.default, required: [] };
  }
}

export function writeSettings(root: string, next: Partial<Settings>): Settings {
  const merged = { ...readSettings(root), ...next };
  const value: Settings = {
    enabled: merged.enabled !== false,
    recallBudget: clamp(merged.recallBudget, LIMITS.recallBudget),
    injectionLimit: clamp(merged.injectionLimit, LIMITS.injectionLimit),
    required: requiredIds(merged.required),
  };
  // Известные поля перезаписываются проверенными значениями, чужие остаются нетронутыми.
  writeFileSync(resolve(root, SETTINGS_PATH), JSON.stringify({ ...unknownKeys(root), ...value }, null, 2) + '\n');
  return value;
}
