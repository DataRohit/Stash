export const DEFAULT_MAX_PROJECTS = 5;
export const DEFAULT_MAX_COLLABORATORS = 5;
export const DEFAULT_MAX_PROJECT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_HISTORY_RETENTION_DAYS = 30;

export const HARD_MAX_PROJECTS = 1000;
export const HARD_MAX_COLLABORATORS = 500;
export const MIN_PROJECT_BYTES = 1024 * 1024;
export const HARD_MAX_PROJECT_BYTES = 1024 * 1024 * 1024;
export const MIN_HISTORY_RETENTION_DAYS = 1;
export const HARD_MAX_HISTORY_RETENTION_DAYS = 3650;

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const floored = Math.floor(value);
  if (floored < min) {
    return min;
  }
  if (floored > max) {
    return max;
  }
  return floored;
}
