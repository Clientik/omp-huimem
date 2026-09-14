import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Настройки принадлежат проекту и лежат рядом со знаниями, а не в конфиге OMP:
// чужой файл плагин не переписывает. Отсутствие файла — нормальное состояние.
export const SETTINGS_PATH = '.memory/settings.json';

// required — ID записей, которые выдаются в каждом ходе независимо от вопроса. Задаёт только
// пользователь командой /huimem require; правка файла инструментами модели заблокирована.
export type Settings = { recallBudget: number; injectionLimit: number; required: string[] };
export const REQUIRED_MAX = 10;
const requiredIds = (v: unknown): string[] => Array.isArray(v)
  ? [...new Set(v.filter((x): x is string => typeof x === 'string' && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(x)))].slice(0, REQUIRED_MAX) : [];

// Пределы не косметические. recall в core.ts сам обрезает бюджет по 12000, а слишком
// маленькая вставка делает память бесполезной, слишком большая — съедает окно модели.
export const LIMITS = {
  recallBudget: { min: 500, max: 12000, default: 3200 },
  // Нижняя граница 3000: ЗАМЕРЕНО 2026-09-14, обязательные правила блока с пометкой бюджета занимают
  // 2210–2300 символов (пауза, сохранённый чекпоинт); при прежних 2000 правила commit опускались.
  injectionLimit: { min: 3000, max: 16000, default: 8000 },
} as const;

const clamp = (v: unknown, l: { min: number; max: number; default: number }) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(l.max, Math.max(l.min, Math.round(v))) : l.default;

export function readSettings(root: string): Settings {
  try {
    const raw = JSON.parse(readFileSync(resolve(root, SETTINGS_PATH), 'utf8'));
    return {
      recallBudget: clamp(raw?.recallBudget, LIMITS.recallBudget),
      injectionLimit: clamp(raw?.injectionLimit, LIMITS.injectionLimit),
      required: requiredIds(raw?.required),
    };
  } catch {
    // Повреждённый или отсутствующий файл не должен ронять сессию: работаем на значениях
    // по умолчанию. Молчаливой подмены нет — /huimem показывает, что читается сейчас.
    return { recallBudget: LIMITS.recallBudget.default, injectionLimit: LIMITS.injectionLimit.default, required: [] };
  }
}

export function writeSettings(root: string, next: Partial<Settings>): Settings {
  const merged = { ...readSettings(root), ...next };
  const value: Settings = {
    recallBudget: clamp(merged.recallBudget, LIMITS.recallBudget),
    injectionLimit: clamp(merged.injectionLimit, LIMITS.injectionLimit),
    required: requiredIds(merged.required),
  };
  writeFileSync(resolve(root, SETTINGS_PATH), JSON.stringify(value, null, 2) + '\n');
  return value;
}
