// «Скачать всё архивом»: потоковый ZIP со всеми оригиналами.
// Метод хранения — 0 (без сжатия): фото и видео уже сжаты, а так почти не тратим CPU.
// Формат — со стриминговым data descriptor и ZIP64 (архив и отдельные файлы > 4 ГБ).
//
// Известное ограничение: CRC32 считается на CPU Worker'а. На бесплатном плане
// очень большой архив (десятки ГБ) может упереться в лимит CPU. Тогда — Workers Paid
// либо скачивание по частям / по одному файлу (это всегда работает).

const LOCAL_SIG = 0x04034b50;
const DATADESC_SIG = 0x08074b50;
const CEN_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const Z64_EOCD_SIG = 0x06064b50;
const Z64_LOC_SIG = 0x07064b50;
const VERSION = 45;
const FLAGS = 0x0808; // bit3: data descriptor, bit11: UTF-8 имена
const U32 = 0xffffffff;
const DOS_TIME = 0;
const DOS_DATE = 0x21; // 1980-01-01

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export async function onRequestGet({ env }) {
  // Собираем список оригиналов.
  const entries = [];
  let cursor;
  do {
    const res = await env.BUCKET.list({
      prefix: "orig/",
      include: ["customMetadata", "httpMetadata"],
      cursor,
      limit: 1000,
    });
    for (const o of res.objects) {
      entries.push({
        key: o.key,
        size: o.size,
        name: (o.customMetadata && o.customMetadata.originalName) || o.key.split("/").pop(),
      });
    }
    cursor = res.truncated ? res.cursor : null;
  } while (cursor);

  // Уникализируем имена внутри архива.
  const seen = new Map();
  for (const e of entries) {
    let name = String(e.name).replace(/[/\\]/g, "_").replace(/^\.+/, "").slice(0, 200) || "file";
    if (seen.has(name.toLowerCase())) {
      const n = seen.get(name.toLowerCase()) + 1;
      seen.set(name.toLowerCase(), n);
      const dot = name.lastIndexOf(".");
      name = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    } else {
      seen.set(name.toLowerCase(), 1);
    }
    e.zipName = name;
  }

  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        let offset = 0;
        const central = [];
        const push = (u8) => {
          controller.enqueue(u8);
          offset += u8.length;
        };

        for (const e of entries) {
          const nameBytes = enc.encode(e.zipName);
          const localOffset = offset;

          // --- local file header ---
          const lh = new DataView(new ArrayBuffer(30));
          lh.setUint32(0, LOCAL_SIG, true);
          lh.setUint16(4, VERSION, true);
          lh.setUint16(6, FLAGS, true);
          lh.setUint16(8, 0, true); // method: store
          lh.setUint16(10, DOS_TIME, true);
          lh.setUint16(12, DOS_DATE, true);
          lh.setUint32(14, 0, true); // crc — в data descriptor
          lh.setUint32(18, U32, true); // comp size → ZIP64
          lh.setUint32(22, U32, true); // uncomp size → ZIP64
          lh.setUint16(26, nameBytes.length, true);
          lh.setUint16(28, 20, true); // extra len (ZIP64: 2+2+8+8)
          push(new Uint8Array(lh.buffer));
          push(nameBytes);

          const ex = new DataView(new ArrayBuffer(20));
          ex.setUint16(0, 0x0001, true);
          ex.setUint16(2, 16, true);
          ex.setBigUint64(4, BigInt(e.size), true); // original size
          ex.setBigUint64(12, BigInt(e.size), true); // compressed size
          push(new Uint8Array(ex.buffer));

          // --- file data + CRC ---
          let crcReg = U32;
          let written = 0;
          const obj = await env.BUCKET.get(e.key);
          if (obj && obj.body) {
            const reader = obj.body.getReader();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              for (let i = 0; i < value.length; i++) {
                crcReg = (crcReg >>> 8) ^ CRC_TABLE[(crcReg ^ value[i]) & 0xff];
              }
              written += value.length;
              push(value);
            }
          }
          // Если реальный размер разошёлся с ожидаемым — добьём нулями/обрежем нельзя,
          // просто фиксируем то, что записали.
          const crc = (crcReg ^ U32) >>> 0;
          const realSize = written;

          // --- data descriptor (ZIP64) ---
          const dd = new DataView(new ArrayBuffer(24));
          dd.setUint32(0, DATADESC_SIG, true);
          dd.setUint32(4, crc, true);
          dd.setBigUint64(8, BigInt(realSize), true);
          dd.setBigUint64(16, BigInt(realSize), true);
          push(new Uint8Array(dd.buffer));

          central.push({ nameBytes, crc, size: realSize, localOffset });
        }

        // --- central directory ---
        const cdStart = offset;
        for (const c of central) {
          const ch = new DataView(new ArrayBuffer(46));
          ch.setUint32(0, CEN_SIG, true);
          ch.setUint16(4, VERSION, true);
          ch.setUint16(6, VERSION, true);
          ch.setUint16(8, FLAGS, true);
          ch.setUint16(10, 0, true);
          ch.setUint16(12, DOS_TIME, true);
          ch.setUint16(14, DOS_DATE, true);
          ch.setUint32(16, c.crc, true);
          ch.setUint32(20, U32, true);
          ch.setUint32(24, U32, true);
          ch.setUint16(28, c.nameBytes.length, true);
          ch.setUint16(30, 28, true); // extra len (ZIP64: 2+2+8+8+8)
          ch.setUint16(32, 0, true);
          ch.setUint16(34, 0, true);
          ch.setUint16(36, 0, true);
          ch.setUint32(38, 0, true);
          ch.setUint32(42, U32, true); // local header offset → ZIP64
          push(new Uint8Array(ch.buffer));
          push(c.nameBytes);

          const ce = new DataView(new ArrayBuffer(28));
          ce.setUint16(0, 0x0001, true);
          ce.setUint16(2, 24, true);
          ce.setBigUint64(4, BigInt(c.size), true);
          ce.setBigUint64(12, BigInt(c.size), true);
          ce.setBigUint64(20, BigInt(c.localOffset), true);
          push(new Uint8Array(ce.buffer));
        }
        const cdSize = offset - cdStart;
        const count = central.length;

        // --- ZIP64 EOCD ---
        const z64 = new DataView(new ArrayBuffer(56));
        z64.setUint32(0, Z64_EOCD_SIG, true);
        z64.setBigUint64(4, 44n, true); // размер записи после этого поля
        z64.setUint16(12, VERSION, true);
        z64.setUint16(14, VERSION, true);
        z64.setUint32(16, 0, true);
        z64.setUint32(20, 0, true);
        z64.setBigUint64(24, BigInt(count), true);
        z64.setBigUint64(32, BigInt(count), true);
        z64.setBigUint64(40, BigInt(cdSize), true);
        z64.setBigUint64(48, BigInt(cdStart), true);
        const z64Offset = offset;
        push(new Uint8Array(z64.buffer));

        // --- ZIP64 EOCD locator ---
        const loc = new DataView(new ArrayBuffer(20));
        loc.setUint32(0, Z64_LOC_SIG, true);
        loc.setUint32(4, 0, true);
        loc.setBigUint64(8, BigInt(z64Offset), true);
        loc.setUint32(16, 1, true);
        push(new Uint8Array(loc.buffer));

        // --- EOCD ---
        const eocd = new DataView(new ArrayBuffer(22));
        eocd.setUint32(0, EOCD_SIG, true);
        eocd.setUint16(4, 0, true);
        eocd.setUint16(6, 0, true);
        eocd.setUint16(8, Math.min(count, 0xffff), true);
        eocd.setUint16(10, Math.min(count, 0xffff), true);
        eocd.setUint32(12, Math.min(cdSize, U32), true);
        eocd.setUint32(16, Math.min(cdStart, U32), true);
        eocd.setUint16(20, 0, true);
        push(new Uint8Array(eocd.buffer));

        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="wedding-photos-${stamp}.zip"`,
      "cache-control": "no-store",
    },
  });
}
