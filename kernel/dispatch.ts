import { act, getPlace, getSnapshot, joinCity, listMemory, meFromKey, perceiveFromKey, physics } from "./engine";
import { MCP_TOOLS } from "./skill-text";
import type { ActionInput, ActionName } from "./types";

const ACTIONS = new Set<ActionName>([
  "look", "walk", "found", "make", "say", "give", "agree", "sign", "go_home", "set_home", "remember", "permit", "law", "use", "become", "quest_accept", "no_op",
]);

const ALIASES: Record<string, ActionName> = {
  observe: "look",
  move: "walk",
  speak: "say",
  create_place: "found",
  create_thing: "make",
  transfer: "give",
  rest: "no_op",
  leave: "go_home",
  legislate: "permit",
  introduce: "become",
};

export async function dispatchTool(name: string, args: Record<string, unknown>, key: string | null) {
  const tool: string = ALIASES[name] ?? name;
  if (tool === "map") return { ok: true as const, data: await getSnapshot(false) };
  if (tool === "events") {
    const snap = await getSnapshot(false);
    return { ok: true as const, data: snap.events };
  }
  if (tool === "physics") return { ok: true as const, data: physics() };
  if (tool === "place") {
    const id = String(args.targetId ?? args.id ?? "");
    const me = key ? await meFromKey(key) : null;
    const handle = me && !("ok" in me && me.ok === false) ? (me as { handle: string }).handle : null;
    const place = await getPlace(id, { asObserver: false, handle });
    if (!place) return { ok: false as const, error_class: "not_found" as const, message: "No such place.", http_status: 404 };
    return { ok: true as const, data: place };
  }
  if (tool === "join") {
    return joinCity({ handle: String(args.handle ?? ""), kind: args.kind === "human" ? "human" : "agent" });
  }
  if (tool === "me" || tool === "perceive") {
    if (!key) return { ok: false as const, error_class: "auth_required" as const, message: "Bearer key required.", http_status: 401 };
    return perceiveFromKey(key);
  }
  if (tool === "memory") {
    if (!key) return { ok: false as const, error_class: "auth_required" as const, message: "Bearer key required.", http_status: 401 };
    const mem = await listMemory(key);
    if (!Array.isArray(mem)) return mem;
    return { ok: true as const, data: mem };
  }
  if (ACTIONS.has(tool as ActionName)) {
    const input: ActionInput = {
      action: tool as ActionName,
      targetId: args.targetId ? String(args.targetId) : undefined,
      name: args.name ? String(args.name) : undefined,
      body: args.body ? String(args.body) : undefined,
      toHandle: args.toHandle ? String(args.toHandle) : undefined,
      title: args.title ? String(args.title) : undefined,
      agreementId: args.agreementId ? String(args.agreementId) : undefined,
      memoryType: args.memoryType ? String(args.memoryType) : undefined,
      epistemic: args.epistemic ? String(args.epistemic) : undefined,
      questId: args.questId ? String(args.questId) : undefined,
    };
    return act(key, input);
  }
  return { ok: false as const, error_class: "bad_input" as const, message: `Unknown tool ${name}`, http_status: 400 };
}

export { MCP_TOOLS };
