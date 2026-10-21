---
name: cost-reporting
description: Ratio's automated cost-reporting routine — daily report (08:00 UTC), weekly report (Mon 08:00 UTC), and on-demand reports via the agent. Defines contents, cadence, and delivery.
version: 1.0.0
triggers:
  - cost report
  - daily report
  - weekly report
  - automated report
  - finops report
author: autobuild
created: 2026-06-26
---

# Cost Reporting — Ratio (`realjkg/finops-ratio`)

Automated cost reports deliver the value/forecast/governance numbers into the
channels each team already uses (Slack/email/webhook) — the publish-don't-aggregate
tenet in `.obvious/obvious.md`. Every cost figure carries its value-ratio context
(R4). Forecast figures come from the `forecast-engine` skill.

## Daily report — auto-generated 08:00 UTC

Delivered to the configured channel (Slack/email). Contents:

- Yesterday's total spend across all workloads.
- Each workload: spend vs daily budget (% utilization).
- Any alerts triggered yesterday.
- Updated monthly forecast with confidence interval.
- Portfolio value ratio (current).
- Top 3 workloads by spend and top 3 by value ratio (best and worst).

## Weekly report — auto-generated Monday 08:00 UTC

Includes everything in the daily report, plus:

- Week-over-week spend trend per workload.
- Model cost comparison — did any provider change pricing? (ties to the
  `model_cost_change` alert).
- Governance gate status changes.
- Demand-shaping recommendations for workloads trending >**20% WoW**.

## On-demand reports — via the agent

Users can ask the Ratio Agent (see `agent-prompt`) for a report scoped to a team,
workload, or period — e.g. "Generate a cost report for the CX team" or "Show me
this month's forecast as a table." The agent formats and delivers it in-chat in
the requested format (markdown / json / html).

## Delivery channels

Configurable per workload: in-app (always, default), Slack (webhook per
team/channel), email (distribution list per team), webhook (custom URL). Routing
is driven by `severity` and `team` labels.

