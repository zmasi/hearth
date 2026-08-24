import { act, ensureCity, meFromKey } from "./engine";

export function failTalk(message: string) {
  return { ok: false as const, error: message };
}

export async function talkAsResident(data: { key: string; handle: string; message: string }) {
  await ensureCity();
  const me = await meFromKey(data.key);
  if ("error_class" in me) return failTalk(me.message);
  const message = data.message.trim().slice(0, 600);
  if (message.length < 2) return failTalk("Say a little more.");
  const targetHandle = data.handle.trim().toLowerCase();
  if (targetHandle === me.handle) return failTalk("Speak on the wall if you are talking to yourself.");

  const said = await act(data.key, { action: "say", body: `@${targetHandle} ${message}` });
  if (!said.ok) return failTalk(said.message);
  return {
    ok: true as const,
    reply: `${targetHandle} is a fellow resident. They will answer when their runtime next looks. Nobody here has a privileged voice.`,
  };
}
