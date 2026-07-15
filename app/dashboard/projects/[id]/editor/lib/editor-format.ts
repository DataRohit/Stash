const DOC_ERROR_MESSAGES: ReadonlyArray<readonly [string, string]> = [
  ["template-name-taken", "An organization template with that name already exists."],
  ["invalid-template-name", "Template names must contain at least 2 characters."],
  ["invalid-template", "That template is unavailable or does not match this file type."],
  ["template-too-large", "That document is too large to save as a template."],
  ["template-limit", "This organization has reached its template limit."],
  ["already-privileged", "That member already has equal or greater project access."],
  ["too-many-collaborators", "This project has reached its collaborator limit."],
  ["not-a-member", "Project access can only be granted to organization members."],
  ["public-sharing-disabled", "Public sharing is not enabled for this plan."],
  ["invalid-expiry", "Choose a share expiry time in the future."],
  ["no-active-share", "There is no active share link to rotate."],
  ["token-collision", "A secure share link could not be created. Please try again."],
  ["session-owned-by-another-user", "This collaboration session belongs to another user."],
  ["update-too-large", "That edit is too large to sync at once. Split it into smaller changes."],
  ["invalid-update", "That edit could not be validated. The last synced version was restored."],
  ["too-many-cells", "That spreadsheet would exceed its row, column, or 100,000-cell limit."],
  ["too-many-cards", "That board would exceed its 100-column or 2,000-card limit."],
  [
    "import-conflict",
    "The spreadsheet changed during import. Review the latest edits and try again.",
  ],
  ["seq-conflict", "Syncing your latest edit. This will retry automatically."],
  ["rate-limited", "Sync is temporarily rate-limited. Your edit will retry automatically."],
  ["history-too-large", "This document is too large to add to version history."],
  ["invalid-confirmation", "Enter the requested confirmation before continuing."],
  ["invalid-anchor", "That comment selection is no longer available."],
  ["invalid-mention", "Mentions must be project members with access."],
  ["comment-too-long", "Comments can be up to 2,000 characters."],
  ["empty-comment", "Write a comment before posting."],
  ["empty-selection", "Select text before starting a thread."],
  ["invalid-import", "The selected files could not be imported."],
  ["invalid-asset", "Assets must be PNG, JPEG, GIF, WebP, or AVIF images."],
  ["missing-asset", "A referenced asset is unavailable. Refresh and try again."],
  ["file-too-large", "This file is too large for the document storage limit."],
  ["project-full", "This project has reached its size limit. Upgrade or remove files."],
  ["too-many-projects", "This organization has reached its project limit."],
  ["too-many-nodes", "This project has too many files and folders."],
  ["invalid-parent", "That folder no longer exists. Refresh and try again."],
  ["invalid-target", "You can’t move a folder into itself."],
  ["invalid-tree", "The project tree could not be processed safely."],
  ["invalid-title", "Enter a project title with at least 2 characters."],
  ["invalid-type", "Document names must end in .md, .html, .sheet, .board, or .view."],
  ["file-type-change-unsupported", "Renaming cannot change a document's file type."],
  ["invalid-name", "That name isn’t allowed."],
  ["name-taken", "A file or folder with that name already exists here."],
  ["too-deep", "Folders can’t be nested that deeply."],
  ["clone-incomplete", "The project copy did not finish. Try copying it again."],
  ["clone-stopped", "That project copy is no longer running."],
  ["reconciliation-missing", "Storage verification could not find that project."],
  ["unsupported-filetype", "That action isn’t available for this document type."],
  ["not-found", "That item no longer exists. Refresh and try again."],
  ["not found", "That item no longer exists. Refresh and try again."],
  ["unauthenticated", "Your session expired. Sign in again."],
  ["forbidden", "You don’t have permission to perform that action."],
];

export function mapDocError(
  error: unknown,
  fallback = "Something went wrong. Please try again.",
): string {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  for (const [code, userMessage] of DOC_ERROR_MESSAGES) {
    if (message.includes(code)) {
      return userMessage;
    }
  }
  return fallback;
}

export function historyEmail(email?: string): string {
  return email ?? "Email unavailable";
}
