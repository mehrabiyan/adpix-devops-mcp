# Self-Learning Foundation Layer — design spec

Status: **design only, not implemented.** This is the substrate every self-learning
capability (Casebook, Reflexion Runbooks, tune_loop, Learned Baselines, Incident
Distiller, Fleet Memory) must build on. It is deliberately the *first* thing to build,
because every one of those capabilities is unsafe without it.

## 0. Why this exists

The MCP already emits labeled experience (AI-fix transcripts, watchdog incidents with
`recovered` outcomes, deploy/rollback history). The temptation is to mine that directly
into the AI fixer's prompt. The discovery pass (adversarial critique of 6 designs)
showed that is unsafe: every design that trusts the model's *own* "it's fixed" claim
learns the wrong lesson, leaks tenant PII, and amplifies a confident-but-wrong fix
across the fleet. The fix is one foundational principle and one missing piece:

- **Principle — self-TEACH freely, self-ACT only when gated.** The learning loop is
  read-only: mine logs → label outcomes → store correctable knowledge. Actions stay
  in the existing tools behind `confirm/preflight/launch-gate`.
- **Missing piece — a correction loop.** Everything the capabilities do *accumulates
  and amplifies*; nothing *corrects*. The foundation provides (a) a **ground-truth
  labeler** that attributes recovery to an action only when it can deconfound it, and
  (b) a **verdict ledger** that lets operators (and delayed real-world outcomes)
  overturn a label and propagate that overturn to retire downstream learned artifacts.

The foundation produces a correct, correctable, anonymized **dataset of attributed
episodes**. It injects nothing into the live fixer and takes no action. Capabilities
1–6 consume it later through one read API.

## 1. The unit of learning — the Episode

One intervention attempt and its deconfounded outcome.

```ts
interface Episode {
  id: string;                 // hash(server + actor + startedAt) — stable, dedupe key
  server: string;             // registry server name; SCOPE KEY — never crosses hosts
  actor: "ai_fix" | "watchdog_restart" | "autodeploy" | "operator" | "tune_loop" | "none";
  symptom: SymptomSignature;  // structured, anonymized (closed vocab only)
  window: { startedAt: string; actionAt?: string; observedUntil: string };
  action: ActionFacts;        // DETERMINISTIC facts only — never model narration
  outcome: Outcome;           // machine label + confidence + confounders
  verdict: Verdict;           // operator / delayed correction layer
  releaseSha?: string;        // git HEAD on the target at episode time — staleness key
  provenance: string[];       // source log paths + line refs (audit, not content)
  createdAt: string;
}

interface SymptomSignature {
  services: Service[];        // closed vocab: ingest|api|web|worker|identity-job|postgres|
                              //   clickhouse|redis|caddy|edge|sgtm|kafka
  failureClass: FailureClass; // enum: http_5xx|http_000|container_down|unhealthy|oom|
                              //   disk_full|merge_backlog|replication_lag|lock_contention|
                              //   idle_in_tx|cert_expiry|migrate_fail|health_gate_timeout|unknown
  consecutive: number;        // watchdog consecutive-failure depth = severity
  // NO free text, NO raw log lines, NO tenant/url/ip/visitor-id/secret. EVER.
}

interface ActionFacts {
  kind: "restart" | "rollback" | "redeploy" | "config_reload" | "vacuum" |
        "optimize" | "drop_partition" | "none" | "unknown";
  target: string;             // service name (closed vocab) or "commit"
  fromCommit?: string; toCommit?: string;
  evidenceSource: "deploys.jsonl" | "incidents.jsonl" | "container_starttime" |
                  "stream-json" | "none";   // how we KNOW what changed
}

interface Outcome {
  label: "recovered" | "still_down" | "confounded" | "inconclusive" | "regressed";
  confidence: number;         // 0..1
  recoveredAt?: string;
  sustainedChecks: number;    // consecutive ok checks after the action
  confounders: string[];      // ["watchdog_restart","autodeploy_rollback","self_recovery","other_ai_fix"]
  selfRecoveryBaseRate?: number;
  sampleSupport: number;      // n: how many comparable episodes back this label
}

interface Verdict {
  state: "machine" | "operator_confirmed" | "operator_overturned" | "auto_expired";
  by?: string; at?: string;
  note?: string;              // operator-authored free text ALLOWED here (not mined)
  demotes?: string[];         // artifact ids to quarantine on overturn
}
```

The critical fields: `action.evidenceSource` (verified-action-or-nothing) and
`outcome.label/confidence/confounders` (deconfounded ground truth, NOT `is_error`).

## 2. The labeling algorithm (the correctness core)

Pure functions in `src/learning/labeler.ts`. Input: a candidate window + the relevant
log slices. Output: `Outcome`. No I/O — fully unit-testable.

State machine (defaults in parentheses; all configurable, see §7):

1. **Action time** `actionAt` from DETERMINISTIC evidence only — a `deploys.jsonl`
   event ts, an `incidents.jsonl` `actions` field, or a container restart proven by a
   `docker inspect … StartedAt` delta. If none, `action.kind="unknown"`,
   `evidenceSource="none"` (this episode can never be a positive hint).
