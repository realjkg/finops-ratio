# WCAG 2.1 Level AA audit worklist (static, code-grounded)

Checklist item: RFQ readiness 6.2 (`docs/build/RFQ-READINESS-CHECKLIST.md`).
Branch: `feat/rfq-readiness-build`. Review type: static source review plus computed color contrast.

**This document is not a conformance claim and is not a VPAT or Accessibility Conformance Report.** Ratio has not been tested with NVDA, VoiceOver, JAWS, TalkBack, or in a keyboard-only and zoom session by a person. Until that testing is done and recorded, the only accurate statement about Ratio is: "a static review found the issues below; manual testing has not been performed." Do not describe the product as "WCAG 2.1 AA conformant", "compliant", or "Section 508 conformant" in an RFQ response on the strength of this file.

---

## 1. Scope and honest limits of a static review

### What was read

Every `.tsx` file under `pages/`, `src/components/`, `src/mission/`, `src/findings/`, `src/connectors/`, `src/attribution/`, plus `src/costsource/CostSourcePage.tsx`, `src/prediction/PredictionPage.tsx`, `tailwind.config.js`, `src/index.css` (70 lines, the only global stylesheet), `pages/_document.tsx`, `pages/_app.tsx`, `eslint.config.mjs`, `.eslintrc.cjs`, `package.json`, and the design tokens in `.obvious/obvious.md`.

Five files outside that list were opened because the in-scope pages render them and they affect findings: `src/executive/InitiativeCard.tsx`, `src/executive/InitiativeDashboard.tsx`, `src/executive/SpendSummaryBar.tsx`, `src/frameworks/WorkloadGateRow.tsx`, and `src/agent-workflows/FrankWorkspace.tsx` (heading lines only). Everything else that is rendered but not read is listed under "Not reviewed" below.

### What a static review can establish

Missing semantics (roles, names, states, landmarks, headings, labels), missing keyboard handlers, `outline-none` without a replacement, absent live regions, absent reduced-motion guards, and arithmetic color contrast between documented token pairs.

### What a static review cannot establish

1. How NVDA, VoiceOver, JAWS, or TalkBack actually announce anything. Several findings below say "may" because browser and screen reader pairs differ (for example, announcements from live regions inserted with their content, or `aria-label` on elements with no role).
2. Whether the rendered focus ring is visible against its real background, or whether Tailwind and framer-motion produce the layout the class names suggest.
3. Reflow at 320 CSS pixels and 200 or 400 percent zoom. Findings in that area are risks to confirm, not confirmed failures.
4. Contrast of anything not expressed as a token: gradients, `backdrop-blur` overlays, alpha stacks beyond the single blends computed in section 4, and user-agent form control rendering.
5. Content-dependent criteria: whether link text, error messages, and instructions are understandable (3.3.x), reading level, and whether chart takeaways are conveyed in meaningful text. The agent (Frank) output is model-generated and varies per turn.
6. Criteria that only apply to time-based media, documents (the PDF and XLSX exports in `src/executive/reportPdf.tsx` and `reportXlsx.ts`), or authentication. The exports were not reviewed at all and need their own check (tagged PDF, header rows in XLSX).

### Not reviewed

`src/simulation/`, `src/outcomes/` (OutcomesPanel, TcaBreakdown), `src/agent-workflows/` (apart from heading lines), `src/finio/`, `src/tokenomics/`, `src/hello/`, `src/executive/MissionSurface.tsx` internals, `pages/tokenomics.tsx`, `pages/simulation.tsx` interior components, `pages/workspace.tsx` (re-exports `WorkspacePage`), the PDF and XLSX exports, and everything under `pages/api/`. The sign-in or identity picker in the simulation flow is the entry point for several workflows and should be among the first additions to the audit.

### Severity scale used (triage judgment, not a WCAG term)

Blocker: an A or AA failure on a primary path that leaves key information unreadable or an essential action unperceivable for a defined user group, with no in-product alternative. Major: an A or AA failure with real impact where a workaround exists, or a pattern repeated across many screens. Minor: lower-impact, partial, or risk-to-confirm items.

### Controls already present in the code (unverified by assistive technology)

These show real intent and should be preserved, but each still needs the manual tests in section 5.

1. `lang="en"` on `<html>` (`pages/_document.tsx:8`).
2. `aria-pressed` on finding rows (`src/findings/FindingsPage.tsx:319`) and on detail tab buttons (`src/components/detail/DetailPanel.tsx:77`).
3. A complete roving-tabindex tablist with Arrow, Home, and End keys, plus focus moved into the new view and restored on return (`src/mission/MissionDetail.tsx:71-105,178-216`; `src/mission/MissionBoard.tsx:40-51`).
4. `role="progressbar"` or `role="meter"` with values on `BudgetBar.tsx:34-39`, `FuelAndValue.tsx:52-58`, `FleetHeader.tsx:57-62`, and `ValueRatioMeter.tsx:60-66`.
5. Reduced-motion handling via `useReducedMotion` in `BudgetBar.tsx:25`, `FuelAndValue.tsx:30`, `ChatPanel.tsx:59`, `MissionBoard.tsx`, `AdjustmentCards.tsx`, and `motion-safe:` classes in `ValueRatioMeter.tsx:70`, `SpendToValueGraph.tsx:274,287,296`, `ConnectorCard.tsx:141`.
6. Named icon-only buttons: close (`ChatPanel.tsx:154`), spoken replies (`ChatPanel.tsx:134`), dictation (`ChatInput.tsx:86`), agent launcher (`NavBar.tsx:75`). Icons are `aria-hidden`.
7. Form controls have names: wrapping `<label>` (`Filters.tsx:98`, `PredictionPage.tsx:134-172`, `outcomes.tsx:16`, `agent-workflows.tsx:47,97`, `MultiModelTab.tsx:108`) or `aria-label` (`ChatInput.tsx:111`, `FindingsPage.tsx:606,623`, `DemandShapingTab.tsx:149`).
8. Error text with `role="alert"` in several places (`FindingsPage.tsx:639-647`, `ChatInput.tsx:74`, `ChatMessage.tsx:24`, `MultiModelTab.tsx:86,111`).
9. `SpendToValueGraph` data points are focusable, keyboard-activatable, and carry a full `aria-label` (`SpendToValueGraph.tsx:238-252`).
10. Budget and ratio colors are paired with text (percentages, status words, `STATE_LABEL`, numeric ratios), so 1.4.1 appears to be met for those components (see section 3, "Checked, no static finding").

---

## 2. What lint enforces today

Command: `npm run lint` runs `eslint .` (`package.json:10`). ESLint is `^10.6.0`, which reads only the flat config.

Active config: `eslint.config.mjs`.

