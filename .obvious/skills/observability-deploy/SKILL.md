---
name: observability-deploy
description: Ratio's self-hosted observability reference architecture — Prometheus + Grafana under zero-trust SSO. Metric & label schema, recording/alerting rules bound to budget thresholds, persona dashboards, identity-aware proxy + mTLS, K8s + Docker Compose topology, and implementation/security considerations.
version: 1.0.0
triggers:
  - observability
  - prometheus
  - grafana
  - metrics exporter
  - zero trust
  - sso proxy
  - mtls
  - alertmanager
  - persona dashboard
author: autobuild
created: 2026-06-26
---

# Observability Deploy — Ratio (`realjkg/finops-ratio`)

Reference architecture for the case where the org runs **no COTS FinOps
dashboard**: Ratio's value, cost, and governance signals are published as
Prometheus metrics, surfaced through Grafana persona dashboards, and every access
path is gated behind an SSO endpoint under zero-trust principles. This realizes
the **publish-don't-aggregate** and **one-source-of-truth, persona-projected**
tenets in `.obvious/obvious.md`.

> **Scope.** This is a reference contract, not an implementation deliverable. The
> exporter, rule packs, Grafana dashboard JSON, Helm values, and proxy config are
> follow-on implementation waves — no such code ships with the contract. This skill
> defines what those waves implement.

## 1. Zero-trust tenets (applied)

| Tenet | Meaning here | Where enforced |
|---|---|---|
| **Never trust the network** | Nothing is reachable just because it is "inside." Prometheus & Alertmanager have no native auth, so they are never exposed directly. | proxy, NetworkPolicy |
| **Verify explicitly** | Every request carries a verified identity (OIDC) and a verified peer cert (mTLS). | OIDC + mTLS |
| **Least privilege** | IdP group → Ratio persona/role → scoped dashboards and label-scoped queries. | proxy authz |
| **Assume breach** | Short-lived tokens, no static creds, audit logging, fail-closed gateway, blast-radius limits. | proxy, secrets |

## 2. Component topology + data flow

The engine exposes an OpenMetrics `/metrics` endpoint. Prometheus scrapes it,
evaluates recording rules (derived series) and alerting rules (tied to the
budget thresholds in obvious.md), and hands firing alerts to Alertmanager, which
routes to the same Slack/email/webhook channels as the `cost-reporting` routine.
Grafana queries Prometheus over PromQL to render persona dashboards. **Every
component sits behind the identity-aware proxy; nothing is exposed without a
verified SSO identity.**

```
Persona browser (untrusted)
   │ HTTPS
   ▼
Identity-aware proxy (oauth2-proxy / Pomerium, fail-closed)  ⇄  OIDC IdP (Okta / Entra ID / Keycloak)
   │ authz: IdP group → persona
   ├→ Grafana (native OIDC + RBAC) ─ PromQL/mTLS → Prometheus
   ├→ Prometheus (no native auth) ─ scrape /metrics/mTLS → Ratio engine
   │        └ fire rules → Alertmanager (no native auth) → Slack / Email / Webhook
   └→ Alertmanager (via proxy)
```

**Trust boundaries.** (1) Public→Edge: TLS terminates at the proxy; no
unauthenticated request proceeds. (2) Edge→Mesh: the proxy injects a verified
identity header and opens an mTLS connection; Prometheus/Alertmanager are only
ever reached *through* it. (3) Mesh-internal: scrapes/queries are mutually
authenticated; the engine only accepts scrapes presenting Prometheus's client
cert.

## 3. Metric & label schema

Metrics follow Prometheus conventions (snake_case, base-unit suffixes, `ratio_`
namespace) and map onto the obvious.md data model. **Every cost series is
published alongside its value-ratio series** — a dashboard or alert can never
surface `ratio_spend_dollars` without `ratio_value_ratio` being queryable on the
identical label set.

