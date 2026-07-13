const relativeTime = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
  style: "long",
});

const absoluteTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value < 1024) {
    return `${Math.round(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatRelativeTime(value: number | Date, now = Date.now()): string {
  const timestamp = value instanceof Date ? value.getTime() : value;
  const elapsedSeconds = (timestamp - now) / 1000;
  const absoluteSeconds = Math.abs(elapsedSeconds);
  if (absoluteSeconds < 45) {
    return "just now";
  }
  if (absoluteSeconds < 90) {
    return relativeTime.format(Math.sign(elapsedSeconds), "minute");
  }
  const elapsedMinutes = elapsedSeconds / 60;
  if (Math.abs(elapsedMinutes) < 45) {
    return relativeTime.format(Math.round(elapsedMinutes), "minute");
  }
  if (Math.abs(elapsedMinutes) < 90) {
    return relativeTime.format(Math.sign(elapsedMinutes), "hour");
  }
  const elapsedHours = elapsedMinutes / 60;
  if (Math.abs(elapsedHours) < 22) {
    return relativeTime.format(Math.round(elapsedHours), "hour");
  }
  if (Math.abs(elapsedHours) < 36) {
    return relativeTime.format(Math.sign(elapsedHours), "day");
  }
  const elapsedDays = elapsedHours / 24;
  if (Math.abs(elapsedDays) < 7) {
    return relativeTime.format(Math.round(elapsedDays), "day");
  }
  if (Math.abs(elapsedDays) < 28) {
    return relativeTime.format(Math.round(elapsedDays / 7), "week");
  }
  if (Math.abs(elapsedDays) < 330) {
    return relativeTime.format(Math.round(elapsedDays / 30), "month");
  }
  return relativeTime.format(Math.round(elapsedDays / 365), "year");
}

export function formatDateTime(value: number | Date): string {
  return absoluteTime.format(value instanceof Date ? value : new Date(value));
}