1. `js.configs.recommended` (`eslint.config.mjs:27`).
2. `typescript-eslint` recommended (`eslint.config.mjs:29`).
3. `react-hooks/rules-of-hooks` as error and `react-hooks/exhaustive-deps` as warning (`eslint.config.mjs:36-37`).
4. `@typescript-eslint/no-unused-vars` with an underscore ignore pattern; `preserve-caught-error` off.

Not enforced:

1. **There is no accessibility lint at all.** `eslint-plugin-jsx-a11y` is not in `package.json` and is not installed in `node_modules`. No `jsx-a11y/*` rule is configured. `eslint-config-next` is also absent, so the Next.js bundled a11y rules do not run either. No `eslint-plugin-react` is configured.
2. `.eslintrc.cjs` is a legacy file that ESLint 10 does not read, and the flat config explicitly ignores it (`eslint.config.mjs:18`). It contains no a11y rules in any case (it extends `eslint:recommended`, `plugin:@typescript-eslint/recommended`, `plugin:react-hooks/recommended`).
3. No automated accessibility test exists. `grep` for `axe`, `jest-axe`, `vitest-axe`, `pa11y`, `lighthouse`, and `jsx-a11y` across `package.json`, `src`, and `tests` returns nothing. Installed test tooling that could host such checks later: `@playwright/test` (`package.json:57`), `@testing-library/react` and `@testing-library/dom` (`package.json:58-59`), `jsdom` and `happy-dom` (`package.json:70-71`).
4. Incidental coverage only: `src/components/ai/ChatPanel.voice.test.tsx`, `ChatInput.voice.test.tsx`, and `src/findings/SpendToValueGraph.test.tsx` query by ARIA role or attribute, and `tests/simulation/*.spec.ts` use `getByRole`. Those prove some names and roles exist; they do not check contrast, focus visibility, focus order, or announcements.

Practical consequence: nothing in CI today would catch a new `<div onClick>`, an `<img>` without `alt`, a missing label, or a removed `aria-label`. Every finding below got in without a failing check.

---

## 3. Findings

IDs are stable for tracking. SC means WCAG 2.1 success criterion. "Evidence" lists the file and line numbers that were inspected. Items marked "confirm" need a manual or browser check before being treated as confirmed.

### 3.1 Findings table

