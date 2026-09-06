// Общие утилиты для Pages Functions. Файл с префиксом «_» не превращается в маршрут.

export const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });

// Приводим имя файла к безопасному виду для ключа R2.
export function sanitizeName(name) {
  const cleaned = String(name || "file")
    .normalize("NFC")
    .replace(/[/\\?%*:|"<>\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || "file";
}

// id вида «<timestamp>-<8 hex>», приходит с клиента.
export const ID_RE = /^[0-9]{10,16}-[a-z0-9]{6,16}$/i;

export function kindFromType(ct) {
  if (!ct) return "photo";
  if (ct.startsWith("video/")) return "video";
  return "photo";
}
