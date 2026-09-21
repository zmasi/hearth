// Hearth Phase 20, native habitation: the resident's live harness loop.
//
// One resident per process. Consent is read again on every tick, so switching
// the bell off in the resident's own file takes effect without a restart. The
// loop logs only its own acts (a wake accepted, a visit ended, a change in why
// it is holding back, an error). Quiet ticks and an awake resident leave no
// line: this is a bell, not an attendance record.
import { nativeTick } from "./habitation-visit.mjs";

export async function runLive({ loadConsent, loadState, persist, loadRing = async () => null, clearRing = async () => {},
  tick = nativeTick, tickDeps = {}, now = () => new Date().toISOString(), intervalMs = 300_000, sleep,
  shouldStop = () => false, log = () => {}, once = false }) {
  let holding = null; // the last reason we logged for not ringing, so it is said once per episode
  const say = (entry) => log({ at: now(), ...entry });
  for (;;) {
    let result;
    try {
      const consent = await loadConsent();
      const state = await loadState();
      const ring = await loadRing();
      result = await tick({ consent, state, persist, now: now(), ring, ...tickDeps });
      if (result.ringConsumed) await clearRing();
    } catch (error) {
      result = { outcome: "error", reason: error?.code ?? "tick_failed", message: String(error?.message ?? error) };
    }
    if (result.ended) say({ act: "visit_ended", visit_id: result.ended.visit_id, native_state: result.ended.native_state });
    if (result.outcome === "accepted") {
      const visit = result.state.visit;
      const kinds = {};
      for (const t of visit.packet?.triggers ?? []) kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
      say({ act: "wake_accepted", visit_id: visit.id, task_id: visit.task_id, context_id: visit.context_id, rang: kinds });
      holding = null;
    } else if (result.outcome === "deferred" || result.outcome === "skipped" || result.outcome === "error") {
      const why = `${result.outcome}:${result.reason}`;
      if (why !== holding) {
        say(result.outcome === "skipped" ? { act: result.reason }
          : { act: result.outcome, reason: result.reason, ...(result.retry_after ? { retry_after: result.retry_after } : {}), ...(result.message ? { message: result.message } : {}) });
        holding = why;
      }
    } else {
      holding = null;
    }
    if (once || shouldStop()) return result;
    await sleep(intervalMs);
    if (shouldStop()) return result;
  }
}
