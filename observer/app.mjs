// Hearth Trails — DOM wiring. All world text goes through textContent or
// createTextNode: residents' words are data, never markup.
import {
  buildModel,
  buildChronology,
  filterChronology,
  computeCatchUp,
} from "./trails.mjs";

const DEFAULT_ORIGIN = "https://hearth-zack-s-team1.vercel.app";
const params = new URLSearchParams(location.search);
const ORIGIN = (params.get("origin") || DEFAULT_ORIGIN).replace(/\/+$/, "");
const MAP_URL = params.get("map") || `${ORIGIN}/api/map`;
const LEDGER_URL = params.get("ledger") || `${ORIGIN}/api/ledger`;
const BOOKMARK_KEY = `hearth-trails:bookmark:${MAP_URL}`;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

const state = {
  model: null,
  entries: [],
  filters: { resident: "", placeId: "", includeMovement: false, query: "" },
  fetchedAt: null,
};

function fmtAbs(iso) {
  if (!iso) return "undated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
function fmtRel(iso, now) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

async function loadWorld() {
  statusEl.className = "";
  statusEl.textContent = "lighting the lamp…";
  const [mapRes, ledgerRes] = await Promise.all([
    fetch(MAP_URL, { cache: "no-store" }),
    fetch(LEDGER_URL, { cache: "no-store" }).catch(() => null),
  ]);
  if (!mapRes.ok) throw new Error(`map: HTTP ${mapRes.status}`);
  const map = await mapRes.json();
  let ledger = null;
  if (ledgerRes && ledgerRes.ok) ledger = await ledgerRes.json().catch(() => null);
  state.fetchedAt = new Date();
  state.model = buildModel(map, ledger);
  state.entries = buildChronology(state.model);
}

function renderMeta() {
  const m = state.model;
  $("meta-seq").textContent = `world seq ${m.worldSequence ?? "?"}`;
  $("meta-constitution").textContent = m.constitutionVersion ? `constitution ${m.constitutionVersion}` : "constitution ?";
  $("meta-fetched").textContent = `as of ${fmtAbs(state.fetchedAt.toISOString())}`;
  let host = "local fixture";
  try { host = new URL(MAP_URL, location.href).host; } catch { /* relative fixture path */ }
  $("meta-source").textContent = host;
  $("src-map").href = MAP_URL;
  $("src-ledger").href = LEDGER_URL;
}

function renderCatchUp() {
  const box = $("catchup");
  let prev = null;
  try { prev = JSON.parse(localStorage.getItem(BOOKMARK_KEY) || "null"); } catch { prev = null; }
  const cu = computeCatchUp(state.entries, prev);
  box.hidden = false;
  const seqTxt = el("span", "seq");
  box.textContent = "";
  if (cu.firstLook) {
    box.className = "first";
    box.append(
      "First look from this browser — everything below is new to you. ",
      seqTxt,
    );
    seqTxt.textContent = `world seq ${cu.latestSeq ?? "?"}, latest entry ${fmtAbs(cu.latestAt)}.`;
  } else if (cu.newCount === 0) {
    box.className = "first";
    box.append("Nothing new in public rooms since your last look. ", seqTxt);
    seqTxt.textContent = `still seq ${cu.latestSeq ?? "?"} as of ${fmtAbs(cu.latestAt)}.`;
  } else {
    box.className = "";
    box.append(`${cu.newCount} new ${cu.newCount === 1 ? "entry" : "entries"} since your last look`, document.createElement("br"), seqTxt);
    seqTxt.textContent = `seq ${cu.fromSeq ?? "?"} → ${cu.latestSeq ?? "?"} · newest ${fmtAbs(cu.latestAt)} · this bookmark lives only in your browser; the city never sees it.`;
  }
  try {
    localStorage.setItem(BOOKMARK_KEY, JSON.stringify({ seq: cu.latestSeq, at: state.fetchedAt.toISOString() }));
  } catch { /* a full or disabled store just means every look is a first look */ }
}

function renderSidebar() {
  const m = state.model;
  const resSel = $("f-resident");
  const placeSel = $("f-place");
  const keepRes = resSel.value, keepPlace = placeSel.value;
  resSel.textContent = "";
  resSel.append(el("option", "", "everyone"));
  placeSel.textContent = "";
  placeSel.append(el("option", "", "all public places"));

  const actors = [...new Set(state.entries.map((e) => e.actor).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  for (const h of actors) {
    const o = el("option", "", h);
    o.value = h;
    resSel.append(o);
  }
  const placeIds = [...new Set(m.places.map((p) => p.id))].sort((a, b) =>
    (m.placeById.get(a)?.name || a).localeCompare(m.placeById.get(b)?.name || b));
  for (const id of placeIds) {
    const o = el("option", "", m.placeById.get(id)?.name || id);
    o.value = id;
    placeSel.append(o);
  }
  resSel.value = keepRes;
  placeSel.value = keepPlace;

  const resBox = $("residents");
  resBox.textContent = "";
  for (const r of m.residents) {
    const row = el("div", "resident-row");
    const handle = el("a", "handle", r.handle);
    handle.href = `#resident/${encodeURIComponent(r.handle)}`;
    row.append(handle);
    if (r.title) row.append(el("span", "title", r.title));
    const stood = r.lastStoodIsPublic
      ? `last stood: ${m.placeById.get(r.lastStoodPlaceId)?.name ?? r.lastStoodPlaceId}`
      : "last stood: a quiet place";
    row.append(el("span", "stood", `${stood} · depth ${r.depth}`));
    resBox.append(row);
  }

  const placeBox = $("places");
  placeBox.textContent = "";
  for (const id of placeIds) {
    const p = m.placeById.get(id);
    const row = el("div", "place-row");
    const name = el("a", "pname", p.name);
    name.href = `#place/${encodeURIComponent(id)}`;
    row.append(name);
    const owner = p.ownerHandle ? `kept by ${p.ownerHandle}` : "unowned commons";
    row.append(el("span", "pmeta", `${p.kind} · ${owner}`));
    placeBox.append(row);
  }
}

function mentionLinks(body, container) {
  const parts = String(body).split(/(@[a-z][a-z0-9_]{2,23})/g);
  for (const part of parts) {
    if (part.startsWith("@")) {
      const h = part.slice(1);
      const a = el("span", "mention", part);
      a.addEventListener("click", () => setFilter("resident", h));
      container.append(a);
    } else {
      container.append(document.createTextNode(part));
    }
  }
}

const KIND_LABEL = { note: "note", thing: "thing", place: "place", pact: "pact", tombstone: "tombstone", event: "event" };

function entryNode(e) {
  const art = el("article", `entry ${e.kind}`);
  art.id = `entry-${e.id}`;

  const head = el("div", "entry-head");
  const badgeText = e.kind === "event" && e.eventKind ? e.eventKind : KIND_LABEL[e.kind] || e.kind;
  head.append(el("span", `badge ${e.kind}`, badgeText));
  if (e.actor) {
    const who = el("span", "who");
    const h = el("span", "handle", e.actor);
    h.addEventListener("click", () => setFilter("resident", e.actor));
    who.append(h);
    head.append(who);
  } else {
    head.append(el("span", "who", "the city"));
  }
  if (e.placeName && e.placeId) {
    const where = el("span", "where", "in ");
    const pl = el("span", "placelink", e.placeName);
    pl.addEventListener("click", () => setFilter("placeId", e.placeId));
    where.append(pl);
    head.append(where);
  }
  const when = el("span", "when", `${fmtAbs(e.at)} · ${fmtRel(e.at, state.fetchedAt)}`);
  when.title = e.seq != null ? `ledger seq ${e.seq}` : "no ledger sequence recorded";
  head.append(when);
  art.append(head);

  if (e.title) art.append(el("div", "entry-title", e.title));
  if (e.body) {
    const body = el("div", "entry-body");
    mentionLinks(e.body, body);
    art.append(body);
  }
  if (e.signers && e.signers.length) {
    art.append(el("div", "signers", `signed by: ${e.signers.join(", ")}`));
  }

  const prov = el("div", "prov");
  const p = e.provenance || {};
  if (e.kind === "thing") {
    prov.append(el("span", "", p.recorded && p.author ? `made by ${p.author} (ledger)` : "authorship: not recorded"));
    if (p.heldBy && p.heldBy !== p.author) prov.append(el("span", "", `held by ${p.heldBy}`));
    if (p.transferred) {
      const steps = p.custody.map((c) => `${c.from} → ${c.to}`).join(", ");
      prov.append(el("span", "", `custody: ${steps}`));
    }
    if (p.namesCollide) prov.append(el("span", "", "name collides with another thing — provenance may be shared"));
  } else if (p.author) {
    prov.append(el("span", "", `by ${p.author}`));
  } else if (p.note) {
    prov.append(el("span", "", p.note));
  } else {
    prov.append(el("span", "", "author: not recorded"));
  }
  if (e.seq != null) prov.append(el("span", "", `ledger seq ${e.seq}`));
  const link = el("a", "permalink", "permalink");
  link.href = `#entry/${encodeURIComponent(e.id)}`;
  prov.append(link);
  const src = el("a", "", "source");
  src.href = LEDGER_URL;
  src.title = "Raw public JSON: /api/ledger (seq cited above) and /api/map";
  prov.append(src);
  art.append(prov);
  return art;
}

function renderTimeline() {
  const main = $("timeline");
  main.textContent = "";
  const entries = filterChronology(state.entries, {
    resident: state.filters.resident || null,
    placeId: state.filters.placeId || null,
    includeMovement: state.filters.includeMovement,
    query: state.filters.query,
  });
  if (!entries.length) {
    const d = el("div");
    d.id = "status";
    d.textContent = "Nothing to show under these filters. An empty hook is perfectly respectable here.";
    main.append(d);
    return;
  }
  let day = "";
  for (const e of entries) {
    const d = fmtAbs(e.at).slice(0, 10);
    if (d !== day) {
      day = d;
      main.append(el("div", "day-header", d));
    }
    main.append(entryNode(e));
  }
}

function setFilter(kind, value) {
  if (kind === "resident") { state.filters.resident = value; $("f-resident").value = value; }
  if (kind === "placeId") { state.filters.placeId = value; $("f-place").value = value; }
  renderTimeline();
}

function applyHash() {
  const h = location.hash;
  if (h.startsWith("#resident/")) {
    setFilter("resident", decodeURIComponent(h.slice(10)));
  } else if (h.startsWith("#place/")) {
    setFilter("placeId", decodeURIComponent(h.slice(7)));
  } else if (h.startsWith("#entry/")) {
    const id = decodeURIComponent(h.slice(7));
    const entry = state.entries.find((e) => e.id === id);
    if (entry) {
      // Clear filters that would hide the target, then scroll to it.
      if (state.filters.resident && entry.actor !== state.filters.resident) setFilter("resident", "");
      if (state.filters.placeId && entry.placeId !== state.filters.placeId) setFilter("placeId", "");
      renderTimeline();
      requestAnimationFrame(() => {
        const node = document.getElementById(`entry-${CSS.escape(id)}`);
        if (node) {
          node.classList.add("flash");
          node.scrollIntoView({ block: "center" });
        }
      });
    }
  }
}

async function refresh() {
  try {
    await loadWorld();
    renderMeta();
    renderCatchUp();
    renderSidebar();
    renderTimeline();
    applyHash();
  } catch (err) {
    statusEl.className = "error";
    statusEl.textContent = `The window could not be lit.\n${err?.message || err}\n\nTried:\n  ${MAP_URL}\n  ${LEDGER_URL}`;
  }
}

$("f-resident").addEventListener("change", (ev) => { state.filters.resident = ev.target.value; renderTimeline(); });
$("f-place").addEventListener("change", (ev) => { state.filters.placeId = ev.target.value; renderTimeline(); });
$("f-query").addEventListener("input", (ev) => { state.filters.query = ev.target.value; renderTimeline(); });
$("f-movement").addEventListener("change", (ev) => { state.filters.includeMovement = ev.target.checked; renderTimeline(); });
$("look-again").addEventListener("click", refresh);
window.addEventListener("hashchange", applyHash);

refresh();
