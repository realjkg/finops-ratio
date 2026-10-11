# A8 evidence: demo fixes (dead link, findings header, /demo prompts)

RED (`red.txt`): the current A8 tests run against `origin/main` `145565f` code
give 3 failed, 1 passed (4 tests). The passing one is the pre-existing anomaly
delta test in `findingsCard.test.tsx`. The demo-prompt test fails on main
because `DEMO_PROMPTS` is not exported there; with main's prompt list the
third prompt ("Which model should I switch to?") gets the "cannot answer"
reply, which the same test catches (mutation check below).

On the A8 branch, the RED commit `dde0921` fails only the new findings-title
race test (the title followed the picker, not the source that ran the ingest).

Mutation checks on the GREEN head, each killed by one test: title from the
picker instead of the captured source; source name without the parenthesis
rewrite; sign-in link without the `enabled` check; main's third prompt
restored. The second prompt is main's original ("Which workload has the worst
value ratio?"): it already gets a real answer, so A8 no longer changes it.
