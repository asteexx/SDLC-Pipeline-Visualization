#!/usr/bin/env node
// convert_run.mjs — SDLC pipeline telemetry -> Generative-Agents per-step movement contract.
//
// Reads:   data/<run>/event_log.jsonl, data/<run>/pipeline_state.json,
//          config/pipeline_world.json, config/pipeline.dag.json
// Writes:  data/<run>/master_movement.json, data/<run>/meta.json
//
// Usage:   node convert_run.mjs [run_id]      (default run_id = "sample_run")
//
// M3b: agents enter/exit walled rooms ONLY through doors. The door of each room sits in the
// same column as its anchor; agents walk along corridor lanes (config.lanes) and pass through
// the door column. routeTo() builds wall-safe Manhattan paths; walkScene() animates them tile
// by tile so the engine (which slides between consecutive positions) follows the doorway.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN = process.argv[2] || "sample_run";
const runDir = join(__dirname, "data", RUN);

const world = JSON.parse(readFileSync(join(__dirname, "config", "pipeline_world.json"), "utf8"));
const dag = JSON.parse(readFileSync(join(__dirname, "config", "pipeline.dag.json"), "utf8"));
const state = JSON.parse(readFileSync(join(runDir, "pipeline_state.json"), "utf8"));
const events = readFileSync(join(runDir, "event_log.jsonl"), "utf8")
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

const { rooms, agents, phases, emoji } = world;
const LANE_TOP = world.lanes.top, LANE_BOT = world.lanes.bottom;
const LANE_MID = (LANE_TOP + LANE_BOT) / 2;   // zone split: <= MID is top half

const READ = 5, READ_LONG = 9, READ_SHORT = 3;

// --- live per-agent state (tile coords) ------------------------------------
const AGENT_IDS = Object.keys(agents);
const cur = {};
for (const id of AGENT_IDS) {
  cur[id] = { pos: [...agents[id].home], pron: emoji.idle, desc: `Idle @ Bullpen`, chat: null, mode: null };
}
cur.orchestrator.pos = [...rooms.orchestrator_hub.anchor];
cur.orchestrator.desc = `Standing by @ ${rooms.orchestrator_hub.label}`;

const steps = [];
function snapshot() {
  const frame = {};
  for (const id of AGENT_IDS) {
    const a = cur[id];
    frame[agents[id].display] = { movement: [a.pos[0], a.pos[1]], pronunciatio: a.pron, description: a.desc, chat: a.chat, ...(a.mode ? { mode: a.mode } : {}) };
  }
  return frame;
}

// --- door-aware routing ----------------------------------------------------
const WALLED = Object.fromEntries(Object.entries(rooms).filter(([, r]) => r.zone === "top" || r.zone === "bot"));
function roomContaining(pos) {
  for (const k in WALLED) {
    const [x, y, w, h] = WALLED[k].rect;
    if (pos[0] >= x && pos[0] < x + w && pos[1] >= y && pos[1] < y + h) return k;
  }
  return null;
}
const laneOfZone = (z) => (z === "top" ? LANE_TOP : LANE_BOT);
// pick a column clear of the hub/gate band [14,37] for lane-to-lane vertical transit,
// minimising total horizontal travel from the current column `cx` to the destination `destX`.
function connectorCol(cx, destX) {
  if (destX < 14 || destX > 37) return destX;        // destination column itself is clear
  const cost = (c) => Math.abs(cx - c) + Math.abs(c - destX);
  return cost(13) <= cost(38) ? 13 : 38;             // nearest clear side
}

