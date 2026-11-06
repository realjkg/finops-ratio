#!/usr/bin/env python3
"""Runtime validation harness for the Ratio telemetry discovery kit (Python 3.9+, stdlib only).

Status of the kit until this harness passes on a real machine and the owner reviews the evidence:
synthetic-validated, runtime validation pending.

  python3 -I runtime_validate.py offline                       # G1-G2, no binaries needed
  python3 -I runtime_validate.py fetch-tools --dest ./tools-bin
  python3 -I runtime_validate.py validate --otelcol ./tools-bin/otelcol-contrib \
      --promtool ./tools-bin/promtool --out ./evidence [--disk-full]

Gates (each PASS, FAIL or NOT_RUN; any FAIL exits non-zero):
  G1 KIT_IDENTITY        file hashes match MANIFEST.sha256; git revision recorded
  G2 SCRIPT              self-test count pinned; every scenario meets its exact expectation
  G3 TOOL_VERSIONS       pinned versions; binary hashes recorded (and compared to tools-lock.json)
  G4 COLLECTOR_CONFIG    otelcol-contrib validate on the exact config
  G5 PROMETHEUS_RULES    promtool check rules + promtool test rules
  G6 OTLP_INGESTION      known traces, usage logs and metrics produce exact expected outputs
  G7 PRIVACY             canaries absent from every output (files, sink, Prometheus, Collector log)
  G8 SAMPLING            usage never sampled; error and slow traces all kept; the rest bounded
  G9 DURABILITY          dedup by eventId, destination outage, restart with a queued backlog, queue pressure
  G10 DISK_FULL          optional (--disk-full, macOS hdiutil): acknowledged events survive a full queue disk

Ports used on 127.0.0.1: 4317, 4318, 8888, 8889, 9109, 9411, 13133.
"""

from __future__ import annotations

import argparse
import copy
import functools
import gzip
import hashlib
import json
import platform
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
KIT = HERE / "ratio_telemetry_check.py"
VERSIONS = json.loads((HERE / "versions.json").read_text())
PORTS = [4317, 4318, 8888, 8889, 9109, 9411, 13133]
OTLP = "http://127.0.0.1:4318"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run(cmd: List[str], cwd: Optional[Path] = None, timeout: int = 600) -> Tuple[int, str]:
    p = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, text=True)
    return p.returncode, p.stdout


def http_get(url: str, timeout: float = 5) -> Tuple[int, str]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except (urllib.error.URLError, OSError):
        return 0, ""


