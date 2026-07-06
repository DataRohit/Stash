export function mapDocError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("project-full")) {
    return "This project has reached its size limit. Upgrade or remove files.";
  }
  if (message.includes("file-too-large")) {
    return "This file is too large (max 512 KB per file).";
  }
  if (message.includes("invalid-asset")) {
    return "Only image and SVG files can be uploaded.";
  }
  if (message.includes("invalid-type")) {
    return "Files must end in .md or .html.";
  }
  if (message.includes("invalid-parent")) {
    return "That folder no longer exists. Refresh and try again.";
  }
  if (message.includes("invalid-name")) {
    return "That name isn’t allowed.";
  }
  if (message.includes("too-many-nodes")) {
    return "This project has too many files and folders.";
  }
  if (message.includes("too-deep")) {
    return "Folders can’t be nested that deeply.";
  }
  if (message.includes("name-taken")) {
    return "A file or folder with that name already exists here.";
  }
  return "Something went wrong. Please try again.";
}

export function formatHistoryTime(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function historyEmail(email?: string): string {
  return email ?? "Email unavailable";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
