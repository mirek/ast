---
title: Implement the Markdown adapter
summary: Pressure-test semantic tree views, loss-aware editing, frontmatter, and nested language mounts.
depends_on: []
spec_sections: [7.2, 17.1, 18.3]
---

# Outcome

Markdown documents expose both source structure and heading-derived sections
without losing provenance or treating derived hierarchy as permission to
normalize unrelated text.

# Scope

- Model documents, headings, sections, paragraphs, lists, links, code blocks,
  and frontmatter.
- Define the heading-based section hierarchy as a named semantic tree view.
- Mount fenced code blocks and frontmatter through suitable adapters.
- Add semantic heading/section operations and loss-aware source edits.
- Specify behavior for malformed markup, duplicate headings, skipped heading
  levels, reference links, and embedded HTML.

# Acceptance criteria

- Selector tests cover syntax containment and semantic section containment.
- Fenced mounts preserve a path to both the block and original file.
- Unchanged Markdown round-trips exactly.
- Edits preserve unrelated whitespace and formatting wherever the parser permits.
- The adapter documents node identity guarantees across reparses.
