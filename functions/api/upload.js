// Одношаговая загрузка: файл целиком в одном POST.
// Клиент использует этот путь для файлов меньше ~90 МБ (лимит тела запроса
// у Pages Functions на бесплатном плане — 100 МБ) и для превью.
import { json, sanitizeName, ID_RE, kindFromType } from "./_lib.js";

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "orig";
  const id = url.searchParams.get("id") || "";
  if (!ID_RE.test(id)) return json({ error: "bad id" }, 400);
  if (!request.body) return json({ error: "empty body" }, 400);

  // Превью — всегда JPEG, кладём рядом с оригиналом под тем же id.
  if (type === "thumb") {
    await env.BUCKET.put(`thumb/${id}.jpg`, request.body, {
      httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" },
    });
    return json({ ok: true });
  }

  const contentType = request.headers.get("content-type") || "application/octet-stream";
  if (!contentType.startsWith("image/") && !contentType.startsWith("video/")) {
    return json({ error: "only image/* or video/*" }, 415);
  }

  const originalName = (url.searchParams.get("name") || "file").slice(0, 200);
  const uploader = (url.searchParams.get("uploader") || "").slice(0, 80);
  const hasThumb = url.searchParams.get("thumb") === "1";
  const kind = kindFromType(contentType);
  const key = `orig/${id}-${sanitizeName(originalName)}`;

  await env.BUCKET.put(key, request.body, {
    httpMetadata: { contentType, cacheControl: "public, max-age=86400" },
    customMetadata: {
      id,
      originalName,
      uploader,
      kind,
      uploadedAt: new Date().toISOString(),
      thumbKey: hasThumb ? `thumb/${id}.jpg` : "",
    },
  });

  return json({ ok: true, key });
}