| ID | SC | Severity | Evidence | Concrete fix |
|---|---|---|---|---|
| A11Y-01 | 1.4.3 Contrast (Minimum) | blocker | The executive (light) surface uses semantic accent colors as text on white and near-white. Computed ratios on `exec-surface` `#ffffff`: value 1.73, shape 1.58, unit 1.93, purple 2.51, gate 2.95, cost 2.99. Usages: status chip text on a 10 percent tint of its own color (`src/executive/InitiativeCard.tsx:37`: value chip 1.61, shape 1.51, cost 2.69), cost headline at `text-3xl` (`InitiativeCard.tsx:45`, 2.99, under even the 3:1 large-text bar), ratio text (`InitiativeCard.tsx:80`), summary metrics (`src/executive/SpendSummaryBar.tsx:21,27,43`), Technical view toggle `text-gate` on white at 12px (`src/executive/InitiativeDashboard.tsx:53`, 2.95). `tailwind.config.js:30` states the accents "read on both backgrounds"; for text that is false. Also `exec-muted` `#64748b` is 4.46 on `exec-bg` and 4.23 on `exec-hover` (just under 4.5) though 4.76 on white (`tailwind.config.js:36`). | Add a second, darker accent set for light surfaces and use it for all text there. Candidates computed to pass 4.5:1 on `#ffffff`, `#f5f8fb`, and `#edf2f7`: value `#007d58`, cost `#bd4454`, shape `#876829`, gate `#5b67ba`, unit `#00788c`, purple `#7960ab`, exec-muted `#606f85`. Keep the bright tokens for fills, borders, and dark surfaces. Design must approve the hues. |
| A11Y-02 | 2.4.7 Focus Visible; 1.4.11 Non-text Contrast | blocker | The primary home-screen verbs and the pre-approved reference form remove the browser outline and replace it with a ring colored `edge` `#1a2235`, which is 1.19 to 1.23:1 against `slab` and `deep`: Dismiss (`src/findings/FindingsPage.tsx:550,576`), reference provider select and text input (`:605,622`), Attach (`:629`). The toggle "Have a pre-approved reference?" has `focus:outline-none` and no replacement at all (`:587`). A sighted keyboard user cannot see where focus is on these controls. There is no global `:focus-visible` rule (`src/index.css`, 70 lines). `Apply` (`:564`) uses `ring-shape/60`, about 4.9:1 on void, which is fine. Select and text inputs elsewhere swap the border color only (`src/components/workload/Filters.tsx:103`, `src/components/ai/ChatInput.tsx:113`), which is likely acceptable but is a 1px change to verify. | Add one global rule in `src/index.css`, for example `:focus-visible { outline: 2px solid var(--gate); outline-offset: 2px; }`, then delete the per-component `focus:outline-none` overrides that use `ring-edge` or no ring. `gate` is 5.4 to 6.8:1 on every dark surface. Confirm in a browser that nothing else suppresses the ring (components using `focus:outline-none focus-visible:ring-gate` such as `MissionCard.tsx:31` and `MissionDetail.tsx:195` already look correct). |
| A11Y-03 | 1.3.1 Info and Relationships; 4.1.2 Name, Role, Value (landmarks) | major | Nested `<main>` landmarks. `AppShell` renders one `<main>` (`src/components/layout/AppShell.tsx:29`) and these routes render inside it and add another: `pages/frameworks.tsx:19`, `pages/connectors.tsx:77`, `src/findings/FindingsPage.tsx:259` (the home page), `src/components/detail/DetailPanel.tsx:41,48` (`/workloads`), `src/prediction/PredictionPage.tsx:121`, and `src/executive/InitiativeDashboard.tsx:76` (`/overview`). Screen reader "go to main" is ambiguous and landmark lists are wrong. | Keep the single `<main>` in `AppShell`. Change the inner elements to `<div>` or `<section aria-label>`. Standalone routes outside the shell (`/mission`, `/hello`, `/simulation`) keep their own `<main>`. |
| A11Y-04 | 2.4.2 Page Titled | major | `pages/_document.tsx:9-16` sets only description and icon. `next/head` `<title>` exists only in `pages/finio.tsx:10` and `pages/finio/demo.tsx:10`. Every other route has no title, so tabs, history, and screen reader page announcements fall back to the URL. | Add `<Head><title>Findings | Ratio</title></Head>` (and equivalents) per page, or a small `PageTitle` helper called from each page and from `AppShell` using `NAV_ITEMS` labels. |
| A11Y-05 | 2.4.3 Focus Order | major | The agent panel is rendered last in `AppShell` (`AppShell.tsx:31`). Opening it from the nav button (`src/components/layout/NavBar.tsx:70-87`) does not move focus (no `.focus()` call exists in `src/components/ai` or `src/components/layout`, confirmed by search). A keyboard user must tab through the whole page to reach the panel. Closing (`ChatPanel.tsx:149-158`, or Escape at `:75-80`) unmounts the panel and does not return focus to the launcher, so focus drops to the document. The other launcher on `/demo` has no `aria-expanded` or `aria-controls` (`pages/demo.tsx:113-119`). | On open, move focus to the panel's heading or the textarea; on close, restore focus to the element that opened it. Add `aria-expanded` and `aria-controls` to the `/demo` button. Consider `role="dialog"` semantics only if the panel is made modal; as a non-modal complementary region the current `<aside aria-label>` is reasonable. |
| A11Y-06 | 2.4.3 Focus Order | major | Focus is lost when the focused control unmounts. Dismiss changes selection and the pane remounts through `key` (`FindingsPage.tsx:175-182,262-263`). Apply replaces the verb buttons with the audit chip (`:542-554`). Acknowledge is replaced by a text span (`src/components/detail/AlertHistoryTab.tsx:79-91`). After each, focus goes to the document body and a keyboard or screen reader user restarts from the top of the page. | After Dismiss, focus the next finding row or the pane heading. After Apply, focus the audit chip (give it `tabIndex={-1}` and a status role). After Acknowledge, focus the next alert's button or the list heading. |
| A11Y-07 | 4.1.2 Name, Role, Value | major | Segmented and toggle buttons show the selected state only by color and border, with no `aria-pressed`: VALUE, COST, UNIT (`src/components/workload/Filters.tsx:39-50`), attribution dimension and client mode (`src/attribution/AttributionPage.tsx:106-122,127-145`), cost source client mode, source picker, and FOCUS version (`src/costsource/CostSourcePage.tsx:152-168,184-211,340-355`), FOCUS export version (`src/connectors/FocusDoorWalk.tsx:92-106`). Screen reader users cannot tell which option is active. | Add `aria-pressed={selected}` (toggle buttons) or wrap in `role="radiogroup"` with `role="radio"` and `aria-checked` and arrow-key handling (single-select groups). Reuse one small `SegmentedControl` component for all of these. |
| A11Y-08 | 4.1.2; 1.3.1 | major | `DemandShapingTab` is documented as a "six-option radio" but is built from buttons with a drawn radio glyph and no radio semantics or state (`src/components/detail/DemandShapingTab.tsx:1-3,47-84`). The active shape and the blocked reason are not exposed as state. Disabled options are removed from the tab order, so the reason text is reachable only in browse mode. | Use `role="radiogroup"` with a name, `role="radio"` and `aria-checked` on each option, `aria-describedby` pointing at the description or blocked reason, and `aria-disabled` (not `disabled`) for blocked options so they stay focusable and readable. |
| A11Y-09 | 1.1.1 Non-text Content; 1.3.1 | major | Meaning carried only by `title` or by a glyph. Gate status in the Frameworks table is a glyph (`✓`, `–`, `·`) whose explanation, including the locked versus not-reviewed distinction, is only in `title` (`src/frameworks/WorkloadGateRow.tsx:64-82`), and the column header gate names are `title` only (`pages/frameworks.tsx:122-129`). Other `title`-only meaning: `BudgetBar.tsx:73` (threshold markers), `GateDots.tsx:14`, `WorkloadCard.tsx:70`, `EvidenceMark.tsx:23-26` (evidence status meaning), `ConnectorCard.tsx:152-155`. `ConnectorCard.tsx:304-312` puts the reason a Test button is disabled in `title`, which a disabled button never exposes to keyboard users. `title` is not reliably available to keyboard, touch, or screen reader users. | Provide the meaning as visible text or visually hidden text inside the element (`<span class="sr-only">Gate 2 Ethics passed</span>`), or `aria-label` on a role-bearing element. Add a Tailwind `sr-only` usage (already used once at `src/mission/MissionBoard.tsx:88`). Keep `title` only as an extra. |
| A11Y-10 | 4.1.3 Status Messages | major | Results and failures appear without being announced. `AttributionPage.tsx:164-175` (loading and "Report failed"), `CostSourcePage.tsx:237-247` (loading and error), `PredictionPage.tsx:184-191` (error as plain `<p>`). Apply success is only an audit chip with no status role (`FindingsPage.tsx:542-545`) even though Apply failure uses `role="alert"` (`:639-647`). Some status regions are inserted already containing text, which several screen readers do not announce: `ConnectorCard.tsx:228-237,248-255`, `IngestVerification.tsx:88-91`, and the dictation preview (`ChatInput.tsx:66-72`, `aria-live` inside a conditional block). | Render persistent, empty `role="status"` (polite) and `role="alert"` containers and fill them, rather than inserting a new live region with content. Add status text for report loaded, ingest landed, finding applied, and acknowledged. |
| A11Y-11 | 2.2.2 Pause, Stop, Hide | major | The attribution board updates every second: `setInterval` in `src/attribution/useLiveSpend.ts:36` drives the totals, 1-second linear bar transitions (`LiveAccrualBoard.tsx:128-137,172-176`), and a re-ordering layout animation (`:278-281`). There is no pause control, so moving, auto-updating information lasts longer than 5 seconds with no way to stop it. The clock only holds when the tab is hidden (`useLiveSpend.ts:45`). `src/attribution` has no `useReducedMotion` or `motion-safe` handling. | Add a visible Pause/Resume button that stops the interval, and start paused when `prefers-reduced-motion: reduce` matches. Use `useReducedMotion` for the `motion.rect` and layout transitions, and add `motion-safe:` to `transition-[width]`. |
| A11Y-12 | 1.4.3 Contrast (Minimum) | major | The `dim` token `#4d5a72` is used as text across the dark UI at 2.28 to 2.90:1 (slab 2.72, raised 2.51, edge 2.28); it fails the 4.5:1 normal-text bar and even the 3:1 large-text bar. 150 `text-dim` lines exist in the reviewed files, including interactive and informational text: inactive tab labels (`DetailPanel.tsx:82`, `MissionDetail.tsx:198`), inactive VALUE/COST/UNIT (`Filters.tsx:46`), KPI labels (`KpiCards.tsx:58,92`), model table header (`MultiModelTab.tsx:72`), alert metadata (`AlertHistoryTab.tsx:67-70,80`), the Footer label and age (`Footer.tsx:50,66`), connector notes (`ConnectorCard.tsx:192,203,219`), Findings labels and spend (`FindingsPage.tsx:196,214,222,342,425,441`), and placeholders (`ChatInput.tsx:113`, `FindingsPage.tsx:622`). Many are 9 to 11px. | Change the design token used for text to a lighter value. `#818a9b` passes 4.5:1 on slab, raised, and edge (5.44, 5.01, 4.56); `#7a8395` passes on void, deep, slab, and raised (5.29, 5.13, 4.96, 4.57). Keep `#4d5a72` only for decorative lines and disabled glyphs. Apply by changing `dim` in `tailwind.config.js:17` and `--dim` in `src/index.css`, then re-run the section 4 script. Brand review needed. |
| A11Y-13 | 1.4.11 Non-text Contrast | major | UI component boundaries and graphical state indicators below 3:1. Input and select borders use `edge` (1.19 to 1.27:1 against slab and void): `Filters.tsx:103`, `ChatInput.tsx:113`, `FindingsPage.tsx:605,622`, `PredictionPage.tsx:137-162`, `.sim-input` in `src/index.css:65`. Pending gate dots use a `dim` ring (2.72:1 on slab, `GateDots.tsx:24`) to distinguish passed from pending. Budget threshold ticks `bg-txt/40` on void (2.95, `BudgetBar.tsx:71`) and the overshoot fill at 40 percent opacity (1.89, `BudgetBar.tsx:49-60`). Ratio meter reference lines: `bg-sub/50` on raised (2.43) and `bg-dim/70` (1.86) (`ValueRatioMeter.tsx:76-91`). Scatter points at 0.6 opacity: poor-ratio (cost) dots 2.93:1 on slab (`SpendToValueGraph.tsx:295`). | Raise control borders to at least 3:1 against the surface (for example a lighter border token for inputs only). Give pending dots a stronger ring or a different shape. Make threshold and reference ticks full-opacity `sub` or `txt`. Raise the point opacity floor so the lowest-ratio points remain 3:1. |
| A11Y-14 | 1.3.1 Info and Relationships | major | The model comparison "table" is a CSS grid of `<div>` and `<span>` elements with no table, row, or column header semantics (`src/components/detail/MultiModelTab.tsx:71-82,148-175`). Screen reader users cannot navigate it as data or hear column names per cell. The token breakdown `TokenRow` is a similar flex-row pseudo-table (`BudgetProfileTab.tsx:226-245`, minor). | Use `<table>` with `<th scope="col">` and `<th scope="row">`, styled with the existing classes, or add `role="table"`, `row`, `columnheader`, and `cell`. |
| A11Y-15 | 4.1.2; 1.3.1; 2.5.3 Label in Name | major | Accessible names replace informative content. Each Findings row has `aria-label="Finding {rank}: {name}"` (`FindingsPage.tsx:320`), so the ratio, monthly spend, evidence mark, and governed or applied status (`:334-364`) are not announced in the ranked list, which is the product's main object. `MissionCard` puts `<header>` and `<h3>` inside a `<button>` (`src/mission/MissionCard.tsx:26-43`; interactive content may contain only phrasing content, and the heading role is dropped), though its `aria-label` at `:29` does include status and ratio. | For Findings rows, include ratio, spend, and status in the label or add an `aria-describedby` to hidden text. Remove headings from inside buttons (make the card a `div` with a heading plus a full-card link or button overlay). |
| A11Y-16 | 1.4.4 Resize Text; 1.4.3; 1.4.10 | major (confirm) | SVG chart text is sized in viewBox units and scales down with the container. `SpendToValueGraph` uses a 480-wide viewBox with `width="100%"` and `fontSize` 9 and 10 (`SpendToValueGraph.tsx:61,98-103,115,131,164,182,194,205,305`), so axis and threshold labels render around 6 to 7 CSS pixels in the 320px to 340px panes used on mobile. Axis tick labels use `C_DIM` (2.7:1). `LiveAccrualBoard.tsx:80-90,124,138` has the same 9-unit text. | Render labels as HTML overlaid on the chart or increase viewBox font sizes so the rendered size is at least 12px at the smallest supported width; use a lighter label color; offer a "view as table" for the same data. |
| A11Y-17 | 2.4.1 Bypass Blocks | minor | A `<main>` landmark exists in `AppShell.tsx:29`, which is an accepted bypass technique, but there is no skip link (`grep` for "skip to" and "skip-link" finds none), and the nav bar plus `SimulationBar` precede content on every shell route (`AppShell.tsx:27-29`). | Add a visually hidden skip link as the first focusable element in `AppShell`, targeting an `id` on `<main>`. |
| A11Y-18 | 1.3.1; 2.4.6 Headings and Labels | minor | Heading structure gaps. `/workloads` has no `<h1>`: the list title is a `<span>` (`WorkloadList.tsx:33`) and the detail starts at `<h2>` (`DetailPanel.tsx:52`). `AttributionPage` goes from `<h1>` (`:70`) to `<h3>` row titles with no `<h2>` (`LiveAccrualBoard.tsx:162`). `/agent-workflows` has two `<h1>` elements when the `<details>` is open (`pages/agent-workflows.tsx:34` and `src/agent-workflows/FrankWorkspace.tsx:76`), and the page's own `<h1>` is inside a collapsed `<details>` (`pages/agent-workflows.tsx:28-34`), so it is hidden when collapsed. Many section captions are `<p>` rather than headings (`FindingsPage.tsx:425,441,494,502`), though they sit inside labelled `<section>` elements. | Give every route one visible `<h1>`; keep levels sequential; promote the visible section captions to headings where they introduce content. |
| A11Y-19 | 4.1.2 Name, Role, Value | minor | Tab-like patterns without matching ARIA. `DetailPanel` renders seven section buttons with `aria-pressed` inside a `<nav>` and shows only the active body, with no tablist, tab, or tabpanel link (`DetailPanel.tsx:71-87,93-101`). `MissionDetail` has the correct keyboard model, but the tablist role is placed on a `<nav>` (`MissionDetail.tsx:178`), which overrides navigation semantics, and non-selected tabs point `aria-controls` at panel ids that do not exist (`:191`). | In `DetailPanel`, either keep it as a toggle-button group with a heading for the body, or adopt the `MissionDetail` tab pattern. In `MissionDetail`, use a `<div role="tablist">` and render or omit the `aria-controls` for inactive tabs. |
| A11Y-20 | 4.1.2 | minor | `aria-label` on elements without a role, which assistive technology may ignore: `ValueRatioMeter.tsx:41-45` (a `<span>`; the visible text is read anyway), `GateDots.tsx:18-20` (spans; likely works inside a button name, confirm). The `meter` and `progressbar` values: `ValueRatioMeter.tsx:61` passes an unrounded `aria-valuenow` that can exceed `aria-valuemax` of 10 and has no `aria-valuetext` (only `aria-label`), and `BudgetBar.tsx:35` allows `aria-valuenow` above `aria-valuemax` of 100 when overspent. | Put `role="img"` on labelled spans or move the text into hidden content. Clamp values to the max, and add `aria-valuetext` with the unit ("2.4 times value return"). |
| A11Y-21 | 1.4.3 Contrast (Minimum) | minor | Tinted chips and opacity combinations that fall under 4.5:1. `paused` demand shape: `dim` on a 10 percent `dim` tint, 2.56 on slab (`DemandShapeBadge.tsx:11,19-22`). Active segmented buttons `text-gate` on `bg-gate/20` over raised or slab, about 4.3 at 10 to 11px (`FocusDoorWalk.tsx:100`, `GovernanceTab.tsx:104`). `text-cost/80` on slab, 4.39 (`LiveAccrualBoard.tsx:166,190`). Locked governance cards dim all text with `opacity-50`, about 2.4 for `sub` text on slab (`GovernanceTab.tsx:88`); only controls are exempt as inactive, not explanatory text. | Remove the opacity-50 wrapper from explanatory text (dim only the control), strengthen chip text or background, and use full-opacity text for `/80` cases. |
| A11Y-22 | 1.1.1 Non-text Content | minor | The live charts are `<figure aria-label>` containing `aria-hidden` SVGs, so the accessible content is only the label (`LiveAccrualBoard.tsx:76-77,117-118`). The per-row dollar values are repeated in the leaderboard text below (`:159-169`), so the bars are partly covered; the 60-second accrual curve has no text equivalent beyond the portfolio total. | Add a short visible or visually hidden summary ("Portfolio spend accrued $X over the last 60 seconds, rising/flat") and a `<figcaption>`. |
| A11Y-23 | 2.1.1 Keyboard; 1.4.13 Content on Hover or Focus; 1.1.1 | minor | `SpendToValueGraph`: every workload point is a separate tab stop (`SpendToValueGraph.tsx:239`), so a portfolio of dozens of workloads adds dozens of tab stops with no way to skip the chart. The tooltip is `pointer-events-none` (`:328`), so it cannot be hovered, has no Escape dismissal, and is not tied to its point by `aria-describedby` (`:324-336`). The figure has an `aria-label` but no `<figcaption>` or data table (`:93-96`). | Make the plot a single tab stop with arrow-key movement between points (roving tabindex), allow Escape to dismiss the tooltip, add `aria-describedby`, and add a collapsible data table. The existing per-point `aria-label` is a good basis. |
| A11Y-24 | 1.3.1 Info and Relationships | minor | `<th>` elements without `scope` and, in places, with `title` carrying the real name: `pages/frameworks.tsx:118-138`, `src/costsource/CostSourcePage.tsx:529-536`, `src/prediction/PredictionPage.tsx:266-270`, `pages/reports.tsx:20`. | Add `scope="col"` or `scope="row"`; put full gate names in visible or hidden text. |
| A11Y-25 | 2.4.6 Headings and Labels; 2.4.4 Link Purpose; 4.1.2 | minor | Repeated generic control names that rely on position for context: "Acknowledge" on every alert (`AlertHistoryTab.tsx:84-90`), "Approve" on each of four gates (`GovernanceTab.tsx:98-109`), and "Connect", "Ingest now", "Disconnect", "Test connection" on every connector card (`ConnectorCard.tsx:265-293,319`). | Use `aria-label` or `aria-labelledby`/`aria-describedby` that includes the item name ("Acknowledge budget alert for Support Triage"). |
| A11Y-26 | 1.3.1; 1.1.1 | minor | Glyph-only severity and trend. The Footer severity icon (`◉`, `△`, `○`) is not hidden or labelled and no severity word accompanies it (`src/components/layout/Footer.tsx:11-21,61-63`); screen readers read the symbol name. The Footer alert buttons also lack an announcement when new alerts arrive. Trend arrows `▲`/`▼` precede signed percentages that carry the meaning (`WorkloadCard.tsx:59`), so are low risk. | Add a visually hidden severity word or `aria-label`; mark decorative glyphs `aria-hidden`. |
| A11Y-27 | 1.4.10 Reflow; 1.4.4 Resize Text; 1.4.12 Text Spacing | minor (confirm) | Layout risks to test. The Footer is `h-8 overflow-hidden` with non-shrinking buttons, so alerts are clipped at narrow widths and when text grows (`Footer.tsx:49,55-60`). `AppShell` is `h-screen` with a two-row nav on small screens (`AppShell.tsx:26`, `NavBar.tsx:35-48`) plus `SimulationBar`, which may leave little scroll area at 400 percent zoom. The six nav links sit in a horizontal scroll strip (`NavBar.tsx:48`) and the workload cards in a horizontal strip with `w-[82vw]` cards (`WorkloadList.tsx:37,46`), both of which may count as two-dimensional scrolling at 320px. Fixed `md:h-10` nav bar (`NavBar.tsx:35`). | Test at 320x256 CSS px and 200/400 percent zoom. Replace clipped single-line strips with wrapping, allow the Footer to grow or move its content into a disclosure, and check text-spacing overrides (line height 1.5, letter 0.12em, word 0.16em, paragraph 2em). |
| A11Y-28 | 1.4.4; 1.4.12 | minor | Very small fixed-pixel type. In the reviewed files: 107 uses of `text-[10px]`, 62 of `text-[11px]`, 14 of `text-[9px]`, 13 of `text-[12px]`, 1 of `text-[13px]`. Pixel sizes ignore the user's default font size setting (rem-based sizes would follow it) and 9 to 11px monospace labels are hard to read even at full contrast. Browser zoom is not blocked (no `user-scalable` or `maximum-scale`). | Set a minimum of 12px (0.75rem) for text, convert arbitrary `text-[Npx]` classes to rem-based scale entries, and reserve sub-12px for non-essential decoration. |
| A11Y-29 | 2.2.2 Pause, Stop, Hide; 2.3.3 (AAA, advisory) | minor | Unguarded decorative motion: Tailwind `animate-pulse` on "Frank is reviewing..." (`ChatPanel.tsx:174`) and on the active dictation button, which pulses for as long as listening lasts (`ChatInput.tsx:90`); `transition-all` on `ValueRatioBar.tsx:28`; `transition-[width] duration-1000` on `LiveAccrualBoard.tsx:174`. `src/index.css` has no `prefers-reduced-motion` rule. | Use `motion-safe:animate-pulse`, or add a global `@media (prefers-reduced-motion: reduce)` block in `src/index.css` that disables animations and transitions. |