Common labels on every series: `workload`, `model`, `team`, `provider`,
`environment`, `tenant`.

| Metric | Type | Extra labels | Source |
|---|---|---|---|
| `ratio_value_ratio` | gauge | — | `value.value_ratio` (R4) |
| `ratio_total_value_dollars` | gauge | — | `value.total_value` |
| `ratio_revenue_protected_dollars` | gauge | — | `value.revenue_protected` |
| `ratio_cost_avoided_dollars` | gauge | — | `value.cost_avoided` |
| `ratio_spend_dollars` | gauge | `period="daily\|monthly"` | `costs.daily_spend` / `monthly_spend` |
| `ratio_budget_dollars` | gauge | `period="daily\|monthly"` | `costs.daily_budget` / `monthly_budget` |
| `ratio_budget_consumed_ratio` | gauge | `period="daily\|monthly"` | `daily_spend / daily_budget` |
| `ratio_burn_rate_dollars_per_hour` | gauge | — | derived run-rate (forecast-engine) |
| `ratio_forecast_eom_dollars` | gauge | `method="weighted_avg_7d"` | `forecast.projected_eom` |
| `ratio_forecast_days_until_breach` | gauge | — | `forecast.days_until_breach` |
| `ratio_unit_cost_dollars` | gauge | `unit="call\|resolved\|user\|deflection"` | `unit_costs.*` (R1) |
| `ratio_tokens_total` | counter | `direction="input\|output\|cached"` | `costs.tokens_*` |
| `ratio_token_price_dollars_per_1m` | gauge | `direction="input\|output\|cached"` | `unit_costs.cost_per_1k_*` |
| `ratio_resolution_rate` | gauge | — | `outputs.resolution_rate` |
| `ratio_governance_gate_passed` | gauge (0/1) | `gate="policy\|ethics\|cost\|scale"` | `governance.*` (R3) |
| `ratio_demand_shape_info` | gauge (=1) | `shape="always_on\|business_hours\|throttled\|batch_offpeak\|paused\|unmanaged"` | `demand_shape` (R2) |
| `ratio_cost_trend_ratio` | gauge | — | `cost_trend_pct` |
| `ratio_alert_active` | gauge (0/1) | `alert_type`, `severity` | Alert |
| `ratio_portfolio_value_ratio` | gauge | (no `workload` label) | `/portfolio/ratio` |

`*_dollars` are whole currency units; `*_ratio` are unitless (0–1 for
consumed/rate fractions, ×-multiple for value ratio). Counters
(`ratio_tokens_total`) are monotonic — read with `rate()`/`increase()`.

## 4. Recording & alerting rules

**Recording rules** precompute derived/portfolio series so dashboards stay cheap:

| Recording rule | Expression (sketch) |
|---|---|
| `ratio:portfolio_value_ratio:sum` | `sum(ratio_total_value_dollars) / sum(ratio_spend_dollars{period="monthly"})` |
| `ratio:value_per_dollar:ratio` | `ratio_total_value_dollars / ratio_spend_dollars{period="monthly"}` |
| `ratio:budget_consumed:max_by_team` | `max by (team) (ratio_budget_consumed_ratio{period="daily"})` |

**Alerting rules** bind directly to the obvious.md budget thresholds so the metric
plane and the in-app threshold system fire on the same boundaries:

| Alert | Condition | Severity | Threshold mapping |
|---|---|---|---|
| `RatioBudgetSoft` | `ratio_budget_consumed_ratio >= 0.70` | warning | soft (70%) |
| `RatioBudgetHard` | `ratio_budget_consumed_ratio >= 0.90` | critical | hard (90%) |
| `RatioBudgetKill` | `ratio_budget_consumed_ratio >= 1.00` | critical | kill (100%) |
| `RatioForecastBreach` | `ratio_forecast_eom_dollars > ratio_budget_dollars{period="monthly"}` | warning | forecast breach |
| `RatioValueRatioDrop` | `ratio_value_ratio < 3` | warning | value review |
| `RatioValueRatioCritical` | `ratio_value_ratio < 2` | critical | value critical |
| `RatioGovernanceMissing` | `ratio_demand_shape_info{shape="always_on"} == 1 and on(workload) ratio_governance_gate_passed{gate="scale"} == 0` | critical | gate enforcement |

