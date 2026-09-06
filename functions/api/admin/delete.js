// Удаление файла из галереи. Единственная закрытая часть проекта.
// Секрет передаётся в заголовке x-admin-secret и сверяется с env.ADMIN_SECRET.
import { json } from "../_lib.js";

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  const secret = env.ADMIN_SECRET || "";
  const given = request.headers.get("x-admin-secret") || "";
  if (!secret || !timingSafeEqual(given, secret)) {
    return json({ error: "forbidden" }, 403);
  }

  const { key } = await request.json().catch(() => ({}));
  if (typeof key !== "string" || !key.startsWith("orig/") || key.includes("..")) {
    return json({ error: "bad key" }, 400);
  }

  const head = await env.BUCKET.head(key);
  const toDelete = new Set([key]);
  const thumbKey = head?.customMetadata?.thumbKey;
  if (thumbKey && thumbKey.startsWith("thumb/")) toDelete.add(thumbKey);
  // Подстраховка от «осиротевших» превью: id зашит в начало ключа оригинала.
  const idMatch = key.slice(5).match(/^(\d{10,16}-[a-z0-9]{6,16})/i);
  if (idMatch) toDelete.add(`thumb/${idMatch[1]}.jpg`);

  const keys = [...toDelete];
  await env.BUCKET.delete(keys);
  return json({ ok: true, deleted: keys });
}