2. **Observation window** `[actionAt, actionAt + W]` (W = max(15 min, K checks)).
3. **Recovery** = first watchdog `recovered` event / `checks-log` `ok` after the `fail`
   run, at `recoveredAt`.
4. **Sustained-green gate**: require ≥K (3) consecutive `ok` checks after `recoveredAt`
   with no new `fail` for the same service set. Else `inconclusive`.
5. **Deconfound** → `confounded` if ANY of:
   - `recoveredAt < actionAt` (health returned before the action),
   - another actor's event (watchdog restart, autodeploy rollback, a second ai_fix) in
     `[startedAt, recoveredAt]`,
   - pre-action `checks-log` already trending `ok` (self-recovery in progress).
6. **Base-rate** gate: maintain per-symptom `selfRecoveryBaseRate` from historical
   `actor:"none"`/confounded-self episodes. A positive `recovered` credit requires the
   with-action recovery rate to beat the base rate, with `sampleSupport ≥ 5`.
7. **Label**: `recovered` (attributable) only if deterministic action + sustained-green
   + no confounder + beats base rate. Else `confounded` / `still_down` / `regressed` /
   `inconclusive`.
8. **Confidence** = f(sustainedChecks, sampleSupport, base-rate margin, evidenceSource).
   `evidenceSource="none"` and `sampleSupport<5` are hard-capped to a low floor and are
   **never** returned by the positive read API.

## 3. Storage — the ledger

- Location: client-side, per-server, `$ADPIX_DEVOPS_HOME/ledger/<server>.jsonl`
  (mode 600). Mirrors the registry isolation; the MCP host is the trust boundary.
- **Append-only, event-sourced.** Corrections are NEW lines (verdict-update events keyed
  by episode `id`), never in-place edits — the label history is auditable.
- Two record types per line: `{kind:"episode", ...Episode}` and
  `{kind:"verdict", id, ...Verdict}`. Readers fold verdict events over episodes.
- Retention: raw-derived episodes ≤90 d (match transcript retention); operator verdicts
  kept longer. TTL + release-SHA drift handled by `ledger_gc`.
- **Anonymization on write**: `src/learning/anonymize.ts` is an ALLOWLIST filter —
  only closed-vocab enum fields pass; any value outside the vocab is dropped (not
  regex-scrubbed). Raw logs, query text, tenant slugs, URLs, IPs, secrets never enter
  the ledger by construction.

## 4. Operator correction + demotion propagation

The discovery's "single highest-leverage missing capability."

- Episodes start `verdict.state="machine"`.
- `ledger_verdict` lets a human `confirm` or `overturn` a machine label
  (`confirm:true` required — it changes what the system will teach).
- Downstream learned artifacts (future casebook cases, runbook entries, tuned configs,
  evals, fleet lessons) MUST carry `sourceEpisodeIds: string[]`. A demotion index
  (`$ADPIX_DEVOPS_HOME/ledger/<server>.index.json`) maps episode → artifact ids.
- On `overturn`, every artifact sourced from that episode is flagged `quarantined`
  (not deleted — auditable) and excluded from injection. This is the correction loop.
- `ledger_gc` auto-expires episodes/artifacts when `releaseSha` drifts past threshold or
  TTL elapses (`auto_expired`) → stack-drift invalidation.

## 5. Tools — `src/tools/learning.ts` (read-only / advisory)

All take the `Deps` seam (hermetic tests). None mutate the production server;
`ledger_ingest`/`ledger_gc` write only the client-side ledger.

| Tool | Args | Does |
|---|---|---|
| `ledger_ingest` | `{server?, since?}` | SSH-read logs (reuse `gatherEvidence` globs), run the labeler, append new Episodes. Idempotent (dedupe by `id`). Read-only on the server. |
| `ledger_list` | `{server?, label?, actor?, minConfidence?, limit?}` | Query attributed episodes. |
| `ledger_show` | `{server?, id}` | Full episode + provenance + verdict history. |
| `ledger_verdict` | `{server?, id, verdict:"confirm"\|"overturn", note?, confirm}` | Operator correction; propagates demotion. **`confirm:true`** required. |
| `ledger_stats` | `{server?}` | Per-symptom base-rates, label distribution, attributable-recovery rate, quarantined %. The "is the learning real?" dashboard. |
| `ledger_gc` | `{server?, confirm}` | Apply TTL + release-drift expiry; quarantine stale artifacts. **`confirm:true`**. |

## 6. Integration contract — how capabilities consume it

`src/learning/ledger.ts` exposes the ONLY sanctioned read path for downstream learning:

```ts
loadEpisodes(server): Episode[]
attributableCases(server, opts): Episode[]   // label="recovered" AND verdict!="overturned"
                                             // AND confidence>=floor AND evidenceSource!="none"
                                             // AND !expired  — the ONLY positive-hint source
negativeCases(server): Episode[]             // still_down|regressed|overturned → what-NOT-to-do
baseRate(server, symptom): number
registerArtifact(server, episodeIds, artifactId): void
quarantineFor(server, episodeId): string[]   // ids quarantined
```