### 3.2 Counts by severity

Blocker: 2 (A11Y-01, A11Y-02). Major: 14 (A11Y-03 to A11Y-16). Minor: 13 (A11Y-17 to A11Y-29). Total: 29. One major (A11Y-16) and one minor (A11Y-27) are marked "confirm" because they depend on rendering; A11Y-20 also contains one sub-item to confirm.

### 3.3 Checked, no static finding

These areas were searched and no failing pattern was found. They still need the manual passes in section 5; "no static finding" is not "passes".

1. Language of page (3.1.1): `lang="en"` is set (`pages/_document.tsx:8`).
2. Images (1.1.1): there is no `<img>`, `<Image>`, or `<canvas>` in the reviewed files. The only graphics are inline SVG icons (all `aria-hidden`) and the two chart components covered above.
3. Click handlers on non-interactive elements (2.1.1, 4.1.2): a search for `onClick` on `div`, `span`, `li`, `tr`, `td`, `p`, `section`, and `article` found none. The one `role="button"` on a non-button is the SVG point group, which has keyboard handling (`SpendToValueGraph.tsx:238-252`).
4. Icon-only buttons without a name (4.1.2): none found; all icon buttons carry `aria-label`.
5. Form labels (3.3.2, 1.3.1): all `input`, `select`, and `textarea` elements found have a label or `aria-label`. Placeholders are supplemental. No `autocomplete` need (1.3.5) was identified because no personal-data fields exist in the reviewed files.
6. Color-only encoding (1.4.1): the budget bar is paired with percentage and status text (`BudgetProfileTab.tsx:54-59,215-219`, `FuelAndValue.tsx:70-75`), the ratio bar and meter with the numeric ratio (`ValueRatioBar.tsx:20-25`, `ValueRatioMeter.tsx:46`), connector state with a label (`ConnectorCard.tsx:175-180`), mission status with a word (`MissionCard.tsx:47-52`), alert severity with a label (`AlertHistoryTab.tsx:61-66`), and scatter points are positioned by value. The unconfigured-source marker in `CostSourcePage.tsx` is a red/green dot (`:54-60`) accompanied by a `DARK` text badge for unconfigured sources (`:205-209`).
7. Zoom blocking: no `user-scalable=no` or `maximum-scale` meta found in `pages/` or `src/`.
8. Keyboard traps (2.1.2): none found. The window-level Escape handlers (`ChatPanel.tsx:75-80`, `MissionDetail.tsx:83-89`) close rather than trap. They can both fire on one keypress when the panel is open over the mission detail view; confirm.
9. Single-character shortcuts (2.1.4): none found.

