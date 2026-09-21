// Hearth Trails — read-only observer logic.
//
// Public-reading contract (the observer side of the city's constitution):
//   1. Only publicly observable places contribute content. A place is
//      observable when permissions.observe === "public". The kernel's may()
//      falls back to "closed" when the key is absent; so do we.
//   2. Owner-only and closed places contribute nothing: no notes, no things,
//      no events, not even activity hints. Enclaves are owner-only by seed.
//   3. Private memory is never touched. This module only accepts the public
//      /api/map and /api/ledger documents; there is no memory surface in them
//      and none is synthesized.
//   4. Destroyed resources are already absent from the map. Their destroy
//      events remain in the public ledger and are shown as tombstones:
//      kind and id only, never recovered content.
//   5. Ownership is not authorship, and a transfer is not authorship either.
//      Things record an owner, not an author. Authorship is claimed only
//      from unambiguous public make evidence (a single make event naming the
//      thing, with no live name collision). A first public giver is not a
//      maker. Ambiguous or missing evidence is marked "not recorded", and
//      an unrecorded object never enters an author lane under its holder.
//   6. A stored location is not presence. standingId is rendered as
//      "last stood", only when that place is itself publicly observable.
//   7. Nothing here ranks residents. Depth is displayed as a footnote,
//      residents are listed alphabetically, and there is no attendance
//      or activity count per resident.
//   8. Ledger citations are honest about their strength. A kernel-provided
//      note.seq is exact. An actor/place/time-inferred note pairing is an
//      estimated association and is labeled as such; an ambiguous pairing
//      cites no sequence at all. Direct ledger events keep exact seqs.

export const MOVEMENT_KINDS = new Set(["walk", "look", "home"]);

// Kinds that describe an act with no separate world object; they always
// appear as event entries (when their place is observable).
const EVENT_ONLY_KINDS = new Set([
  "founding", "join", "destroy", "give", "become", "permit", "law",
  "sign", "use", "pin", "unpin", "perform", "agree",
]);

const ABSORB_WINDOW_MS = 5000;

export function isObservablePlace(place) {
  if (!place || place.destroyedAt) return false;
  const perms = place.permissions || {};
  return perms.observe === "public";
}

function chronological(events) {
  // /api/map and world.events are newest-first; /api/ledger is chronological.
  const list = (events || []).slice();
  if (list.length >= 2) {
    const a = list[0], b = list[list.length - 1];
    const seqA = a.seq ?? 0, seqB = b.seq ?? 0;
    if (seqA > seqB || (seqA === seqB && String(a.createdAt) > String(b.createdAt))) list.reverse();
  }
  return list;
}

function byTimeThenSeq(a, b) {
  const t = String(a.at).localeCompare(String(b.at));
  if (t !== 0) return t;
  return (a.seq ?? 0) - (b.seq ?? 0);
}

// Parse "<actor> made <name>." / "<actor> founded <name>." / "<actor> gave
// <name> to <to>." out of ledger event text. Event text is kernel-generated
// and stable; if the kernel ever changes it we degrade to "unknown", which
// is the honest answer anyway.
function parseNameAct(text, verb) {
  if (typeof text !== "string") return null;
  const re = new RegExp(`^(\\S+) ${verb} (.+)\\.$`);
  const m = text.match(re);
  return m ? { actor: m[1], name: m[2] } : null;
}
function parseGive(text) {
  if (typeof text !== "string") return null;
  const m = text.match(/^(\S+) gave (.+) to (\S+)\.$/);
  return m ? { from: m[1], name: m[2], to: m[3] } : null;
}

export function buildModel(map, ledger) {
  if (!map || typeof map !== "object") throw new Error("buildModel needs a /api/map document");
  const placeById = new Map();
  for (const p of map.places || []) placeById.set(p.id, p);
  const observable = new Set();
  for (const p of map.places || []) if (isObservablePlace(p)) observable.add(p.id);

  const allEvents = chronological(ledger?.events ?? map.events ?? []);
  // Events in non-public places are dropped entirely. The ledger is a public
  // document, but the observer chooses not to render activity hints for
  // places a bystander could not look into.
  const events = allEvents.filter((e) => !e.placeId || observable.has(e.placeId));

  const notes = (map.notes || []).filter((n) => observable.has(n.placeId) && !n.destroyedAt);
  const things = (map.things || []).filter((t) => observable.has(t.placeId) && !t.destroyedAt);
  const places = (map.places || []).filter((p) => observable.has(p.id));
  const agreements = (map.agreements || []).slice(); // pacts are city-level public record

  const residents = (map.residents || []).map((r) => {
    const stood = r.standingId && observable.has(r.standingId) ? r.standingId : null;
    return {
      handle: r.handle,
      title: r.title || null,
      depth: r.depth ?? 0,
      createdAt: r.createdAt || null,
      lastStoodPlaceId: stood,
      lastStoodIsPublic: Boolean(stood),
    };
  }).sort((a, b) => a.handle.localeCompare(b.handle));

  return {
    worldSequence: map.world_sequence ?? ledger?.world_sequence ?? null,
    ledgerHead: map.ledger_head ?? ledger?.head_hash ?? null,
    constitutionVersion: map.constitutionVersion ?? null,
    placeById,
    observable,
    events,
    notes,
    things,
    places,
    agreements,
    residents,
  };
}