function routeTo(from, to) {
  const wps = [];
  let cx = from[0], cy = from[1];
  const fromRoom = roomContaining(from), toRoom = roomContaining(to);

  // 1) exit a room (if inside) through its door column to its lane
  if (fromRoom) {
    const dx = rooms[fromRoom].anchor[0], lane = laneOfZone(rooms[fromRoom].zone);
    if (cx !== dx) { wps.push([dx, cy]); cx = dx; }
    wps.push([dx, lane]); cy = lane;
  } else {
    const lane = cy <= LANE_MID ? LANE_TOP : LANE_BOT;
    if (cy !== lane) { wps.push([cx, lane]); cy = lane; }
  }

  // 2) destination lane + column
  let destLane, destX;
  if (toRoom) { destX = rooms[toRoom].anchor[0]; destLane = laneOfZone(rooms[toRoom].zone); }
  else { destX = to[0]; destLane = to[1] <= LANE_MID ? LANE_TOP : LANE_BOT; }

  // 3) reach the destination lane (cross zones via the nearest clear column if needed)
  if (cy !== destLane) {
    const col = connectorCol(cx, destX);
    if (cx !== col) { wps.push([col, cy]); cx = col; }
    wps.push([col, destLane]); cy = destLane;
    if (cx !== destX) { wps.push([destX, destLane]); cx = destX; }
  } else if (cx !== destX) {
    wps.push([destX, destLane]); cx = destX;
  }

  // 4) final approach: into the room through the door, or to the corridor point
  if (toRoom) wps.push([destX, to[1]]);
  else if (cx !== to[0] || cy !== to[1]) wps.push([to[0], to[1]]);
  return wps;
}

function expandPath(from, wps) {
  const path = []; let [x, y] = from;
  for (const [tx, ty] of wps) {
    while (x !== tx) { x += Math.sign(tx - x); path.push([x, y]); }
    while (y !== ty) { y += Math.sign(ty - y); path.push([x, y]); }
  }
  return path;
}

// animate a set of moves (each may walk to `to` and/or set pron/desc/chat) in parallel
function walkScene(moves, read = READ) {
  for (const id of AGENT_IDS) cur[id].chat = null;
  const walkers = [];
  for (const m of moves) {
    if ("pron" in m) cur[m.id].pron = m.pron;
    if ("desc" in m) cur[m.id].desc = m.desc;
    if ("mode" in m) cur[m.id].mode = m.mode;
    if (m.to) {
      const path = expandPath(cur[m.id].pos, routeTo(cur[m.id].pos, m.to));
      if (path.length) { walkers.push({ id: m.id, path, to: m.to, chat: "chat" in m ? m.chat : undefined }); continue; }
    }
    if ("chat" in m) cur[m.id].chat = m.chat;
  }
  const maxLen = walkers.reduce((a, w) => Math.max(a, w.path.length), 0);
  for (let t = 0; t < maxLen; t++) {
    for (const w of walkers) { const p = w.path[Math.min(t, w.path.length - 1)]; cur[w.id].pos = [p[0], p[1]]; }
    steps.push(snapshot());
  }
  for (const w of walkers) { cur[w.id].pos = [w.to[0], w.to[1]]; if (w.chat !== undefined) cur[w.id].chat = w.chat; }
  for (let i = 0; i < read; i++) steps.push(snapshot());
}

// in-place beat (no walking): set pron/desc/chat, dwell `read` steps
function say(updates, read = READ) {
  for (const id of AGENT_IDS) cur[id].chat = null;
  for (const up of updates) {
    if ("pron" in up) cur[up.id].pron = up.pron;
    if ("desc" in up) cur[up.id].desc = up.desc;
    if ("mode" in up) cur[up.id].mode = up.mode;
    if ("chat" in up) cur[up.id].chat = up.chat;
    if (up.pos) cur[up.id].pos = [...up.pos];
  }
  for (let i = 0; i < read; i++) steps.push(snapshot());
}

const roomOf = (s) => rooms[s] || rooms.orchestrator_hub;
const agentOf = (s) => phases[s]?.agent;
const D = (id) => agents[id].display;
const home = (id) => agents[id].home;

// Which downstream phase (if any) consumes this artifact as an input — from pipeline.dag.json.
// Returns the earliest downstream phase whose agent differs from the producer, else null (archive).
const flow = world.flow;
function consumerOf(stage, artifact) {
  const idx = flow.indexOf(stage), prod = phases[stage]?.agent;
  const toks = artifact.split(/[ +,]+/).filter(Boolean).map((t) => t.replace(/\/+$/, ""));
  for (let i = idx + 1; i < flow.length; i++) {
    const q = flow[i];
    if (phases[q]?.agent === prod) continue;
    for (const inp of (dag.nodes[q]?.inputs || [])) {
      const t = inp.replace(/\/+$/, "");
      if (toks.some((a) => a.includes(t) || t.includes(a))) return q;
    }
  }
  return null;
}

// --- interpret the event stream --------------------------------------------
let failOpen = false;
const archiveDrops = [];   // step indices at which an unused artifact lands in the Archive

