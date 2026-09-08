"use strict";
/*
 * Свадебная галерея — сервер для российского хостинга.
 * Хранит файлы на диске, API совместим 1:1 с прежней версией на Cloudflare,
 * поэтому фронтенд (public/) не меняется.
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const archiver = require("archiver");

const DATA_DIR = process.env.WG_DATA || "/var/wedding/files";
const PUBLIC_DIR = process.env.WG_PUBLIC || path.join(__dirname, "..", "public");
const PORT = Number(process.env.WG_PORT || 3000);
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

const ORIG = path.join(DATA_DIR, "orig");
const THUMB = path.join(DATA_DIR, "thumb");
const META = path.join(DATA_DIR, "meta");
const TMP = path.join(DATA_DIR, "tmp");
for (const d of [ORIG, THUMB, META, TMP]) fs.mkdirSync(d, { recursive: true });

const ID_RE = /^[0-9]{10,16}-[a-z0-9]{6,16}$/i;
const kindFromType = (ct) => (ct && /^video\//i.test(ct) ? "video" : "photo");

function sanitizeName(name) {
  const cleaned = String(name || "file")
    .normalize("NFC")
    .replace(/[/\\?%*:|"<>\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned || "file";
}
const idOfKey = (key) => (String(key).replace(/^orig\//, "").match(/^(\d{10,16}-[a-z0-9]{6,16})/i) || [])[1];

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// поток запроса → файл (через .part и переименование)
function pipeToFile(req, dest) {
  return new Promise((resolve, reject) => {
    const tmp = dest + ".part-" + crypto.randomBytes(4).toString("hex");
    const ws = fs.createWriteStream(tmp);
    req.pipe(ws);
    req.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", async () => {
      try {
        await fsp.rename(tmp, dest);
        const st = await fsp.stat(dest);
        resolve(st.size);
      } catch (e) { reject(e); }
    });
  });
}

async function writeMeta(id, m) {
  await fsp.writeFile(path.join(META, id + ".json"), JSON.stringify(m), "utf8");
}
async function readAllMeta() {
  const files = await fsp.readdir(META).catch(() => []);
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await fsp.readFile(path.join(META, f), "utf8")));
    } catch {}
  }
  return out;
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

const jsonBody = express.json({ limit: "2mb" });

/* ---------- upload (одним запросом) ---------- */
app.post("/api/upload", async (req, res) => {
  try {
    const q = req.query;
    const type = q.type || "orig";
    const id = String(q.id || "");
    if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });

    if (type === "thumb") {
      await pipeToFile(req, path.join(THUMB, id + ".jpg"));
      return res.json({ ok: true });
    }

    const ct = req.headers["content-type"] || "application/octet-stream";
    if (!/^image\//i.test(ct) && !/^video\//i.test(ct)) {
      return res.status(415).json({ error: "only image/* or video/*" });
    }
    const originalName = String(q.name || "file").slice(0, 200);
    const uploader = String(q.uploader || "").slice(0, 80);
    const hasThumb = q.thumb === "1";
    const safe = sanitizeName(originalName);
    const key = `orig/${id}-${safe}`;
    const size = await pipeToFile(req, path.join(ORIG, `${id}-${safe}`));

    const at = String(q.at || "");
    const uploadedAt = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(at) ? at : new Date().toISOString();

    await writeMeta(id, {
      id, key, originalName, uploader,
      kind: kindFromType(ct),
      contentType: ct,
      size,
      uploadedAt,
      thumbKey: hasThumb ? `thumb/${id}.jpg` : "",
    });
    res.json({ ok: true, key });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

/* ---------- multipart (большие видео) ---------- */
app.all("/api/mpu", (req, res, next) => {
  if (req.query.action === "part") return next();
  return jsonBody(req, res, next);
});
app.all("/api/mpu", async (req, res) => {
  const action = req.query.action;
  try {
    if (action === "create" && req.method === "POST") {
      const id = String(req.query.id || "");
      if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
      const ct = String(req.query.ct || "application/octet-stream");
      if (!/^image\//i.test(ct) && !/^video\//i.test(ct)) return res.status(415).json({ error: "only image/video" });
      const originalName = String(req.query.name || "file").slice(0, 200);
      const safe = sanitizeName(originalName);
      const key = `orig/${id}-${safe}`;
      const uploadId = id + "-" + crypto.randomBytes(6).toString("hex");
      await fsp.mkdir(path.join(TMP, uploadId), { recursive: true });
      await fsp.writeFile(path.join(TMP, uploadId, "_info.json"), JSON.stringify({
        id, key, safe, ct,
        originalName,
        uploader: String(req.query.uploader || "").slice(0, 80),
        hasThumb: req.query.thumb === "1",
        at: String(req.query.at || ""),
      }), "utf8");
      return res.json({ key, uploadId });
    }

    if (action === "part" && req.method === "PUT") {
      const uploadId = String(req.query.uploadId || "");
      const part = Number(req.query.part);
      if (!/^[0-9a-f-]+$/i.test(uploadId) || uploadId.includes("..") || !Number.isInteger(part) || part < 1) {
        return res.status(400).json({ error: "bad part params" });
      }
      const dir = path.join(TMP, uploadId);
      if (!fs.existsSync(dir)) return res.status(404).json({ error: "no such upload" });
      await pipeToFile(req, path.join(dir, String(part).padStart(6, "0")));
      return res.json({ partNumber: part, etag: String(part) });
    }

    if (action === "complete" && req.method === "POST") {
      const { uploadId } = req.body || {};
      if (!uploadId || String(uploadId).includes("..")) return res.status(400).json({ error: "bad uploadId" });
      const dir = path.join(TMP, String(uploadId));
      const info = JSON.parse(await fsp.readFile(path.join(dir, "_info.json"), "utf8"));
      const parts = (await fsp.readdir(dir)).filter((f) => /^\d{6}$/.test(f)).sort();
      const dest = path.join(ORIG, `${info.id}-${info.safe}`);
      const ws = fs.createWriteStream(dest);
      for (const p of parts) {
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(path.join(dir, p));
          rs.on("error", reject);
          rs.on("end", resolve);
          rs.pipe(ws, { end: false });
        });
      }
      ws.end();
      await new Promise((r) => ws.on("close", r));
      const size = (await fsp.stat(dest)).size;
      const at = info.at;
      await writeMeta(info.id, {
        id: info.id, key: info.key, originalName: info.originalName, uploader: info.uploader,
        kind: kindFromType(info.ct), contentType: info.ct, size,
        uploadedAt: /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(at) ? at : new Date().toISOString(),
        thumbKey: info.hasThumb ? `thumb/${info.id}.jpg` : "",
      });
      await fsp.rm(dir, { recursive: true, force: true });
      return res.json({ ok: true, key: info.key, size });
    }

    if (action === "abort" && req.method === "POST") {
      const { uploadId } = req.body || {};
      if (uploadId && !String(uploadId).includes("..")) {
        await fsp.rm(path.join(TMP, String(uploadId)), { recursive: true, force: true });
      }
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

/* ---------- список для галереи ---------- */
app.get("/api/list", async (_req, res) => {
  const all = await readAllMeta();
  all.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0));
  const files = all.map((m) => ({
    key: m.key,
    name: m.originalName,
    size: m.size,
    uploader: m.uploader || "",
    kind: m.kind || kindFromType(m.contentType),
    contentType: m.contentType || "",
    uploadedAt: m.uploadedAt || "",
    thumbKey: m.thumbKey || "",
  }));
  res.set("cache-control", "no-store");
  res.json({ count: files.length, totalSize: files.reduce((s, f) => s + (f.size || 0), 0), files });
});

/* ---------- отдача файла ---------- */
function resolveStored(key) {
  if (!key || key.includes("..")) return null;
  if (key.startsWith("orig/")) return path.join(ORIG, key.slice(5));
  if (key.startsWith("thumb/")) return path.join(THUMB, key.slice(6));
  return null;
}
app.get(/^\/api\/file\/(.+)/, async (req, res) => {
  let key;
  try { key = decodeURIComponent(req.params[0]); } catch { return res.status(400).end("bad key"); }
  const abs = resolveStored(key);
  if (!abs || !fs.existsSync(abs)) return res.status(404).end("not found");

  const isThumb = key.startsWith("thumb/");
  const headers = {
    "cache-control": isThumb ? "public, max-age=31536000, immutable" : "public, max-age=86400",
  };
  if (req.query.dl) {
    let name = key.split("/").pop();
    let ctMeta = "";
    const id = idOfKey(key);
    if (id) {
      try { ctMeta = JSON.parse(fs.readFileSync(path.join(META, id + ".json"), "utf8")).contentType || ""; } catch {}
      try {
        const m = JSON.parse(fs.readFileSync(path.join(META, id + ".json"), "utf8"));
        if (m.originalName) name = m.originalName;
      } catch {}
    }
    if (ctMeta === "image/jpeg" && /\.(heic|heif)$/i.test(name)) name = name.replace(/\.(heic|heif)$/i, ".jpg");
    headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  res.sendFile(abs, { headers, acceptRanges: true, dotfiles: "deny" }, (err) => {
    if (err && !res.headersSent) res.status(err.statusCode || 500).end();
  });
});

/* ---------- скачать всё архивом ---------- */
app.get("/api/zip", async (_req, res) => {
  const all = await readAllMeta();
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("content-type", "application/zip");
  res.setHeader("content-disposition", `attachment; filename="wedding-photos-${stamp}.zip"`);
  res.setHeader("cache-control", "no-store");

  const archive = archiver("zip", { store: true });
  archive.on("error", () => { try { res.destroy(); } catch {} });
  archive.pipe(res);

  const used = new Map();
  for (const m of all) {
    const abs = path.join(ORIG, m.key.replace(/^orig\//, ""));
    if (!fs.existsSync(abs)) continue;
    let name = String(m.originalName || m.key.split("/").pop()).replace(/[/\\]/g, "_");
    if (m.contentType === "image/jpeg") name = name.replace(/\.(heic|heif)$/i, ".jpg");
    const lower = name.toLowerCase();
    if (used.has(lower)) {
      const n = used.get(lower) + 1;
      used.set(lower, n);
      const dot = name.lastIndexOf(".");
      name = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    } else used.set(lower, 1);
    archive.file(abs, { name });
  }
  archive.finalize();
});

/* ---------- модерация ---------- */
app.post("/api/admin/delete", jsonBody, async (req, res) => {
  if (!ADMIN_SECRET || !timingSafeEqual(req.headers["x-admin-secret"] || "", ADMIN_SECRET)) {
    return res.status(403).json({ error: "forbidden" });
  }
  const key = (req.body && req.body.key) || "";
  if (typeof key !== "string" || !key.startsWith("orig/") || key.includes("..")) {
    return res.status(400).json({ error: "bad key" });
  }
  const id = idOfKey(key);
  const deleted = [];
  const tryRm = async (p, label) => { try { await fsp.unlink(p); deleted.push(label); } catch {} };
  await tryRm(path.join(ORIG, key.slice(5)), key);
  if (id) {
    await tryRm(path.join(THUMB, id + ".jpg"), `thumb/${id}.jpg`);
    await tryRm(path.join(META, id + ".json"), `meta/${id}`);
  }
  res.json({ ok: true, deleted });
});

/* ---------- статика ---------- */
app.use(express.static(PUBLIC_DIR, {
  extensions: ["html"],
  setHeaders: (res, p) => {
    if (/\.(woff2|jpg|png|wasm)$/.test(p)) res.setHeader("cache-control", "public, max-age=604800");
  },
}));
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`wedding-gallery server on 127.0.0.1:${PORT}  data=${DATA_DIR}  admin=${ADMIN_SECRET ? "set" : "UNSET"}`);
});
