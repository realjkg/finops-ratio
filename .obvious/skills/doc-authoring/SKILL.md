---
name: doc-authoring
description: Standing documentation workflow for this repo — design specs are ephemeral, point-in-time Obvious artifacts (never checked in); durable rules live in .obvious/obvious.md and durable procedures live as .obvious/skills/<name>/SKILL.md. Defines the promotion routine.
version: 1.0.0
triggers:
  - doc authoring
  - design spec
  - ephemeral artifact
  - promote spec
  - obvious contract
  - where do docs go
author: autobuild
created: 2026-06-26
---

# Doc Authoring — Ratio (`realjkg/finops-ratio`)

The standing workflow for where documentation lives in this repo. It supersedes
and embodies the obvious.md line "design specs are point-in-time, session-based
documents and should be kept as ephemeral artifacts."

## The rule

- **Design specs are ephemeral.** They are point-in-time, session-based Obvious
  artifacts — NOT checked into the repo. A spec captures a moment's full narrative
  (screen layouts, sprint plans, recommended stacks, acceptance snapshots); that
  narrative is allowed to age and is not load-bearing.
- **Durable RULES live in `.obvious/obvious.md`** — enforceable product
  invariants, thresholds, design tokens, positioning tenets.
- **Durable PROCEDURES live as `.obvious/skills/<name>/SKILL.md`** — standing
  operating routines (e.g. `forecast-engine`, `agent-prompt`, `cost-reporting`,
  `observability-deploy`). obvious.md indexes them under `## Routine Skills`.

## The promotion routine

When a session spec contains a rule or procedure meant to persist:

1. **Extract the durable part.** A rule/invariant → add it to obvious.md as an
   enforceable rule (condensed, not narrative). A procedure → add or update a
   `.obvious/skills/<name>/SKILL.md` entry (frontmatter: `name`, `description`,
   `version`, `triggers`, `author`, `created`; then a self-contained body).
2. **Leave the narrative behind.** Point-in-time content (superseded UI layouts,
   sprint plans, stack recommendations, acceptance-criteria snapshots) stays ONLY
   in the ephemeral artifact — do not migrate it into the repo.
3. **Reference, don't duplicate.** Skills cite obvious.md rules rather than
   restating them; obvious.md links the skills.
4. **Link the artifact.** Record the ephemeral artifact ID in obvious.md so the
   full historical context is one click away.
5. **Remove the checked-in spec** once its durable content is promoted, and fix
   any dangling references (README, codebase map, code comments).

## Canonical example

The v1 Ratio design spec was promoted this way: its durable rules moved into
obvious.md (Design Guidance) and five routine skills; the checked-in
`docs/ratio-design-spec.md` was deleted; and the full point-in-time spec is
preserved as the ephemeral Obvious artifact **`art_nWIhJYfZ`** ("Ratio — Design
Specification v1, Ephemeral Snapshot, 2026-06-26"). Use that migration as the
template for future specs.