def post_json(path: str, payload: Dict[str, Any], timeout: float = 10) -> int:
    req = urllib.request.Request(OTLP + path, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except (urllib.error.URLError, OSError):
        return 0


def wait_until(pred, timeout: float, step: float = 0.5) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(step)
    return pred()


def port_free(port: int) -> bool:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def attr(record: Dict[str, Any], key: str) -> Optional[str]:
    for a in record.get("attributes", []):
        if a["key"] == key:
            v = a["value"]
            return v.get("stringValue", v.get("intValue"))
    return None


def jsonl_objects(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


# ---------------------------------------------------------------------------
# Local servers: usage sink (durable destination stand-in) and fixture textfile server
# ---------------------------------------------------------------------------
class Sink:
    def __init__(self, port: int, record_path: Path):
        self.mode = "up"
        self.deliveries: List[str] = []
        self.lock = threading.Lock()
        self.record_path = record_path
        sink = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:
                pass

            def do_POST(self) -> None:  # noqa: N802
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if self.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                if sink.mode != "up" or self.path != "/v1/logs":
                    self.send_response(503)
                    self.end_headers()
                    return
                text = body.decode(errors="replace")
                with sink.lock:
                    with open(sink.record_path, "a") as f:
                        f.write(text + "\n")
                    for rl in json.loads(text).get("resourceLogs", []):
                        for sl in rl.get("scopeLogs", []):
                            for rec in sl.get("logRecords", []):
                                eid = attr(rec, "ratio.usage.eventId")
                                if eid:
                                    sink.deliveries.append(eid)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")

        self.server = ThreadingHTTPServer(("127.0.0.1", port), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def delivered(self) -> List[str]:
        with self.lock:
            return list(self.deliveries)

    def close(self) -> None:
        self.server.shutdown()


def serve_dir(port: int, directory: Path) -> ThreadingHTTPServer:
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *a: Any) -> None:
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Quiet, directory=str(directory)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class Collector:
    def __init__(self, binary: Path, config: Path, rundir: Path, log: Path):
        self.binary, self.config, self.rundir, self.log = binary, config, rundir, log
        self.proc: Optional[subprocess.Popen] = None

    def start(self) -> bool:
        (self.rundir / "collector-out" / "queue").mkdir(parents=True, exist_ok=True)
        self._fh = open(self.log, "a")
        self._fh.write(f"\n=== start {datetime.now(timezone.utc).isoformat()} config={self.config.name}\n")
        self._fh.flush()
        self.proc = subprocess.Popen([str(self.binary), "--config", str(self.config)], cwd=self.rundir,
                                     stdout=self._fh, stderr=subprocess.STDOUT)
        return wait_until(lambda: http_get("http://127.0.0.1:13133/")[0] == 200, 30)

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(30)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(10)
        if getattr(self, "_fh", None):
            self._fh.close()
        wait_until(lambda: port_free(4318) and port_free(13133), 15)


# ---------------------------------------------------------------------------
# Gates
# ---------------------------------------------------------------------------
class Evidence:
    def __init__(self, out: Path):
        self.out = out
        self.gates: List[Dict[str, Any]] = []

    def gate(self, gid: str, status: str, details: Any, commands: Optional[List[str]] = None) -> None:
        self.gates.append({"gate": gid, "status": status, "details": details, "commands": commands or []})
        print(f"  {status:7} {gid}")


def g1_identity(ev: Evidence) -> None:
    manifest = HERE / "MANIFEST.sha256"
    mismatches, files = [], {}
    for line in manifest.read_text().splitlines():
        if not line.strip():
            continue
        digest, name = line.split(None, 1)
        p = HERE / name.strip()
        got = sha256(p) if p.exists() else "missing"
        files[name.strip()] = got
        if got != digest:
            mismatches.append(name.strip())
    code, head = run(["git", "-C", str(HERE), "rev-parse", "HEAD"])
    code2, dirty = run(["git", "-C", str(HERE), "status", "--porcelain", "--", "."])
    ev.gate("G1 KIT_IDENTITY", "FAIL" if mismatches else "PASS",
            {"mismatches": mismatches, "files": files, "gitRevision": head.strip() if code == 0 else "not a git checkout",
             "uncommittedChangesInKit": dirty.strip().splitlines() if code2 == 0 else "unknown",
             "python": sys.version.split()[0], "platform": platform.platform()})


def g2_script(ev: Evidence, work: Path) -> Optional[Path]:
    expected = json.loads((HERE / "expected-results.json").read_text())
    code, out = run([sys.executable, "-I", str(KIT), "self-test"])
    m = re.search(r"self-test: (OK|\d+ FAILURE\(S\)) \((\d+) checks\)", out)
    count_ok = bool(m) and m.group(1) == "OK" and int(m.group(2)) == expected["selfTestChecks"]
    scenario_results = {}
    for sc in expected["scenarios"]:
        c, o = run([sys.executable, "-I", str(KIT), "run", "--workdir", str(work / sc), "--scenario", sc,
                    "--fixture-key"])
        scenario_results[sc] = {"exit": c, "outcome": o.strip().splitlines()[-1] if o.strip() else ""}
    ok = code == 0 and count_ok and all(v["exit"] == 0 for v in scenario_results.values())
    (ev.out / "self-test.log").write_text(out)
    ev.gate("G2 SCRIPT", "PASS" if ok else "FAIL",
            {"selfTest": m.group(0) if m else out[-500:], "expectedChecks": expected["selfTestChecks"],
             "scenarios": scenario_results},
            [f"python3 -I {KIT.name} self-test", f"python3 -I {KIT.name} run --scenario <each> --fixture-key"])
    return work / "bypass"


def g3_versions(ev: Evidence, otelcol: Path, promtool: Path) -> None:
    _, ov = run([str(otelcol), "--version"])
    _, pv = run([str(promtool), "--version"])
    want_o, want_p = VERSIONS["otelcol-contrib"]["version"], VERSIONS["prometheus"]["version"]
    lock = HERE / "tools-lock.json"
    hashes = {"otelcol-contrib": sha256(otelcol), "promtool": sha256(promtool)}
    lock_ok = True
    if lock.exists():
        recorded = json.loads(lock.read_text()).get("binaries", {})
        lock_ok = all(recorded.get(k, {}).get("sha256") == v for k, v in hashes.items())
    ok = want_o in ov and want_p in pv and lock_ok
    ev.gate("G3 TOOL_VERSIONS", "PASS" if ok else "FAIL",
            {"otelcol": ov.strip(), "promtool": pv.strip().splitlines()[0] if pv.strip() else "", "sha256": hashes,
             "matchesToolsLock": lock_ok if lock.exists() else "no tools-lock.json (run fetch-tools)",
             "containerImages": "none used"})


def g4_config(ev: Evidence, otelcol: Path) -> None:
    code, out = run([str(otelcol), "validate", "--config", str(HERE / "otel-collector.yaml")])
    ev.gate("G4 COLLECTOR_CONFIG", "PASS" if code == 0 else "FAIL", {"exit": code, "output": out[-3000:]},
            ["otelcol-contrib validate --config otel-collector.yaml"])


def g5_rules(ev: Evidence, promtool: Path) -> None:
    c1, o1 = run([str(promtool), "check", "rules", "prometheus-rules.yml"], cwd=HERE)
    c2, o2 = run([str(promtool), "test", "rules", "prometheus-rules.test.yml"], cwd=HERE)
    ev.gate("G5 PROMETHEUS_RULES", "PASS" if c1 == 0 and c2 == 0 else "FAIL",
            {"check": o1[-2000:], "test": o2[-3000:]},
            ["promtool check rules prometheus-rules.yml", "promtool test rules prometheus-rules.test.yml"])


def usage_records(payload: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    rl = payload["resourceLogs"][0]
    recs = [r for r in rl["scopeLogs"][0]["logRecords"] if attr(r, "event.name") == "ratio.ai_usage"]
    return rl["resource"], recs


def wrap_logs(resource: Dict[str, Any], records: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"resourceLogs": [{"resource": resource, "scopeLogs": [{"scope": {"name": "ratio.usage"},
                                                                    "logRecords": records}]}]}


def relabel(record: Dict[str, Any], suffix: str) -> Tuple[Dict[str, Any], str]:
    r = copy.deepcopy(record)
    for a in r["attributes"]:
        if a["key"] == "ratio.usage.eventId":
            a["value"]["stringValue"] += suffix
            return r, a["value"]["stringValue"]
    raise SystemExit("usage record without ratio.usage.eventId")


def scrape_counters(text: str) -> Dict[str, str]:
    keep = {}
    for line in text.splitlines():
        if line.startswith("otelcol_") and ("usage_sink" in line or "receiver=\"otlp\"" in line) and (
                "enqueue_failed" in line or "send_failed" in line or "refused" in line or "queue_size" in line
                or "sent_log" in line or "accepted_log" in line):
            name, _, value = line.rpartition(" ")
            keep[name] = value
    return keep


def counter_total(counters: Dict[str, str], fragment: str) -> float:
    return sum(float(v) for k, v in counters.items() if fragment in k)


def runtime_gates(ev: Evidence, otelcol: Path, bypass: Path, disk_full: bool) -> None:
    busy = [p for p in PORTS if not port_free(p)]
    if busy:
        for g in ("G6 OTLP_INGESTION", "G7 PRIVACY", "G8 SAMPLING", "G9 DURABILITY"):
            ev.gate(g, "FAIL", {"reason": f"ports already in use: {busy}"})
        return
    payloads = bypass / "collector-canary-payloads"
    manifest = json.loads((payloads / "manifest.json").read_text())
    rundir = ev.out / "collector-run"
    if rundir.exists():
        shutil.rmtree(rundir)
    rundir.mkdir(parents=True)
    base_cfg = (HERE / "otel-collector.yaml").read_text()
    (rundir / "otel-collector.yaml").write_text(base_cfg)
    log = ev.out / "collector.log"
    sink = Sink(9411, ev.out / "sink-deliveries.jsonl")
    fixture_srv = serve_dir(9109, bypass / "out")
    col = Collector(otelcol, rundir / "otel-collector.yaml", rundir, log)
    try:
        if not col.start():
            for g in ("G6 OTLP_INGESTION", "G7 PRIVACY", "G8 SAMPLING", "G9 DURABILITY"):
                ev.gate(g, "FAIL", {"reason": "collector did not become healthy", "log": str(log)})
            return
        logs_payload = json.loads((payloads / "usage_logs.otlp.json").read_text())
        posts = {"logs": post_json("/v1/logs", logs_payload),
                 "traces": post_json("/v1/traces", json.loads((payloads / "traces.otlp.json").read_text())),
                 "metrics": post_json("/v1/metrics", json.loads((payloads / "metrics.otlp.json").read_text()))}
        want_ids = manifest["usageEventIds"]
        out_dir = rundir / "collector-out"
        wait_until(lambda: set(want_ids) <= set(sink.delivered()), 30)
        time.sleep(20)  # tail-sampling decision_wait (10 s) + batch timeout + file flush
        prom_ok = wait_until(lambda: "ratio_ai_tokens_total" in http_get("http://127.0.0.1:8889/metrics")[1], 45)
        _, prom_text = http_get("http://127.0.0.1:8889/metrics")
        usage_file = [attr(r, "ratio.usage.eventId") for o in jsonl_objects(out_dir / "usage-events.jsonl")
                      for rl in o.get("resourceLogs", []) for sl in rl.get("scopeLogs", []) for r in sl["logRecords"]]
        sink_ids = sink.delivered()
        kept_spans = [s for o in jsonl_objects(out_dir / "traces.jsonl") for rs in o.get("resourceSpans", [])
                      for ss in rs.get("scopeSpans", []) for s in ss.get("spans", [])]
        kept = {s["traceId"].lower() for s in kept_spans}
        tids = {k: {t.lower() for t in v} for k, v in manifest["traceIds"].items()}
        probe = [l for l in prom_text.splitlines() if l.startswith("ratio_fixture_probe{")]
        probe_ok = any('team="team-alpha"' in l and "note=" not in l and re.search(r"\} 42(\.0)?( |$)", l) for l in probe)
        tf_line = next(l for l in (bypass / "out" / "ratio_ai.prom").read_text().splitlines()
                       if l.startswith("ratio_ai_tokens_total{"))
        tf_labels, tf_value = tf_line[tf_line.index("{") + 1:tf_line.index("}")], tf_line.rsplit(" ", 1)[1]
        tf_ok = any(l.startswith("ratio_ai_tokens_total{") and all(p in l for p in tf_labels.split(","))
                    and float(l.rsplit(" ", 1)[1]) == float(tf_value) for l in prom_text.splitlines())
        span_metrics = any(re.match(r"^traces_span_metrics_calls(_total)?\{", l) for l in prom_text.splitlines())
        survive_traces = all(any(a["key"] == k for s in kept_spans for a in s.get("attributes", []))
                             for k in manifest["mustSurvive"]["traces"])
        usage_objs = jsonl_objects(out_dir / "usage-events.jsonl")
        survive_logs = all(any(a["key"] == k for o in usage_objs for rl in o["resourceLogs"] for sl in rl["scopeLogs"]
                               for r in sl["logRecords"] for a in r.get("attributes", []))
                           for k in manifest["mustSurvive"]["logs"])
        ingestion_ok = (all(v == 200 for v in posts.values()) and sorted(usage_file) == sorted(want_ids)
                        and sorted(sink_ids) == sorted(want_ids) and probe_ok and tf_ok and prom_ok
                        and survive_traces and survive_logs and span_metrics)
        ev.gate("G6 OTLP_INGESTION", "PASS" if ingestion_ok else "FAIL", {
            "postStatus": posts, "usageEventsExpected": len(want_ids), "usageInFile": len(usage_file),
            "usageAtSink": len(sink_ids), "probeMetricLines": probe, "textfileSeriesMatched": tf_ok,
            "spanMetricsPresent": span_metrics, "requiredFieldsSurvived": {"traces": survive_traces,
                                                                           "logs": survive_logs}})
        # privacy: every configured output plus the Collector's own log
        sources = {"traces.jsonl": out_dir / "traces.jsonl", "usage-events.jsonl": out_dir / "usage-events.jsonl",
                   "sink-deliveries.jsonl": ev.out / "sink-deliveries.jsonl", "collector.log": log}
        texts = {k: (p.read_text(errors="replace") if p.exists() else "") for k, p in sources.items()}
        texts["prometheus:8889"] = prom_text
        texts["internal-metrics:8888"] = http_get("http://127.0.0.1:8888/metrics")[1]
        hits = sorted({f"{k}: {c}" for k, t in texts.items() for c in manifest["canaries"] if c in t})
        emails = sorted({k for k, t in texts.items()
                         if re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}", t)})
        ev.gate("G7 PRIVACY", "PASS" if not hits and not emails and ingestion_ok else "FAIL",
                {"canaryHits": hits, "emailShapedValuesIn": emails, "outputsScanned": sorted(texts),
                 "note": "canaries were injected in log bodies, span and resource attributes, span events, "
                         "exception messages, status messages and nested kvlist values"})
        ok_kept = len(kept & tids["ok"])
        sampling_ok = (tids["error"] <= kept and tids["slow"] <= kept and ok_kept <= 30
                       and sorted(usage_file) == sorted(want_ids))
        ev.gate("G8 SAMPLING", "PASS" if sampling_ok else "FAIL", {
            "errorKept": f"{len(kept & tids['error'])}/{len(tids['error'])}",
            "slowKept": f"{len(kept & tids['slow'])}/{len(tids['slow'])}",
            "okKept": f"{ok_kept}/{len(tids['ok'])} (policy 10 %; bound 30)",
            "usageUnsampled": sorted(usage_file) == sorted(want_ids)})
        durability(ev, col, sink, logs_payload, rundir, base_cfg, otelcol, log, disk_full)
    finally:
        col.stop()
        fixture_srv.shutdown()
        sink.close()


def durability(ev: Evidence, col: Collector, sink: Sink, logs_payload: Dict[str, Any], rundir: Path,
               base_cfg: str, otelcol: Path, log: Path, disk_full: bool) -> None:
    resource, recs = usage_records(logs_payload)
    results: Dict[str, Any] = {}

    def post_each(batch: List[Dict[str, Any]]) -> Tuple[List[str], List[str]]:
        acked, rejected = [], []
        for r in batch:
            eid = attr(r, "ratio.usage.eventId")
            (acked if post_json("/v1/logs", wrap_logs(resource, [r])) == 200 else rejected).append(eid)
        return acked, rejected

    def delivered_all(ids: List[str], timeout: float) -> List[str]:
        wait_until(lambda: set(ids) <= set(sink.delivered()), timeout)
        return sorted(set(ids) - set(sink.delivered()))

    # a. duplicates: stable eventIds let the destination deduplicate
    before = len(sink.delivered())
    dup_ids, _ = post_each(recs[:5])
    missing = delivered_all(dup_ids, 30)
    all_d = sink.delivered()
    results["dedup"] = {"resent": len(dup_ids), "deliveriesAdded": len(all_d) - before,
                        "uniqueEventIds": len(set(all_d)), "duplicateDeliveries": len(all_d) - len(set(all_d)),
                        "ok": not missing and len(all_d) - len(set(all_d)) >= 5}
    # b. destination outage
    sink.mode = "down"
    batch_b = [relabel(r, f"-outage{i}")[0] for i, r in enumerate(recs[:20])]
    acked_b, rej_b = post_each(batch_b)
    time.sleep(8)
    sink.mode = "up"
    miss_b = delivered_all(acked_b, 90)
    results["outage"] = {"acked": len(acked_b), "rejected": len(rej_b), "acknowledgedButMissing": miss_b,
                         "ok": not miss_b and not rej_b}
    # c. restart with a queued backlog
    sink.mode = "down"
    batch_c = [relabel(r, f"-restart{i}")[0] for i, r in enumerate(recs[:10])]
    acked_c, rej_c = post_each(batch_c)
    time.sleep(3)
    col.stop()
    restarted = col.start()
    sink.mode = "up"
    miss_c = delivered_all(acked_c, 90)
    results["restart"] = {"acked": len(acked_c), "rejected": len(rej_c), "restartedHealthy": restarted,
                          "acknowledgedButMissing": miss_c, "ok": restarted and not miss_c and not rej_c}
    # d. queue pressure: a 5-request queue with the destination down
    col.stop()
    small = rundir / "otel-collector.pressure.yaml"
    small.write_text(base_cfg.replace("queue_size: 1000", "queue_size: 5"))
    pressure = Collector(otelcol, small, rundir, log)
    started = pressure.start()
    sink.mode = "down"
    batch_d = [relabel(r, f"-pressure{i}")[0] for i, r in enumerate((recs * 2)[:40])]
    acked_d, rej_d = post_each(batch_d)
    counters = scrape_counters(http_get("http://127.0.0.1:8888/metrics")[1])
    sink.mode = "up"
    miss_d = delivered_all(acked_d, 120)
    pressure.stop()
    visible = counter_total(counters, "enqueue_failed") + counter_total(counters, "refused") > 0
    results["queuePressure"] = {"started": started, "sent": len(batch_d), "acked": len(acked_d),
                                "rejectedToProducer": len(rej_d), "counters": counters,
                                "rejectionsVisibleInCounters": visible, "acknowledgedButMissing": miss_d,
                                "ok": started and len(rej_d) > 0 and visible and not miss_d,
                                "note": "rejected events were never acknowledged; the producer must retry them "
                                        "from its own durable outbox"}
    ok = all(v["ok"] for v in results.values())
    ev.gate("G9 DURABILITY", "PASS" if ok else "FAIL", results)
    if disk_full:
        disk_full_test(ev, otelcol, sink, resource, recs, rundir, base_cfg, log)
    else:
        ev.gate("G10 DISK_FULL", "NOT_RUN", {"reason": "pass --disk-full on macOS to run (uses hdiutil)"})
    col.proc = None  # already stopped


def disk_full_test(ev: Evidence, otelcol: Path, sink: Sink, resource: Dict[str, Any], recs: List[Dict[str, Any]],
                   rundir: Path, base_cfg: str, log: Path) -> None:
    if platform.system() != "Darwin" or shutil.which("hdiutil") is None:
        ev.gate("G10 DISK_FULL", "NOT_RUN", {"reason": "requires macOS hdiutil"})
        return
    dmg, mnt = rundir / "queue-full.dmg", rundir / "queue-full-mnt"
    mnt.mkdir(exist_ok=True)
    c1, o1 = run(["hdiutil", "create", "-size", "4m", "-fs", "HFS+", "-volname", "ratioqfull", str(dmg)])
    c2, o2 = run(["hdiutil", "attach", str(dmg), "-mountpoint", str(mnt), "-nobrowse"])
    if c1 or c2:
        ev.gate("G10 DISK_FULL", "FAIL", {"reason": "could not create the small volume", "output": o1 + o2})
        return
    try:
        cfg = rundir / "otel-collector.diskfull.yaml"
        cfg.write_text(base_cfg.replace("directory: ./collector-out/queue", f"directory: {mnt}"))
        col = Collector(otelcol, cfg, rundir, log)
        started = col.start()
        sink.mode = "down"
        acked, rejected = [], []
        for i in range(600):
            r, eid = relabel(recs[i % len(recs)], f"-disk{i}")
            (acked if post_json("/v1/logs", wrap_logs(resource, [r])) == 200 else rejected).append(eid)
        alive = col.proc is not None and col.proc.poll() is None
        sink.mode = "up"
        wait_until(lambda: set(acked) <= set(sink.delivered()), 180)
        missing = sorted(set(acked) - set(sink.delivered()))
        col.stop()
        ok = started and alive and not missing
        ev.gate("G10 DISK_FULL", "PASS" if ok else "FAIL",
                {"acked": len(acked), "rejectedToProducer": len(rejected), "collectorAliveWhenFull": alive,
                 "acknowledgedButMissing": missing[:20],
                 "note": "PASS requires every acknowledged event delivered after recovery; rejections are expected"})
    finally:
        run(["hdiutil", "detach", str(mnt)])


# ---------------------------------------------------------------------------
# Tool fetching (pinned versions, checksum-verified)
# ---------------------------------------------------------------------------
def fetch_tools(dest: Path) -> int:
    osname = {"Darwin": "darwin", "Linux": "linux"}.get(platform.system())
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64", "AMD64": "amd64"}.get(platform.machine())
    if not osname or not arch:
        print("unsupported platform", platform.system(), platform.machine())
        return 2
    dest.mkdir(parents=True, exist_ok=True)
    lock: Dict[str, Any] = {"fetchedAt": datetime.now(timezone.utc).isoformat(), "platform": f"{osname}-{arch}",
                            "archives": {}, "binaries": {}}
    for tool, member in (("otelcol-contrib", "otelcol-contrib"), ("prometheus", "promtool")):
        spec = VERSIONS[tool]
        archive = spec["archive"].format(version=spec["version"], os=osname, arch=arch)
        base = spec["releaseUrl"].format(version=spec["version"])
        for name in (archive, spec["checksums"].format(version=spec["version"])):
            target = dest / name
            if not target.exists():
                print(f"downloading {base}/{name}")
                urllib.request.urlretrieve(f"{base}/{name}", target)
        sums = (dest / spec["checksums"].format(version=spec["version"])).read_text()
        want = next((l.split()[0] for l in sums.splitlines() if l.strip().endswith(archive)), None)
        got = sha256(dest / archive)
        if want != got:
            print(f"CHECKSUM MISMATCH for {archive}: expected {want}, got {got}")
            return 3
        with tarfile.open(dest / archive) as tf:
            m = next(x for x in tf.getmembers() if x.name.split("/")[-1] == member and x.isfile())
            m.name = member
            tf.extract(m, dest)
        lock["archives"][archive] = {"sha256": got, "verifiedAgainst": spec["checksums"].format(version=spec["version"])}
        lock["binaries"][member] = {"sha256": sha256(dest / member), "version": spec["version"]}
    (dest / "tools-lock.json").write_text(json.dumps(lock, indent=2) + "\n")
    print(f"tools ready in {dest}; copy tools-lock.json next to runtime_validate.py to pin the binaries")
    return 0


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch-tools")
    f.add_argument("--dest", type=Path, default=Path("./tools-bin"))
    v = sub.add_parser("validate")
    v.add_argument("--otelcol", type=Path, required=True)
    v.add_argument("--promtool", type=Path, required=True)
    v.add_argument("--out", type=Path, default=Path("./evidence"))
    v.add_argument("--disk-full", action="store_true")
    o = sub.add_parser("offline", help="G1 and G2 only (no binaries needed)")
    o.add_argument("--out", type=Path, default=Path("./evidence-offline"))
    sub.add_parser("manifest", help="rewrite MANIFEST.sha256 for the kit files")
    a = ap.parse_args(argv)
    if a.cmd == "fetch-tools":
        return fetch_tools(a.dest)
    if a.cmd == "manifest":
        files = sorted(str(p.relative_to(HERE)) for p in HERE.rglob("*") if p.is_file() and p.name not in
                       ("MANIFEST.sha256", "tools-lock.json") and "__pycache__" not in p.parts)
        (HERE / "MANIFEST.sha256").write_text("".join(f"{sha256(HERE / f)}  {f}\n" for f in files))
        print(f"MANIFEST.sha256: {len(files)} files")
        return 0
    if a.cmd == "offline":
        a.out.mkdir(parents=True, exist_ok=True)
        ev = Evidence(a.out)
        g1_identity(ev)
        g2_script(ev, a.out / "kit-runs")
        (a.out / "offline-evidence.json").write_text(json.dumps({"gates": ev.gates}, indent=2) + "\n")
        failed = [g["gate"] for g in ev.gates if g["status"] == "FAIL"]
        print("  RESULT:", "FAIL " + ", ".join(failed) if failed else "offline gates passed (runtime gates not run)")
        return 1 if failed else 0
    a.out.mkdir(parents=True, exist_ok=True)
    ev = Evidence(a.out)
    started = datetime.now(timezone.utc).isoformat()
    print("== Ratio telemetry kit runtime validation ==")
    g1_identity(ev)
    bypass = g2_script(ev, a.out / "kit-runs")
    g3_versions(ev, a.otelcol.resolve(), a.promtool.resolve())
    g4_config(ev, a.otelcol.resolve())
    g5_rules(ev, a.promtool.resolve())
    if all(g["status"] == "PASS" for g in ev.gates):
        runtime_gates(ev, a.otelcol.resolve(), bypass, a.disk_full)
    else:
        for g in ("G6 OTLP_INGESTION", "G7 PRIVACY", "G8 SAMPLING", "G9 DURABILITY", "G10 DISK_FULL"):
            ev.gate(g, "NOT_RUN", {"reason": "an earlier gate failed"})
    failed = [g["gate"] for g in ev.gates if g["status"] == "FAIL"]
    report = {"kitStatusBeforeRun": "synthetic-validated, runtime validation pending", "startedAt": started,
              "finishedAt": datetime.now(timezone.utc).isoformat(), "host": platform.node(),
              "gates": ev.gates, "failed": failed,
              "statusChange": "an owner decision after reviewing this evidence; this harness never changes it"}
    (a.out / "runtime-evidence.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"  evidence: {a.out / 'runtime-evidence.json'}")
    print("  RESULT:", "FAIL " + ", ".join(failed) if failed else "all mandatory gates passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