---

## 4. Contrast table (computed)

### Method

Relative luminance and contrast ratio are computed per WCAG 2.1 (sRGB linearization, `(L1 + 0.05) / (L2 + 0.05)`). Token values come from `tailwind.config.js` and the matching list in `.obvious/obvious.md`. Alpha blends are straight source-over composites of the stated color on the stated surface; Tailwind `/10` and the inline `1a` suffix are treated as 10 percent. Thresholds: 4.5:1 for normal text; 3:1 for large text (at least 24px, or at least 18.66px bold) and for non-text UI and graphics. Values below 4.5 are marked `F`; values below 3.0 are marked `FF` (fail even as large text or a graphic).

### 4.1 Dark surfaces: text and semantic tokens on each background

Background hex: void `#05070b`, deep `#090c12`, slab `#0d1119`, raised `#141a26`, edge `#1a2235`.

| Foreground (hex) | on void | on deep | on slab | on raised | on edge |
|---|---|---|---|---|---|
| txt `#d0d8ea` | 14.10 | 13.69 | 13.22 | 12.19 | 11.10 |
| sub `#8895ad` | 6.67 | 6.48 | 6.25 | 5.76 | 5.25 |
| dim `#4d5a72` | 2.90 FF | 2.82 FF | 2.72 FF | 2.51 FF | 2.28 FF |
| value `#00e09e` | 11.67 | 11.33 | 10.94 | 10.08 | 9.18 |
| cost `#ff5c72` | 6.74 | 6.55 | 6.32 | 5.83 | 5.31 |
| shape `#ffc44d` | 12.72 | 12.35 | 11.93 | 11.00 | 10.01 |
| gate `#7c8dff` | 6.83 | 6.63 | 6.40 | 5.90 | 5.37 |
| unit `#00ccee` | 10.44 | 10.13 | 9.78 | 9.02 | 8.21 |
| purple `#b490ff` | 8.04 | 7.80 | 7.54 | 6.95 | 6.32 |
| aws `#ff9900` | 9.42 | 9.14 | 8.83 | 8.14 | 7.41 |
| azure `#0078d4` | 4.45 F | 4.32 F | 4.17 F | 3.85 F | 3.50 F |
| gcp `#4285f4` | 5.66 | 5.49 | 5.30 | 4.89 | 4.45 F |

