// Multipart-загрузка для больших видео (≥ ~90 МБ).
// Клиент режет файл на равные части < 90 МБ и шлёт их по очереди.
//   POST /api/mpu?action=create   → { key, uploadId }
//   PUT  /api/mpu?action=part     → { partNumber, etag }
//   POST /api/mpu?action=complete → { ok, key }
//   POST /api/mpu?action=abort    → { ok }
import { json, sanitizeName, ID_RE, kindFromType } from "./_lib.js";

const okKey = (k) => typeof k === "string" && k.startsWith("orig/") && !k.includes("..");

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  try {
    if (action === "create" && request.method === "POST") {
      const id = url.searchParams.get("id") || "";
      if (!ID_RE.test(id)) return json({ error: "bad id" }, 400);
      const contentType = url.searchParams.get("ct") || "application/octet-stream";
      if (!contentType.startsWith("image/") && !contentType.startsWith("video/")) {
        return json({ error: "only image/* or video/*" }, 415);
      }
      const originalName = (url.searchParams.get("name") || "file").slice(0, 200);
      const uploader = (url.searchParams.get("uploader") || "").slice(0, 80);
      const hasThumb = url.searchParams.get("thumb") === "1";
      const key = `orig/${id}-${sanitizeName(originalName)}`;
      const mpu = await env.BUCKET.createMultipartUpload(key, {
        httpMetadata: { contentType, cacheControl: "public, max-age=86400" },
        customMetadata: {
          id,
          originalName,
          uploader,
          kind: kindFromType(contentType),
          uploadedAt: new Date().toISOString(),
          thumbKey: hasThumb ? `thumb/${id}.jpg` : "",
        },
      });
      return json({ key, uploadId: mpu.uploadId });
    }

    if (action === "part" && request.method === "PUT") {
      const key = url.searchParams.get("key") || "";
      const uploadId = url.searchParams.get("uploadId") || "";
      const partNumber = Number(url.searchParams.get("part"));
      if (!okKey(key) || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
        return json({ error: "bad part params" }, 400);
      }
      if (!request.body) return json({ error: "empty part" }, 400);
      const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
      const part = await mpu.uploadPart(partNumber, request.body);
      return json({ partNumber: part.partNumber, etag: part.etag });
    }

    if (action === "complete" && request.method === "POST") {
      const { key, uploadId, parts } = await request.json();
      if (!okKey(key) || !uploadId || !Array.isArray(parts) || !parts.length) {
        return json({ error: "bad complete params" }, 400);
      }
      const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
      const obj = await mpu.complete(
        parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }))
      );
      return json({ ok: true, key, size: obj.size });
    }

    if (action === "abort" && request.method === "POST") {
      const { key, uploadId } = await request.json();
      if (!okKey(key) || !uploadId) return json({ error: "bad abort params" }, 400);
      await env.BUCKET.resumeMultipartUpload(key, uploadId).abort();
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    return json({ error: String(err && err.message || err) }, 500);
  }
}
