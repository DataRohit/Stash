export const BUILTIN_TEMPLATES = [
  {
    id: "builtin:meeting-notes",
    name: "Meeting Notes",
    description: "Agenda, attendees, decisions, and action items.",
    fileType: "md" as const,
    content:
      "# Meeting Notes\n\n**Date:** \n**Attendees:** \n\n## Agenda\n\n- \n\n## Discussion\n\n## Decisions\n\n- \n\n## Action Items\n\n- [ ] Owner — task\n",
  },
  {
    id: "builtin:technical-spec",
    name: "Technical Specification",
    description: "A structured engineering proposal and rollout plan.",
    fileType: "md" as const,
    content:
      "# Technical Specification\n\n## Summary\n\n## Goals\n\n## Non-goals\n\n## Design\n\n## Data Flow\n\n## Edge Cases\n\n## Rollout\n\n## Verification\n",
  },
  {
    id: "builtin:readme",
    name: "README Starter",
    description: "A practical project README skeleton.",
    fileType: "md" as const,
    content:
      "# Project Name\n\nA short description of the project.\n\n## Getting Started\n\n## Usage\n\n## Configuration\n\n## Contributing\n\n## License\n",
  },
];