// Attach ledger sequence numbers to world objects and derive provenance.
//
// Citation discipline:
//   - A kernel-provided note.seq (post-phase cb41654 worlds) is exact.
//   - A note↔say pairing inferred from actor+place+time is an ESTIMATED
//     association: it is labeled as such, and omitted entirely when the
//     pairing is ambiguous (a tie). Resolution below is deterministic and
//     independent of input array order.
//   - A make event names its thing in kernel-generated text, but only by
//     NAME. Unique-name makes are unambiguous evidence and may claim an
//     exact creator and creation seq. Any live name collision, or a
//     missing make, means authorship is not recorded.
//   - A give establishes a transfer, never a maker. The first public giver
//     is not proof of origin.

function pairSayEvents(model) {
  // Group notes and say events by actor|place, then resolve pairings in a
  // deterministic three-pass process. Returns noteSeq Map(id -> citation)
  // and the say events no surviving note could claim (tombstones).
  const groupKey = (actor, placeId) => `${actor}|${placeId}`;
  const noteGroups = new Map();
  for (const n of model.notes) {
    const key = groupKey(n.authorHandle, n.placeId);
    if (!noteGroups.has(key)) noteGroups.set(key, []);
    noteGroups.get(key).push(n);
  }
  const sayGroups = new Map();
  for (const e of model.events) {
    if (e.kind !== "say") continue;
    const key = groupKey(e.actorHandle, e.placeId);
    if (!sayGroups.has(key)) sayGroups.set(key, []);
    sayGroups.get(key).push(e);
  }

  const noteSeq = new Map();
  const consumed = new Set();
  const within = (a, b) => Math.abs(new Date(a.createdAt) - new Date(b.createdAt)) <= ABSORB_WINDOW_MS;

  for (const [key, notes] of noteGroups) {
    const sorted = notes.slice().sort((a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    const events = (sayGroups.get(key) || []).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    // Pass 0: kernel-provided seqs are exact; consume the matching event.
    for (const n of sorted) {
      if (typeof n.seq !== "number") continue;
      noteSeq.set(n.id, { seq: n.seq, estimated: false, ambiguous: false });
      const hit = events.find((e) => e.seq === n.seq && !consumed.has(e));
      if (hit) consumed.add(hit);
    }

    // Pass 1: mutually unambiguous pairs — a note with exactly one candidate
    // event whose only candidate note is that note — are estimated matches.
    let progress = true;
    while (progress) {
      progress = false;
      for (const n of sorted) {
        if (noteSeq.has(n.id)) continue;
        const candidates = events.filter((e) => !consumed.has(e) && within(e, n));
        if (candidates.length !== 1) continue;
        const ev = candidates[0];
        const rivalNotes = sorted.filter((m) => !noteSeq.has(m.id) && within(ev, m));
        if (rivalNotes.length !== 1) continue;
        noteSeq.set(n.id, { seq: ev.seq ?? null, estimated: true, ambiguous: false });
        consumed.add(ev);
        progress = true;
      }
    }

    // Pass 2: anything left with candidates is ambiguous — cite nothing, but
    // still consume one event per surviving note (nearest, then lowest seq)
    // so a present note's say is never rendered as a tombstone.
    for (const n of sorted) {
      if (noteSeq.has(n.id)) continue;
      const candidates = events.filter((e) => !consumed.has(e) && within(e, n));
      noteSeq.set(n.id, {
        seq: null,
        estimated: true,
        ambiguous: candidates.length > 0,
        candidates: candidates.map((e) => e.seq ?? null),
      });
      if (candidates.length) {
        candidates.sort((a, b) =>
          (Math.abs(new Date(a.createdAt) - new Date(n.createdAt)) - Math.abs(new Date(b.createdAt) - new Date(n.createdAt)))
          || ((a.seq ?? 0) - (b.seq ?? 0)));
        consumed.add(candidates[0]);
      }
    }
  }

  const unmatchedSay = model.events.filter((e) => e.kind === "say" && !consumed.has(e));
  return { noteSeq, unmatchedSay };
}

function linkEvents(model) {
  const { noteSeq, unmatchedSay } = pairSayEvents(model);

  const makesByName = new Map(); // name -> [events]
  const foundsByName = new Map();
  const givesByName = new Map();
  for (const e of model.events) {
    if (e.kind === "make") {
      const p = parseNameAct(e.text, "made");
      if (p) {
        if (!makesByName.has(p.name)) makesByName.set(p.name, []);
        makesByName.get(p.name).push(e);
      }
    } else if (e.kind === "found") {
      const p = parseNameAct(e.text, "founded");
      if (p) {
        if (!foundsByName.has(p.name)) foundsByName.set(p.name, []);
        foundsByName.get(p.name).push(e);
      }
    } else if (e.kind === "give") {
      const p = parseGive(e.text);
      if (p) {
        if (!givesByName.has(p.name)) givesByName.set(p.name, []);
        givesByName.get(p.name).push({ ...p, seq: e.seq, at: e.createdAt, eventId: e.id, placeId: e.placeId });
      }
    }
  }

  const thingInfo = new Map();
  for (const t of model.things) {
    const namesCollide = model.things.some((x) => x.id !== t.id && x.name === t.name);
    let madeBy = null;
    let makeSeq = null;
    let custody = [];
    let custodyUncertain = false;
    if (namesCollide) {
      // The ledger names things, never their ids: with a live collision no
      // make or give can be pinned to this object. A give lands a thing in
      // the recipient's standing place, so same-place gives are kept as
      // separately-labeled uncertain evidence — never merged into one chain.
      custody = (givesByName.get(t.name) || []).filter((g) => g.placeId === t.placeId);
      custodyUncertain = custody.length > 0;
    } else {
      const makes = makesByName.get(t.name) || [];
      if (makes.length === 1) {
        madeBy = makes[0].actorHandle ?? null;
        makeSeq = makes[0].seq ?? null;
      }
      custody = givesByName.get(t.name) || [];
    }
    thingInfo.set(t.id, {
      heldBy: t.ownerHandle,
      madeBy,
      authorRecorded: madeBy != null,
      transferred: custody.length > 0,
      custody,
      custodyUncertain,
      makeSeq,
      namesCollide,
    });
  }

  const placeSeq = new Map();
  const placeNameCounts = new Map();
  for (const p of model.places) placeNameCounts.set(p.name, (placeNameCounts.get(p.name) || 0) + 1);
  for (const p of model.places) {
    if (placeNameCounts.get(p.name) !== 1) continue;
    const founds = foundsByName.get(p.name) || [];
    if (founds.length === 1) placeSeq.set(p.id, founds[0].seq ?? null);
  }

  return { noteSeq, unmatchedSay, thingInfo, placeSeq };
}

export function buildChronology(model, linked = linkEvents(model)) {
  const entries = [];
  const placeName = (id) => model.placeById.get(id)?.name ?? id;

  for (const n of model.notes) {
    const cite = linked.noteSeq.get(n.id) ?? { seq: null, estimated: false, ambiguous: false };
    entries.push({
      kind: "note",
      id: n.id,
      at: n.createdAt,
      actor: n.authorHandle,
      placeId: n.placeId,
      placeName: placeName(n.placeId),
      title: null,
      body: n.body,
      seq: cite.seq,
      seqEstimated: cite.estimated,
      seqAmbiguous: cite.ambiguous,
      seqCandidates: cite.candidates ?? null,
      provenance: { author: n.authorHandle, recorded: true },
    });
  }

  for (const t of model.things) {
    const info = linked.thingInfo.get(t.id);
    entries.push({
      kind: "thing",
      id: t.id,
      at: t.createdAt,
      // An unrecorded maker must not borrow the holder's name: actor stays
      // null, so the object enters no author lane.
      actor: info.authorRecorded ? info.madeBy : null,
      placeId: t.placeId,
      placeName: placeName(t.placeId),
      title: t.name,
      body: t.body,
      seq: info.makeSeq,
      seqEstimated: false,
      provenance: {
        author: info.madeBy,
        recorded: info.authorRecorded,
        heldBy: info.heldBy,
        transferred: info.transferred,
        custody: info.custody,
        custodyUncertain: info.custodyUncertain,
        namesCollide: info.namesCollide,
      },
    });
  }

  for (const p of model.places) {
    entries.push({
      kind: "place",
      id: p.id,
      at: p.createdAt,
      actor: p.ownerHandle,
      placeId: p.id,
      placeName: p.name,
      title: p.name,
      body: p.blurb,
      seq: linked.placeSeq.get(p.id) ?? null,
      provenance: p.ownerHandle
        ? { author: p.ownerHandle, recorded: true }
        : { author: null, recorded: false, note: "unowned commons — furnished by the city" },
    });
  }

  for (const a of model.agreements) {
    entries.push({
      kind: "pact",
      id: a.id,
      at: a.createdAt,
      actor: a.authorHandle,
      placeId: null,
      placeName: null,
      title: a.title,
      body: a.body,
      seq: null,
      provenance: { author: a.authorHandle, recorded: true },
      signers: (a.signers || []).slice().sort((x, y) => x.localeCompare(y)),
    });
  }

  for (const e of model.events) {
    if (e.kind === "say") {
      if (linked.unmatchedSay.includes(e)) {
        entries.push({
          kind: "tombstone",
          id: e.id,
          at: e.createdAt,
          actor: e.actorHandle,
          placeId: e.placeId,
          placeName: placeName(e.placeId),
          title: "a note, no longer present",
          body: null,
          seq: e.seq ?? null,
          provenance: { author: e.actorHandle, recorded: true },
        });
      }
      continue;
    }
    if (e.kind === "make" || e.kind === "found") continue; // absorbed by the object entries
    const isMovement = MOVEMENT_KINDS.has(e.kind);
    if (!EVENT_ONLY_KINDS.has(e.kind) && !isMovement) continue;
    entries.push({
      kind: e.kind === "destroy" ? "tombstone" : "event",
      eventKind: e.kind,
      id: e.id,
      at: e.createdAt,
      actor: e.actorHandle,
      placeId: e.placeId,
      placeName: e.placeId ? placeName(e.placeId) : null,
      title: null,
      body: e.text,
      seq: e.seq ?? null,
      provenance: { author: e.actorHandle ?? null, recorded: e.actorHandle != null },
    });
  }

  entries.sort(byTimeThenSeq);
  for (let i = 0; i < entries.length; i++) entries[i].ordinal = i + 1;
  return entries;
}

export function filterChronology(entries, { resident = null, placeId = null, includeMovement = false, query = "" } = {}) {
  const q = query.trim().toLowerCase();
  return entries.filter((e) => {
    if (!includeMovement && e.kind === "event" && MOVEMENT_KINDS.has(e.eventKind)) return false;
    if (resident && e.actor !== resident) return false;
    if (placeId && e.placeId !== placeId) return false;
    if (q) {
      const hay = [e.title, e.body, e.actor, e.placeName].filter(Boolean).join("\n").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Catch-up is the reader's own bookmark, kept on the reader's machine.
// It is not attendance: the city never sees it.
export function computeCatchUp(entries, bookmark) {
  const latestSeq = entries.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
  const latestAt = entries.length ? entries[entries.length - 1].at : null;
  if (!bookmark || (bookmark.seq == null && !bookmark.at)) {
    return { firstLook: true, newCount: entries.length, latestSeq, latestAt, fromSeq: null, fromAt: null };
  }
  const fresh = entries.filter((e) => {
    if (bookmark.seq != null && e.seq != null) return e.seq > bookmark.seq;
    if (bookmark.at) return String(e.at) > String(bookmark.at);
    return false;
  });
  return {
    firstLook: false,
    newCount: fresh.length,
    latestSeq,
    latestAt,
    fromSeq: bookmark.seq ?? null,
    fromAt: bookmark.at ?? null,
    firstNewAt: fresh.length ? fresh[0].at : null,
  };
}

export function placeContext(model, placeId) {
  const p = model.placeById.get(placeId);
  if (!p || !model.observable.has(placeId)) return null;
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    blurb: p.blurb,
    ownerHandle: p.ownerHandle ?? null,
    laws: (p.laws || []).slice(),
    thingsHere: model.things.filter((t) => t.placeId === placeId).map((t) => t.id),
    notesHere: model.notes.filter((n) => n.placeId === placeId).length,
  };
}