**Enforced rule (spec + code review):** no self-learning capability may read raw
transcripts/logs directly for a positive hint — it must go through
`attributableCases()`. That funnels every "lesson" through the deconfounded,
correctable, anonymized, per-host-scoped gate. Negative lessons are first-class.

## 7. Safety / privacy invariants (enforced, not aspirational)

1. **Read-only over SSH; writes only the client-side ledger** (mode 600, ADPIX_DEVOPS_HOME).
2. **No action — ever.** Not even gated. The foundation is pure knowledge; actions stay
   in the existing tools.
3. **Allowlist anonymization** — closed vocab only; pure unit-tested filter; raw logs
   never persisted.
4. **Per-server scoping** — no cross-host read/merge here. (Fleet Memory is a separate,
   later, opt-in layer that consumes this ledger.)
5. **`confirm:true` to change a verdict** — correction is a privileged op.
6. **Append-only + event-sourced** — verdict history auditable; nothing silently rewritten.
7. **Confidence floors** — `evidenceSource="none"` (model-narrated) and `sampleSupport<5`
   are never positive hints.

Tunables (registry-level config, documented defaults): `K`=3 sustained checks,
`W`=15 min window, `minSampleSupport`=5, `confidenceFloor`, `retentionDays`=90,
`releaseDriftExpiry`.

## 8. Test plan (hermetic — the existing Deps-seam pattern)

- `labeler.ts` — pure; **exhaustive** unit tests with synthetic windows: recovered-after-
  action (attributable), recovered-before-action (confounded), intervening watchdog
  restart (confounded), intervening rollback (confounded), sustained-green-fails
  (inconclusive), `n=1` (low confidence), `evidenceSource="none"` (never positive).
  This is the correctness core — test it hardest.
- `anonymize.ts` — prove PII/secrets never pass: visitor IDs, IPs, tenant slugs,
  `KEY=secret`, URLs, JWTs all dropped/rejected.
- `ledger.ts` — append/query/verdict/demotion-propagation with a temp `ADPIX_DEVOPS_HOME`
  (mirror `test/registry.test.ts`).
- tool handlers — `fakeDeps` responders returning synthetic `incidents.jsonl` /
  `run-*.json` / `deploys.jsonl`; assert episodes labeled correctly + `ledger_verdict`
  propagates a demotion.
- integration — the 6 tools auto-join the every-tool protocol smoke in
  `test/integration.test.ts`; add fixtures (`{server?}` / `{id,confirm:false}` etc.).

## 9. Non-goals (explicit)

- No auto-action / closed-loop control (that is `tune_loop`, later, separately gated).
- No cross-host sharing (Fleet Memory, later).
- No model fine-tuning (RAG / prompt-injection of advisory hints only).
- No injection into the live fixer in this layer — it just produces the correctable,
  attributed dataset.
- No mining of raw log text into the KB — structured signatures only.

## 10. File layout + milestones

```
src/learning/
  types.ts        # Episode / SymptomSignature / ActionFacts / Outcome / Verdict + enums
  labeler.ts      # pure deconfound state machine + base-rate + confidence
  anonymize.ts    # allowlist filter (closed vocab)
  ledger.ts       # append/query/fold + the integration read API (§6)
src/tools/learning.ts   # the 6 tools (register in src/tools/index.ts)
test/learning.test.ts   # labeler + anonymize + ledger + tools
docs/self-learning-foundation.md   # this file
```

- **M0** — `types` + `labeler` + `anonymize`, pure + fully tested. The correctness core,
  no I/O.
- **M1** — `ledger` storage + `ledger_ingest`/`ledger_list`/`ledger_show`. Immediate
  standalone value: an honest "what actually fixed what" history (no injection yet).
- **M2** — `ledger_verdict` + demotion index + `ledger_stats`. The correction loop.
- **M3** — `ledger_gc` (TTL + release-drift) + the `attributableCases()` read API frozen.
  Now capability #4 (Learned Baselines) / #2 (Reflexion Runbooks) may consume it.

## 11. Open decisions for the implementer

- **Action-source:** `claude -p --output-format json` carries no tool-call trace, so
  `WHAT I CHANGED` is narration. Start `evidenceSource`-deterministic-only (M1). To
  enrich `ActionFacts`, a *separate* later change to `aifix.ts` `claudeInvocation()`
  can switch to `--output-format stream-json` and persist the executed Bash/Edit stream.
  Do not block M1 on it.
- **Clock source:** all logs are server-side timestamps — the labeler joins on the
  server clock consistently; ignore MCP-host clock.
- **Base-rate cold start:** until `sampleSupport ≥ minSampleSupport` per symptom, every
  label is observational-only (no positive hints) — accept a learning warm-up period.
- **Where `releaseSha` comes from:** `git rev-parse HEAD` on the target at ingest time,
  joined to the episode window via `deploys.jsonl` `to` commit when present.
```