Alertmanager routes by `severity` and `team` labels to the `cost-reporting`
delivery channels. The label-to-channel routing tree (`alertmanager.yml`) is an
implementation-wave artifact.

## 5. Grafana persona dashboards

Grafana renders **the same underlying series projected per persona** — each
dashboard is a *lens* (different panels, default variables, label scopes) over
identical Prometheus data. No persona gets a divergent copy of the truth.

| Persona | Default lens | Representative panels / queries |
|---|---|---|
| **Data analyst** | granularity & trends | raw `ratio_*` series, token attribution via `rate(ratio_tokens_total[5m])`, forecast-accuracy backtest |
| **Billing specialist** | reconciliation | `ratio_spend_dollars` vs FOCUS-ingested cost, `ratio_token_price_dollars_per_1m`, per-provider unit costs |
| **Procurement / business** | value & governance | `ratio_value_ratio`, `ratio_forecast_eom_dollars`, `ratio_governance_gate_passed` heatmap, demand-shape table |
| **Finance / leadership** | portfolio | `ratio:portfolio_value_ratio:sum`, total value vs total spend, top/bottom workloads by ratio |

Persona scoping is enforced two ways: Grafana RBAC + folder permissions decide
*which* dashboards a role sees; a templated `tenant`/`team` query variable (bound
from the proxy's identity claim) decides *which series* render inside them.

## 6. Zero-trust SSO access layer

- **SSO endpoint.** OIDC is primary (authorization-code + PKCE); SAML supported
  where the IdP standardizes on it. The IdP (Okta, Entra ID, Keycloak) is the
  single sign-on authority for all backends.
- **Identity-aware proxy.** Because Prometheus and Alertmanager ship no native
  auth, an identity-aware reverse proxy (**oauth2-proxy** or **Pomerium**) fronts
  them and terminates the OIDC session. **Grafana uses its own native OIDC** (and
  may also sit behind the proxy for defense in depth). The proxy is the policy
  enforcement point: it validates the session, maps IdP group → persona/role, and
  authorizes via an external policy engine (**OPA**) or its own rules.
- **mTLS.** Component-to-component traffic is mutually authenticated; certs are
  issued/rotated by **cert-manager** (K8s) or a **service mesh** (Istio/Linkerd).
  Prometheus presents a client cert the engine's `/metrics` requires, so an
  unauthenticated scrape is refused at the TLS layer.

| Layer | Mechanism | Protects |
|---|---|---|
| Authentication | OIDC (PKCE) / SAML at the IdP | who you are |
| Session / edge authz | oauth2-proxy or Pomerium, fail-closed | which backend you may reach |
| Fine-grained authz | IdP group → persona/role via OPA / proxy rules | which dashboards & label scopes |
| Transport | mTLS proxy↔backend and Prometheus↔engine (cert-manager / mesh) | peer identity, no in-mesh sniffing |
| Secrets / tokens | short-lived OIDC tokens, rotated scrape/datasource creds | replay & credential theft |
| Audit | proxy + Grafana access logs to the SIEM | breach detection, forensics |

**SSO-down behavior (fail-closed).** If the IdP/proxy is unavailable, the gateway
fails closed: no new authenticated sessions; Grafana/Prometheus/Alertmanager are
unreachable from the browser. The *data plane* stays up by design — the engine
keeps computing, Prometheus keeps scraping/evaluating over mTLS (an internal path
that does not traverse the human-facing proxy), and **Alertmanager keeps routing
to Slack/email/webhook**, so budget-breach and forecast alerts still reach owners
even when interactive dashboards are dark. Existing proxy sessions expire at
their short TTL.

## 7. Deployment topology

**Kubernetes (primary).** Install **kube-prometheus-stack** (Prometheus Operator +
Prometheus + Alertmanager + Grafana) and **cert-manager** for mTLS issuance. The
engine ships a `ServiceMonitor` so the Operator auto-discovers its `/metrics`
target. The identity-aware proxy runs as ingress auth (nginx `auth_request` to
oauth2-proxy, or Pomerium as ingress controller). `NetworkPolicy` denies
pod-to-pod traffic except declared scrape/query paths.

```
kube-prometheus-stack ── Prometheus ┬ scrapes Ratio /metrics (ServiceMonitor, mTLS)
                      │             └ recording + alerting rules (PrometheusRule)
                      ├ Alertmanager ─ Slack / email / webhook
                      └ Grafana (native OIDC, provisioned persona dashboards)
cert-manager ─ issues/rotates mTLS certs
ingress (nginx auth_request → oauth2-proxy | Pomerium) ─ fail-closed SSO edge
```

**Docker Compose (smaller deployments).** Single-host stack — `prometheus`,
`alertmanager`, `grafana`, `oauth2-proxy`, and the engine — on one Docker network,
with the proxy as the only published port and TLS certs mounted from a local CA.
Suitable for a pilot/single-team install; trades Operator auto-discovery and HA
for simplicity. Scrape targets and rules are static-file mounted, not CRD-managed.

## 8. Implementation & security considerations

- **Label cardinality.** `workload × model × team × provider × environment (×
  tenant)` can explode series count. Never make high-churn identifiers (request
  IDs, user IDs) labels; cap `model`/`workload` to registry-known values;
  pre-aggregate hot panels via recording rules; set `sample_limit`/`target_limit`
  on scrape jobs; alert on `prometheus_tsdb_head_series` growth.
- **Retention & downsampling.** Local TSDB retention sized to dashboard need
  (15–30d); for long-horizon forecast-accuracy backtests, remote-write to
  **Thanos**/**Mimir**/**Cortex** with downsampling rather than inflating local
  retention.
- **High availability.** Redundant Prometheus replicas (Operator-managed) +
  clustered Alertmanager for gossip-deduplicated notifications;
  Thanos/Mimir provides a global query view and dedup across replicas.
- **Secrets management.** OIDC client secrets, scrape mTLS certs, and Alertmanager
  webhook URLs live in a secrets manager (K8s Secrets sealed via SOPS/Sealed-
  Secrets, or Vault) — never in dashboards or rule files; rotate on the
  cert-manager schedule.
- **Multi-tenancy.** The `tenant` label + Grafana org/RBAC + proxy authz isolate
  tenants; for hard isolation use per-tenant Prometheus (or Mimir tenants). The
  proxy injects the tenant claim; dashboards cannot widen their own scope.
- **Composition with attribution tools (FOCUS seam).** Attribution tools
  (eBPF/packet taggers) own the **numerator** — what it cost and who consumed it,
  at high resolution — and feed FOCUS-normalized cost series into the same plane;
  Ratio publishes the **denominator** — value, value ratio, forecast, governance —
  on matching `workload`/`team` labels. The two render **together in one Grafana
  panel**. Ratio never performs kernel-level capture (see obvious.md positioning
  tenets); it attaches the value lens.
- **Threat model (assume breach).** The **proxy** stops unauthenticated/over-scoped
  access to auth-less Prometheus & Alertmanager; **OIDC + short-lived tokens**
  limit credential theft/replay; **mTLS** stops in-mesh sniffing and rogue
  scrapers; **OPA/RBAC** contains a valid-but-wrong identity to its persona's
  scope; **NetworkPolicy** limits lateral movement; **audit logs** make a breach
  detectable. The fail-closed gateway degrades an SSO outage to *no human access*,
  never *open access*.