Reading: txt, sub, and the six semantic tokens pass for normal text on every dark surface. `dim` fails on every surface, including as large text. `azure` fails for normal text on every dark surface (it is used as a fill or border in the cloud-provider color set; no reviewed file uses it as text, so this matters only if it is later used for labels). `gcp` fails only on `edge`.

### 4.2 Light (executive) surfaces

Backgrounds: exec-surface `#ffffff`, exec-bg `#f5f8fb`, exec-hover `#edf2f7`.

| Foreground (hex) | on #ffffff | on #f5f8fb | on #edf2f7 |
|---|---|---|---|
| exec-text `#0f172a` | 17.85 | 16.75 | not computed |
| exec-muted `#64748b` | 4.76 | 4.46 F | 4.23 F |
| value `#00e09e` | 1.73 FF | 1.62 FF | not computed |
| cost `#ff5c72` | 2.99 FF | 2.80 FF | not computed |
| shape `#ffc44d` | 1.58 FF | 1.49 FF | not computed |
| gate `#7c8dff` | 2.95 FF | 2.77 FF | not computed |
| unit `#00ccee` | 1.93 FF | 1.81 FF | not computed |
| purple `#b490ff` | 2.51 FF | 2.35 FF | not computed |
| exec-border `#d8e1ec` (as UI boundary) | 1.32 FF | 1.24 FF | not computed |

Reading: the accent tokens fail on the light surface for text and for graphics. The status chip pattern (accent text on a 10 percent tint of itself) is lower still: value 1.61, shape 1.51, unit 1.79, purple 2.31, cost 2.69, gate 2.69 on white. `exec-muted` is marginal and fails on the page background and hover color. `exec-border` is a decorative card border here, but would fail 1.4.11 if it were the only cue for an input.

