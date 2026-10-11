# A8 evidence: demo fixes (dead link, findings header, /demo prompts)

RED (commit 1): `npx vitest run src/simulation/SimulationBar.test.tsx src/costsource/findingsHeader.test.tsx src/ai/demoPrompts.test.ts`
gives 5 failed, 2 passed (7 tests); full output in `red.txt`.

Two tests pass at RED by design and are regression pins:
`shows_sign_in_link_when_enabled_and_signed_out` (the link must stay for an
enabled deployment) and `help_reply_prompts_each_classify_to_a_distinct_intent`
(since PR #99 the help bullets already reach four distinct answer paths; the
original F19e premise that two of three /demo prompts return help text is stale:
only the third prompt failed, and it returned the "cannot answer" reply, not help).