// honest, computed run summary (feeds the Metrics HUD; missing telemetry stays null = "N/A")
const sum = { stages: 0, fired: 0, skipped: 0, rework: 0, circuit: 0, guardrail: 0, incidents: 0 };
const mandatoryGates = new Set();   // distinct cp_NN ids with type === "mandatory" (always human gates)
let incOpenedAt = null, incFixAt = null, optimizerInfo = null;
const STAGE_MODE = { qa_generate: "GEN", qa_validate: "VALIDATE", review: "REVIEW" };

for (const ev of events) {
  switch (ev.event) {
    case "workspace_init":
      say([{ id: "orchestrator", pron: emoji.route, desc: `Workspace ready @ ${rooms.orchestrator_hub.label}` }], READ_SHORT);
      break;

    case "stage_started": {
      const ph = phases[ev.stage]; if (!ph) break;
      const aid = ph.agent, room = roomOf(ev.stage);
      walkScene([
        { id: aid, to: room.anchor, pron: ph.pronunciatio, desc: `${ph.action} @ ${room.label}`, mode: STAGE_MODE[ev.stage] || null },
        { id: "orchestrator", pron: emoji.route, desc: `Routed work to ${room.label} @ ${rooms.orchestrator_hub.label}` },
      ], READ);
      break;
    }

    case "lint_fail": {
      const aid = agentOf(ev.stage) || "developer_agent";
      say([{ id: aid, pron: emoji.fix, desc: `Fixing lint: ${ev.file || "src"} @ ${roomOf(ev.stage).label}` }], READ_SHORT);
      break;
    }

    case "quality_gate_fail": {
      const aid = agentOf(ev.stage) || "developer_agent"; failOpen = true;
      say([{ id: aid, pron: emoji.fail, desc: `Test FAILING: ${ev.feature_id || ""} @ ${roomOf(ev.stage).label}`,
             chat: [["Quality Gate", `re-ran ${ev.test_command || "tests"} -> exit ${ev.live_exit_code ?? 1}`]] }], READ);
      say([{ id: aid, pron: emoji.fix, mode: "DEBUG", desc: `Debugging (RUFV loop): ${ev.feature_id || ""} @ ${roomOf(ev.stage).label}` }], READ);
      break;
    }

    case "quality_gate_pass": {
      const aid = agentOf(ev.stage) || "developer_agent";
      const chat = failOpen ? [["Quality Gate", "live re-run passed -> feature flips passes:true"]] : undefined;
      say([{ id: aid, pron: emoji.pass, mode: null, desc: `Tests GREEN: ${ev.feature_id || ""} @ ${roomOf(ev.stage).label}`, ...(chat ? { chat } : {}) }], failOpen ? READ_SHORT : READ);
      failOpen = false;
      break;
    }

    case "checkpoint": {
      // v2 contract: id|checkpoint_id (cp_NN), gate (Gn), type (mandatory|conditional),
      // outcome|verdict (approved|approved_with_comments|rework_required|skipped), triggered_by[] | note.
      const id = ev.id || ev.checkpoint_id || "checkpoint";
      if (ev.type === "mandatory") mandatoryGates.add(id);
      const verdict = ev.outcome || ev.verdict || "approved";
      const triggers = ev.triggered_by || (ev.note ? [ev.note] : []);
      const label = ev.gate ? `${id}/${ev.gate}` : id;
      const gate = rooms.checkpoint_gate;

      if (verdict === "skipped") {
        sum.skipped++;
        say([{ id: "orchestrator", pron: emoji.skip,
               desc: `${id} auto-skipped (${ev.type || "conditional"}) @ ${rooms.orchestrator_hub.label}`,
               chat: ev.note ? [["Orchestrator", `${id} skipped — ${ev.note}`]] : null }], READ_SHORT);
        break;
      }

      if (verdict === "pending" || verdict === "awaiting_human") {
        // run paused AT a (usually mandatory) gate awaiting a human decision — no sign-off, no advance.
        sum.fired++;
        const aidP = agentOf(ev.stage);
        const whyP = ev.type === "mandatory" ? "mandatory human gate" : `fired: ${triggers.join("; ") || "trigger"}`;
        const movesP = [
          { id: "human_lead", to: [gate.anchor[0] + 2, gate.anchor[1]], pron: emoji.gate_wait,
            desc: `Reviewing ${label} — awaiting decision @ ${gate.label}`,
            chat: [["Orchestrator", `${label} (${whyP})`], ["Human Lead", "Pending — promotion paused for human sign-off"]] },
          { id: "orchestrator", pron: emoji.gate_wait,
            desc: `${ev.type === "mandatory" ? "MANDATORY" : "Conditional"} checkpoint ${id} — PAUSED, awaiting human @ ${rooms.orchestrator_hub.label}` },
        ];
        if (aidP) movesP.unshift({ id: aidP, to: gate.anchor, pron: emoji.gate_wait, desc: `Awaiting ${label} sign-off @ ${gate.label}` });
        walkScene(movesP, READ_LONG);
        // hold the paused tableau — the run does not advance and emits no run_completed
        say([{ id: "human_lead", pron: emoji.gate_wait, desc: `${label}: awaiting human sign-off @ ${gate.label}` }], READ_LONG);
        break;
      }
      sum.fired++;

      const aid = agentOf(ev.stage);
      const prev = aid ? [...cur[aid].pos] : null;
      const why = ev.type === "mandatory" ? "mandatory human gate" : `fired: ${triggers.join("; ") || "trigger"}`;
      const rejected = verdict === "rework_required";
      const moves = [
        { id: "human_lead", to: [gate.anchor[0] + 2, gate.anchor[1]], pron: emoji.human_ok,
          desc: `Reviewing ${label} @ ${gate.label}`,
          chat: [["Orchestrator", `${label} (${why})`], ["Human Lead", rejected ? "Rework required" : "Approved"]] },
        { id: "orchestrator", pron: emoji.gate_wait,
          desc: `${ev.type === "mandatory" ? "MANDATORY" : "Conditional"} checkpoint ${id} @ ${rooms.orchestrator_hub.label}` },
      ];
      if (aid) moves.unshift({ id: aid, to: gate.anchor, pron: emoji.gate_wait, desc: `Awaiting ${label} sign-off @ ${gate.label}` });
      walkScene(moves, READ_LONG);

      if (rejected) {
        sum.rework++;
        // RAINY DAY — human rejects: agent returns to its room to rework, run does not advance here
        say([
          { id: "human_lead", pron: emoji.fail, desc: `${label}: rework required @ ${gate.label}` },
          ...(aid ? [{ id: aid, pron: emoji.fix, desc: `Reworking after ${label} @ ${gate.label}` }] : []),
        ], READ_SHORT);
        const back = [{ id: "human_lead", to: home("human_lead"), pron: emoji.idle, desc: `Idle @ Bullpen` }];
        if (aid) back.push({ id: aid, to: prev, pron: emoji.fix,
                             desc: roomContaining(prev) ? `Reworking ${ev.stage} @ ${roomOf(ev.stage).label}` : `Reworking @ Bullpen` });
        walkScene(back, 1);
      } else {
        say([
          ...(aid ? [{ id: aid, pron: emoji.gate_open, desc: `${label} signed @ ${gate.label}` }] : []),
          { id: "human_lead", pron: emoji.pass, desc: `Signed ${label}${verdict === "approved_with_comments" ? " (w/ comments)" : ""} @ ${gate.label}` },
        ], READ_SHORT);
        const inRoom = roomContaining(prev) && phases[ev.stage];
        const back = [{ id: "human_lead", to: home("human_lead"), pron: emoji.idle, desc: `Idle @ Bullpen` }];
        if (aid) back.push({ id: aid, to: prev, pron: inRoom ? phases[ev.stage].pronunciatio : emoji.idle,
                             desc: inRoom ? `${phases[ev.stage].action} @ ${roomOf(ev.stage).label}` : `Idle @ Bullpen` });
        walkScene(back, 1);
      }
      break;
    }

    case "artifact_written": {
      const aid = agentOf(ev.stage); if (!aid) break;
      const ph = phases[ev.stage];
      const back = { id: aid, to: roomOf(ev.stage).anchor, pron: ph.pronunciatio, desc: `${ph.action} @ ${roomOf(ev.stage).label}` };
      const consumer = consumerOf(ev.stage, ev.artifact);
      if (consumer) {
        // deliver to the consuming agent: walk over and ask them to use the file
        const cA = phases[consumer].agent;
        const dest = [cur[cA].pos[0] - 1, cur[cA].pos[1]];
        walkScene([{ id: aid, to: dest, pron: "📨", desc: `Delivering ${ev.artifact} to ${D(cA)}`,
                     chat: [[D(aid), `Please use ${ev.artifact}`]] }], READ_SHORT);
        walkScene([back], 1);
      } else {
        // unused downstream: file it in the Archive and leave it there
        walkScene([{ id: aid, to: rooms.archive.anchor, pron: "🗄️", desc: `Archiving ${ev.artifact} @ ${rooms.archive.label}`,
                     chat: [[D(aid), `${ev.artifact} -> Archive (unused)`]] }], READ_SHORT);
        archiveDrops.push(steps.length);
        walkScene([back], 1);
      }
      break;
    }

    case "stage_completed": {
      const aid = agentOf(ev.stage); if (!aid) break;
      sum.stages++;
      say([{ id: aid, pron: emoji.pass, mode: null, desc: `${ev.stage} done -> handing off @ ${roomOf(ev.stage).label}`,
             chat: [[D(aid), `${ev.stage} complete`], ["Orchestrator", "received, advancing"]] }], READ_SHORT);
      if (!(aid === "qa_agent" && ev.stage === "qa_generate")) {
        walkScene([{ id: aid, to: home(aid), pron: emoji.idle, desc: `Idle @ Bullpen` }], 1);
      }
      break;
    }

    case "requirement_delta": {
      const diff = "diff_agent";
      walkScene([
        { id: diff, to: rooms.requirements.anchor, pron: "🧭", desc: `Tracing impact of ${ev.req_id || "REQ"} @ ${rooms.requirements.label}`,
          chat: [[D(diff), `${ev.req_id || "REQ"} changed (v${ev.from_version || 1}->v${ev.to_version || 2})${ev.note ? " — " + ev.note : ""}`]] },
        { id: "orchestrator", pron: emoji.route, desc: `Requirements delta — dispatched Diff Analyst @ ${rooms.orchestrator_hub.label}` },
      ], READ);
      for (const st of (ev.affected_stages || [])) {
        if (!rooms[st]) continue;
        walkScene([{ id: diff, to: rooms[st].anchor, pron: emoji.fix, desc: `Resetting ${st} (impacted) @ ${roomOf(st).label}` }], READ_SHORT);
      }
      walkScene([
        { id: diff, to: home(diff), pron: emoji.idle, desc: `Idle @ Bullpen`,
          chat: [[D(diff), `rerun_plan.json: rerun [${(ev.affected_stages || []).join(", ")}], skip the rest`]] },
        { id: "orchestrator", pron: emoji.route, desc: `Selective re-run scheduled @ ${rooms.orchestrator_hub.label}` },
      ], READ);
      break;
    }

    // --- v2 events (M5 contract sync) ----------------------------------------
    case "discovery_routed": {
      // Phase-0 (non-linear). product_agent in DISCOVERY mode frames the problem, or it's skipped.
      if (ev.ran) {
        const aid = "product_agent", room = rooms.discovery || rooms.requirements;
        walkScene([
          { id: aid, to: room.anchor, pron: "🧭", mode: "DISCOVERY", desc: `Discovery: framing the problem @ ${room.label}`,
            chat: [[D(aid), `discovery-brief.md (${ev.scope || "epic"})`]] },
          { id: "orchestrator", pron: emoji.route, desc: `Phase-0 discovery (${ev.scope || "epic"}) @ ${rooms.orchestrator_hub.label}` },
        ], READ);
        walkScene([{ id: aid, to: home(aid), pron: emoji.idle, mode: null, desc: `Idle @ Bullpen` }], 1);
      } else {
        say([{ id: "orchestrator", pron: emoji.skip, desc: `Discovery skipped @ ${rooms.orchestrator_hub.label}`,
               chat: [["Orchestrator", `discovery skipped — ${ev.reason || "ordinary task"} → requirements`]] }], READ_SHORT);
      }
      break;
    }

    case "change_triage": {
      const band = ev.band || "green";
      const dot = band === "red" ? "🔴" : band === "yellow" ? "🟡" : "🟢";
      say([{ id: "orchestrator", pron: dot, desc: `Change triage: ${band.toUpperCase()} @ ${rooms.orchestrator_hub.label}`,
             chat: [["Orchestrator", `triage ${band}${ev.review ? " → " + ev.review : ""}` +
                    `${(ev.reasons && ev.reasons.length) ? " (" + ev.reasons.join(", ") + ")" : ""}`]] }], READ_SHORT);
      break;
    }

    case "stage_skipped": {
      // selective re-run: a stage outside the rerun plan is skipped (supersedes per-stage requirement_delta)
      say([{ id: "orchestrator", pron: emoji.skip, desc: `Skipped ${ev.stage} @ ${rooms.orchestrator_hub.label}`,
             chat: [["Orchestrator", `${ev.stage} skipped — ${ev.reason || "not_in_rerun_plan"}`]] }], READ_SHORT);
      break;
    }

    case "circuit_breaker": {
      // RAINY DAY — a stage loops past max_attempts or breaches the token budget: halt + escalate.
      const aid = agentOf(ev.stage) || "developer_agent";
      sum.circuit++;
      say([
        { id: aid, pron: "⛔", mode: "DEBUG", desc: `Circuit breaker: ${ev.stage || "stage"} halted @ ${roomOf(ev.stage).label}`,
          chat: [[D(aid), `${ev.reason || "max_attempts_per_stage"} — attempts=${ev.attempts ?? "?"}` +
                 `${ev.budget ? `, tokens ${ev.tokens_so_far ?? "?"}/${ev.budget}` : ""}`]] },
        { id: "orchestrator", pron: emoji.gate_wait, desc: `${ev.action || "halt+escalate"} @ ${rooms.orchestrator_hub.label}` },
      ], READ);
      const gate = rooms.checkpoint_gate;
      walkScene([{ id: "human_lead", to: [gate.anchor[0] + 2, gate.anchor[1]], pron: "🆘",
                   desc: `Escalation: ${ev.stage || "stage"} circuit breaker @ ${gate.label}`,
                   chat: [["Orchestrator", `${ev.stage || "stage"}: ${ev.reason || "halted"} — human needed`]] }], READ_SHORT);
      walkScene([{ id: "human_lead", to: home("human_lead"), pron: emoji.idle, desc: `Idle @ Bullpen` }], 1);
      break;
    }

    case "guardrail_block": {
      // RAINY DAY — a hook blocks an anti-pattern (e.g. AP-105 editing an immutable generated test).
      let aid = ev.agent || agentOf(ev.stage) || "developer_agent";
      if (!cur[aid]) aid = "developer_agent";
      sum.guardrail++;
      say([{ id: aid, pron: "🚫", desc: `Guardrail blocked: ${ev.rule || "anti-pattern"} @ ${roomOf(ev.stage).label}`,
             chat: [["Hook", `${ev.rule || "AP"}: ${ev.detail || "change blocked"}`]] }], READ_SHORT);
      break;
    }

    case "incident_opened": {
      // operate loop (non-linear). devops_agent mitigates ROLLBACK-FIRST; orchestrator routes.
      const dev = "devops_agent", prod = rooms.production || rooms.deployment;
      const sev = ev.severity || "sev-3";
      sum.incidents++; incOpenedAt = ev.timestamp || ev.opened_at || incOpenedAt;
      walkScene([
        { id: dev, to: prod.anchor, pron: "🚨", mode: "MITIGATE", desc: `${ev.incident_id || "INC"} ${sev} — mitigating @ ${prod.label}`,
          chat: [[D(dev), `${ev.incident_id || "INC"} ${sev}: rollback-first`]] },
        { id: "orchestrator", pron: "🚨", desc: `Incident ${ev.incident_id || ""} opened (${sev}) @ ${rooms.orchestrator_hub.label}` },
      ], READ);
      say([{ id: dev, pron: "🔙", mode: "MITIGATE", desc: `Rolling back ${ev.incident_id || "INC"} @ ${prod.label}`,
             chat: [[D(dev), `reverted to last good — impact stopped`]] }], READ_SHORT);
      break;
    }

    case "incident_resolved": {
      const dev = "devops_agent", prod = rooms.production || rooms.deployment;
      incFixAt = ev.fix_deployed_at || ev.resolved_at || incFixAt;
      say([
        { id: dev, pron: emoji.pass, mode: null, desc: `${ev.incident_id || "INC"} resolved — fix deployed @ ${prod.label}`,
          chat: [[D(dev), `fix in prod${ev.pipeline_delivered != null ? ` (pipeline_delivered=${ev.pipeline_delivered})` : ""}`]] },
        { id: "orchestrator", pron: emoji.pass, desc: `Incident ${ev.incident_id || ""} closed @ ${rooms.orchestrator_hub.label}` },
      ], READ_SHORT);
      walkScene([{ id: dev, to: home(dev), pron: emoji.idle, desc: `Idle @ Bullpen` }], 1);
      break;
    }

    case "optimizer_decision": {
      // M10 — OPTIONAL self-optimizer epilogue (only present when optimizer.enabled). Quality is a hard veto.
      const v = (ev.decision || "hold").toLowerCase();   // keep | rollback | hold
      const dot = v === "keep" ? "📉" : v === "rollback" ? "↩️" : "⏸️";
      optimizerInfo = { decision: v, experiment: ev.experiment || null, reason: ev.reason || null };
      say([{ id: "orchestrator", pron: dot, desc: `Optimizer: ${v.toUpperCase()} @ ${rooms.orchestrator_hub.label}`,
             chat: [["Optimizer", `${ev.experiment || "experiment"} → ${v}${ev.reason ? " — " + ev.reason : ""}`]] }], READ);
      break;
    }

    case "run_completed":
      walkScene([
        { id: "devops_agent", to: rooms.deployment.anchor, pron: "🚀", desc: `Deployed to production @ ${rooms.deployment.label}` },
        { id: "orchestrator", pron: emoji.pass, desc: `Run ${RUN} complete — ${ev.outcome} @ ${rooms.orchestrator_hub.label}` },
      ], READ_LONG);
      break;
  }
}