Candidate dark variants for light surfaces (each passes 4.5:1 on white, `#f5f8fb`, and `#edf2f7`): value `#007d58`, cost `#bd4454`, shape `#876829`, gate `#5b67ba`, unit `#00788c`, purple `#7960ab`, exec-muted `#606f85`. Candidate replacement for `dim` text on dark surfaces: `#818a9b` (5.44 slab, 5.01 raised, 4.56 edge), or `#7a8395` if text must also pass on void and deep (5.29, 5.13, 4.96, 4.57).

### 4.3 Specific pairs in use

| Pair | Ratio | Result | Where |
|---|---|---|---|
| white on gate `#7c8dff` (logo mark text) | 2.95 | F (decorative, `aria-hidden`) | `NavBar.tsx:38-43` |
| void on purple (`F` glyph in launcher) | 8.04 | pass | `NavBar.tsx:78-84` |
| void on gate (button label) | 6.83 | pass | `AttributionPage.tsx:151`, `CostSourcePage.tsx:223` |
| void on shape (Apply button label) | 12.72 | pass | `FindingsPage.tsx:564-568` |
| cost at 80 percent on slab (`text-cost/80`) | 4.39 | F | `LiveAccrualBoard.tsx:166,190` |
| gate text on `gate/20` over raised (active chip) | 4.30 | F | `FocusDoorWalk.tsx:100`, `GovernanceTab.tsx:104` |
| dim text on `dim/10` over slab (`paused` badge) | 2.56 | FF | `DemandShapeBadge.tsx:11,19-22` |
| sub at 50 percent opacity on slab (locked gate card text) | 2.44 | FF | `GovernanceTab.tsx:88` |
| `edge` ring on deep (Findings focus ring) | 1.23 | FF | `FindingsPage.tsx:550,576,605,622,629` |
| `edge` border on slab (input boundary) | 1.19 | FF | `Filters.tsx:103`, `ChatInput.tsx:113` |
| `dim` placeholder on slab | 2.72 | FF | `ChatInput.tsx:113`, `FindingsPage.tsx:622` |
| `dim` ring (pending gate dot) on slab | 2.72 | FF (non-text) | `GateDots.tsx:24` |
| `txt/40` threshold tick on void | 2.95 | FF (non-text) | `BudgetBar.tsx:71` |
| cost at 40 percent (overshoot) on void | 1.89 | FF (non-text) | `BudgetBar.tsx:49-60` |
| `sub/50` 1x line on raised track | 2.43 | FF (non-text) | `ValueRatioMeter.tsx:79` |
| `dim/70` 3x line on raised track | 1.86 | FF (non-text) | `ValueRatioMeter.tsx:88` |
| cost point at 0.6 opacity on slab | 2.93 | FF (non-text) | `SpendToValueGraph.tsx:295` |
| value, shape, unit points at 0.6 opacity on slab | 4.52, 4.85, 4.15 | pass for 3:1 | `SpendToValueGraph.tsx:295` |
| `shape/60` focus ring on void (Apply) | 4.92 | pass | `FindingsPage.tsx:564` |

### 4.4 Reproduction script

```python
def L(h):
    h = h.lstrip('#'); r = [int(h[i:i+2], 16)/255 for i in (0, 2, 4)]
    r = [c/12.92 if c <= 0.03928 else ((c+0.055)/1.055)**2.4 for c in r]
    return 0.2126*r[0] + 0.7152*r[1] + 0.0722*r[2]

def cr(a, b):
    hi, lo = sorted([L(a), L(b)], reverse=True)
    return (hi + 0.05) / (lo + 0.05)

def mix(fg, bg, alpha):  # straight source-over blend of fg on bg
    f, b = fg.lstrip('#'), bg.lstrip('#')
    return '#' + ''.join(f"{round(int(f[i:i+2],16)*alpha + int(b[i:i+2],16)*(1-alpha)):02x}" for i in (0, 2, 4))

bg = dict(void='#05070b', deep='#090c12', slab='#0d1119', raised='#141a26', edge='#1a2235')
fg = dict(txt='#d0d8ea', sub='#8895ad', dim='#4d5a72', value='#00e09e', cost='#ff5c72',
          shape='#ffc44d', gate='#7c8dff', unit='#00ccee', purple='#b490ff',
          aws='#ff9900', azure='#0078d4', gcp='#4285f4')
for name, f in fg.items():
    print(name, {b: round(cr(f, v), 2) for b, v in bg.items()})
print('exec-muted on white', round(cr('#64748b', '#ffffff'), 2))
print('cost/40 on void', round(cr(mix('#ff5c72', '#05070b', .4), '#05070b'), 2))
```

---

## 5. Manual test plan

This plan lists what a person must do before anyone can say anything about conformance. Record results (pass, fail, partial, tester, browser, assistive technology version, date) per page in a new file; do not edit this worklist to hide failures.

### 5.1 Test environments

| Area | Minimum matrix |
|---|---|
| Screen reader, Windows | NVDA (current release) with Firefox and with Chrome. JAWS with Chrome if procurement asks for it. |
| Screen reader, macOS | VoiceOver with Safari, and with Chrome. |
| Screen reader, mobile | VoiceOver on iOS Safari at least once on `/` and the agent panel. TalkBack on Android Chrome if mobile is in scope. |
| Keyboard only | No mouse or trackpad. Windows with Chrome and Firefox, macOS with Safari (enable "Press Tab to highlight each item" in Safari settings). |
| Zoom and reflow | 200 percent browser zoom at 1280px, and 400 percent zoom (equivalent to 320 CSS px wide, 256 CSS px tall). Also a real 320px-wide viewport in device emulation. |
| Other | Windows High Contrast / forced colors; text spacing override bookmarklet (1.4.12); `prefers-reduced-motion: reduce` on; color vision deficiency simulation for the ratio scale and budget bar. |

### 5.2 Pages in priority order

Priority reflects primary user paths and the number of findings that land on the page.

