// WhatsApp login stored in the portal (Supabase) instead of on this machine's disk, so
// the worker can run on hosts that wipe their disk on every deploy without re-linking.
// Same shape as Baileys' useMultiFileAuthState; Baileys recommends a database in production.
import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";

const CHUNK = 400;

function chunks(list, size) {
  const out = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

const parse = (text) => (typeof text === "string" ? JSON.parse(text, BufferJSON.reviver) : null);
const serialize = (value) => JSON.stringify(value, BufferJSON.replacer);

/**
 * `call(body)` sends { action, ... } to the portal's /api/report-bot/worker/auth and
 * returns its JSON, throwing on failure so Baileys never believes a key was saved when it wasn't.
 */
export async function useRemoteAuthState(call) {
  const read = async (keys) => {
    const values = {};
    for (const part of chunks(keys, CHUNK)) Object.assign(values, (await call({ action: "get", keys: part }))?.values ?? {});
    return values;
  };
  const write = async (entries) => {
    for (const part of chunks(Object.entries(entries), CHUNK)) await call({ action: "set", entries: Object.fromEntries(part) });
  };

  const saved = parse((await read(["creds"])).creds);
  const creds = saved || initAuthCreds();

  return {
    registered: Boolean(saved?.registered || saved?.me?.id),
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const values = await read(ids.map((id) => `${type}-${id}`));
          const data = {};
          for (const id of ids) {
            let value = parse(values[`${type}-${id}`] ?? null);
            if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          const entries = {};
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category] ?? {})) {
              const value = data[category][id];
              entries[`${category}-${id}`] = value ? serialize(value) : null;
            }
          }
          await write(entries);
        }
      }
    },
    saveCreds: () => write({ creds: serialize(creds) })
  };
}

export async function hasRemoteSession(call) {
  const saved = parse((await call({ action: "get", keys: ["creds"] }))?.values?.creds ?? null);
  return Boolean(saved?.registered || saved?.me?.id);
}

export async function clearRemoteSession(call) {
  await call({ action: "clear" });
}
