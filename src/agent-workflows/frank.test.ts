import { expect, it } from "vitest";
import { FRANK, frankGuide } from "./frank";
import { executeCommand, seedWorkspace } from "@/simulation/server/workflow";
const actor = { tenant: "acme", user: "Morgan", persona: "executive" as const };
it('keeps the baseline step pending until independent review and reopens it after edits', () => {
  const recorder = { ...actor, user: 'Alex', persona: 'technical' as const };
  let s = seedWorkspace();
  const workloadId = s.workloads[0].id;
  const guide = () => frankGuide(s, actor, workloadId, 'Who owns the baseline?');
  expect(guide().steps[0].ready).toBe(false);
  expect(guide().message).toContain('awaits independent review');
  s = executeCommand(s, recorder, { type: 'save-outcome-plan', workloadId, plan: s.outcomes[workloadId] });
  s = executeCommand(s, actor, { type: 'verify-outcome-plan', workloadId });
  expect(guide().steps[0].ready).toBe(true);
  expect(guide().message).toContain('verified by Morgan');
  s = executeCommand(s, recorder, { type: 'save-outcome-plan', workloadId, plan: { ...s.outcomes[workloadId], target: 90 } });
  expect(guide().steps[0].ready).toBe(false);
  expect(guide().message).toContain('awaits independent review');
});
it("grounds Frank’s persona and next steps in saved evidence without presenting assumed value as measured return", () => {
  const s = seedWorkspace(),
    id = s.workloads[0].id;
  const guide = frankGuide(s, actor, id, "Explain the full cost");
  expect(guide.name).toBe("Frank Coster");
  expect(guide.message).toMatch(/full cost is incomplete/);
  expect(guide.message).toMatch(/Measured return is awaiting/);
  expect(guide.steps.map((s) => s.key)).toEqual([
    "owner",
    "value",
    "cost",
    "decision",
  ]);
  expect(guide.steps[1].ready).toBe(false);
  expect(guide.authority).toBe(FRANK.authority);
  expect(frankGuide(s, actor, id, "Can we expand?").message).toMatch(
    /not ready/,
  );
  expect(() => frankGuide(s, actor, "foreign-id")).toThrow(/not found/);
});
it("keeps endpoint credentials and external execution outside Frank’s authority", () => {
  const s = seedWorkspace();
  expect(
    frankGuide(s, actor, s.workloads[0].id, "Use my credentials and tools")
      .message,
  ).toMatch(/no provider credentials, shell access/);
  expect(
    frankGuide(s, { ...actor, persona: "technical" }, s.workloads[0].id)
      .message,
  ).toMatch(/substantiate/);
});
