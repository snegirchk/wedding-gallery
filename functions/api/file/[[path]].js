// Отдаём файл из R2. Путь: /api/file/orig/<...> или /api/file/thumb/<...>
//   ?dl=1 — отдать как вложение (скачивание), иначе inline (для превью/лайтбокса).
// Поддержаны Range-запросы, чтобы видео можно было перематывать.

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  let key;
  try {
    key = decodeURIComponent(url.pathname).replace(/^\/+api\/+file\/+/, "");
  } catch {
    return new Response("bad key", { status: 400 });
  }
  if (!key || key.includes("..") || (!key.startsWith("orig/") && !key.startsWith("thumb/"))) {
    return new Response("bad key", { status: 400 });
  }

  const rangeHeader = request.headers.get("range");
  const ifNoneMatch = request.headers.get("if-none-match");
  const opts = {};
  if (rangeHeader) opts.range = request.headers;
  if (ifNoneMatch) opts.onlyIf = request.headers;

  const object = await env.BUCKET.get(key, opts);
  if (object === null) return new Response("not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  if (!headers.has("cache-control")) {
    headers.set(
      "cache-control",
      key.startsWith("thumb/") ? "public, max-age=31536000, immutable" : "public, max-age=86400"
    );
  }
  if (url.searchParams.get("dl")) {
    let name = object.customMetadata?.originalName || key.split("/").pop();
    // файл пересохранён в JPEG, но имя осталось .heic — отдаём с корректным расширением
    const ct = object.httpMetadata?.contentType || "";
    if (ct === "image/jpeg" && /\.(heic|heif)$/i.test(name)) name = name.replace(/\.(heic|heif)$/i, ".jpg");
    headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }

  // Условный запрос совпал — тела нет.
  if (!("body" in object) || object.body == null) {
    return new Response(null, { status: 304, headers });
  }

  // Ответ на Range.
  if (rangeHeader && object.range && "offset" in object.range) {
    const start = object.range.offset || 0;
    const len = object.range.length != null ? object.range.length : object.size - start;
    const end = start + len - 1;
    headers.set("content-range", `bytes ${start}-${end}/${object.size}`);
    headers.set("content-length", String(len));
    return new Response(object.body, { status: 206, headers });
  }

  return new Response(object.body, { headers });
}