if (steps.length === 0) { console.error("No steps produced — empty/invalid event log."); process.exit(1); }

// --- serialise -------------------------------------------------------------
const master = {};
steps.forEach((frame, i) => { master[String(i)] = frame; });

const startDate = (state.started_at || "2026-06-25T09:00:00Z").slice(0, 10);
const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const [Y, M] = startDate.split("-").map(Number);
const Dd = Number(startDate.split("-")[2]);
// computed, honest run summary for the Metrics HUD (null = "N/A — no data", never fabricated)
const gateTotal = sum.fired + sum.skipped;
let mttrMin = null;
if (incOpenedAt && incFixAt) {
  const d = (Date.parse(incFixAt) - Date.parse(incOpenedAt)) / 60000;
  if (Number.isFinite(d) && d >= 0) mttrMin = Math.round(d);
}
const summary = {
  stages_completed: sum.stages,
  checkpoints_fired: sum.fired,
  checkpoints_skipped: sum.skipped,
  autonomy_rate_pct: gateTotal ? Math.round((sum.skipped / gateTotal) * 100) : null,
  // Clean-run (steady-state) autonomy — the pipeline's happy-path figure, sourced from the run's
  // criterion_tracking, NOT the heavily-gated computed rate above. null => "N/A".
  clean_run_autonomy_pct: (state.criterion_tracking && state.criterion_tracking.autonomy_rate_pct != null)
    ? state.criterion_tracking.autonomy_rate_pct : null,
  mandatory_gates: mandatoryGates.size,
  gate_rejections: sum.rework,
  circuit_breaker_trips: sum.circuit,
  guardrail_blocks: sum.guardrail,
  incidents: sum.incidents,
  mttr_min: mttrMin,
  tokens: null,            // N/A — fixtures carry no token telemetry
  cost_usd: null,          // N/A — no pricing/telemetry
  optimizer: optimizerInfo,
};

const meta = {
  run_id: RUN, start_date: `${months[M - 1]} ${Dd}, ${Y}`, sec_per_step: 10,
  maze_name: world.map.name, persona_names: AGENT_IDS.map((id) => agents[id].display), step: steps.length,
  archive_drops: archiveDrops, summary,
};

writeFileSync(join(runDir, "master_movement.json"), JSON.stringify(master));
writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
console.log(`OK  run=${RUN}  steps=${steps.length}  personas=${AGENT_IDS.length}`);
