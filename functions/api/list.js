// Список файлов для галереи: перечисляем оригиналы в R2 вместе с метаданными.
import { json, kindFromType } from "./_lib.js";

export async function onRequestGet({ env }) {
  const files = [];
  let cursor;
  do {
    const res = await env.BUCKET.list({
      prefix: "orig/",
      include: ["customMetadata", "httpMetadata"],
      cursor,
      limit: 1000,
    });
    for (const o of res.objects) {
      const m = o.customMetadata || {};
      const ct = o.httpMetadata?.contentType || "";
      files.push({
        key: o.key,
        name: m.originalName || o.key.split("/").pop(),
        size: o.size,
        uploader: m.uploader || "",
        kind: m.kind || kindFromType(ct),
        contentType: ct,
        uploadedAt: m.uploadedAt || (o.uploaded ? new Date(o.uploaded).toISOString() : ""),
        thumbKey: m.thumbKey || "",
      });
    }
    cursor = res.truncated ? res.cursor : null;
  } while (cursor);

  files.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0));
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  return json({ count: files.length, totalSize, files });
}