| Priority | Route | What to test | Findings to re-check |
|---|---|---|---|
| 1 | `/` Findings | With NVDA and VoiceOver: land on the page, hear the page title and heading structure; move through the ranked list and confirm rank, ratio, spend, evidence mark, and status are announced; select a finding; read the meter, evidence, graph, and impact. Keyboard only: Select, Apply, Dismiss, and the pre-approved reference form, checking visible focus on every control and where focus goes after each action. Confirm Apply result and error are announced. Zoom to 200 and 400 percent: both panes remain usable without clipping. | A11Y-02, 03, 04, 06, 10, 12, 15, 16, 23 |
| 2 | Agent panel (launcher in every shell page) | Open by keyboard from the nav bar; confirm focus moves into the panel, tab order inside is sensible, Escape closes, and focus returns to the launcher. Send a message; confirm the reply and the "reviewing" status are announced once and not repeated. Dictation and spoken-reply toggles: pressed state announced. Confirm the panel does not hide the page's only focusable controls at 320px. | A11Y-05, 10, 29 |
| 3 | `/workloads` | List filters (pressed states), card selection, detail section buttons, each tab's content, Demand Shaping radios and sliders, Governance Approve toggles, Alert acknowledge. Footer alerts at 200 percent and 400 percent. Screen reader pass over the Multi-Model comparison and Token breakdown. | A11Y-03, 07, 08, 09, 14, 18, 19, 25, 26, 27 |
| 4 | `/overview` | Executive default surface: contrast of status chips, ratio text, and the Technical view toggle in normal and high-contrast modes; portfolio graph by keyboard and screen reader; check the duplicate-main landmark. | A11Y-01, 03, 13, 16, 23 |
| 5 | `/connectors` | Connect, ingest, retry, and disconnect on several cards with a screen reader; confirm status and error announcements (including live-region insertion behavior); disabled Test button reason; FOCUS version buttons' state. | A11Y-07, 09, 10, 25 |
| 6 | `/frameworks` | Gate table navigation in NVDA (table mode) and VoiceOver (table navigation); confirm each cell's pass, locked, or not-reviewed status is available as text; header names for G1 to G4. | A11Y-09, 24 |
| 7 | `/reports`, `/outcomes`, `/agent-workflows` | Table headers in the reports table; select and textarea labels; collapsed `<details>` and heading structure; job status and failure messages. Exports (PDF and XLSX) as separate artifacts. | A11Y-18, 24 |
| 8 | `/attribution` | Start the live board and confirm it can be paused; confirm ticking numbers do not flood the screen reader; run with reduced motion on; segmented control state; loading and error announcements. | A11Y-07, 10, 11, 22, 29 |
| 9 | `/costsource`, `/prediction` | Source picker and version state; loading and error announcements; the canonical rows table with 7 columns at 200 percent and in a narrow viewport (horizontal scroll inside the table region is allowed for data tables, but the page must not scroll in two dimensions). | A11Y-03, 07, 10, 24 |
| 10 | `/demo`, `/mission`, `/simulation`, `/workspace`, `/finio`, `/tokenomics`, `/hello` | Not statically reviewed or only partly. Perform a full pass, starting with the identity picker in `/simulation` and the customer workflow in `/workspace`, since the Playwright suite exercises these flows. `/mission` should be checked for the Escape-key behavior with the chat panel open. | A11Y-05 (demo launcher) and unknown |

### 5.3 Script for every page

1. Page title and one `<h1>`; heading list (NVDA `H` / VoiceOver rotor) is sequential.
2. Landmarks list: one banner or nav, one main, no duplicates.
3. Tab through the whole page. Every interactive element reachable, order matches visual order, focus always visible with at least 3:1 contrast, no keyboard trap.
4. Every control announces name, role, and state (pressed, expanded, selected, disabled).
5. Every status change (loaded, saved, failed, applied) is announced without moving focus; focus is not lost after an action removes the control.
6. Zoom to 200 percent, then 400 percent: no clipped text, no loss of function, no two-dimensional page scroll (data tables and charts excepted only where the criterion allows).
7. Text spacing override and forced colors: content still readable and not clipped.
8. Reduced motion: nothing animates continuously without a pause control.
9. Contrast: spot-check rendered colors with a color picker against the numbers in section 4, especially any state not in this table (hover, disabled, selected).

---

## 6. Automated checks that could be added later (not added)

Named here only so the team can plan. None of these were installed, configured, or run, and `package.json`, lint config, and tests were not changed. Automated tools find only a minority of WCAG issues; they supplement section 5, they do not replace it.

1. `eslint-plugin-jsx-a11y` with the flat-config `recommended` (later `strict`) preset added to `eslint.config.mjs`. Would catch missing labels, `alt`, invalid roles, click handlers without keyboard handlers, and `aria-*` misuse at lint time. It cannot see styling, so it will not find the focus ring or contrast issues.
2. `@axe-core/playwright` scans in the existing Playwright simulation suite (`tests/simulation`, `playwright.simulation.config.ts`) on each route, with a documented baseline of known failures. Real browser, so the `color-contrast` rule works there; it would flag A11Y-01 and A11Y-12 patterns, duplicate `main`, missing title, and heading order.
3. `vitest-axe` (or `jest-axe`) over rendered components with `@testing-library/react`. Useful for roles, names, and labels on small components; the `color-contrast` rule is unreliable in `jsdom` and `happy-dom`, which have no layout.
4. A pure unit test of the design-token contrast table (the section 4 script as a Vitest test) that fails if a documented text token pair drops below 4.5:1, or a non-text pair below 3:1. No new dependency is required.
5. A Playwright keyboard walk that tabs through each route and asserts that the focused element has a visible outline or box-shadow of at least 3:1, that focus is never `document.body` after an action, and that no more than a set number of tab stops exist in the chart.
6. A Playwright reflow check at 320x256 and at 200 percent zoom asserting that `document.documentElement.scrollWidth <= window.innerWidth` outside designated scroll regions.
7. Playwright with `page.emulateMedia({ reducedMotion: 'reduce' })` plus a check of `document.getAnimations()` to confirm nothing runs continuously.
8. A repository guard (a CI grep or a small custom ESLint rule using `no-restricted-syntax`) that rejects `focus:outline-none` without a sibling `focus-visible:` utility, `title=` used as the only text alternative, and `text-dim` on text elements.
9. Lighthouse CI accessibility category on a built preview, as a coarse regression trend (it runs a subset of axe).
10. `pa11y-ci` against `npm run dev` or a built server for a quick multi-route smoke scan, if the team prefers a standalone CLI to Playwright integration.

---

## 7. Suggested order of work

1. Add the global `:focus-visible` rule and remove the invisible-ring overrides (A11Y-02): small, high impact, one file.
2. Fix the light-surface accent colors and the `dim` token (A11Y-01, A11Y-12, A11Y-13, A11Y-21) with design approval, then lock the numbers with the unit test in section 6, item 4.
3. Add page titles, remove duplicate `main`, add a skip link (A11Y-03, 04, 17).
4. Add `aria-pressed`/radio semantics through one shared segmented control, and fix the Demand Shaping radios (A11Y-07, 08).
5. Fix focus management in the agent panel and after Dismiss, Apply, and Acknowledge (A11Y-05, 06) and add persistent live regions (A11Y-10).
6. Add the Pause control to the live board (A11Y-11).
7. Turn on `jsx-a11y` in lint and `@axe-core/playwright` in the browser suite, then run the full manual plan in section 5 and record results.
