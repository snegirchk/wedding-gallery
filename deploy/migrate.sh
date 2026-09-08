#!/usr/bin/env bash
# Перенос файлов из прежней версии (Cloudflare Pages + R2) на этот сервер.
# Запуск на сервере от пользователя wedding (или root, потом chown):
#   bash /opt/wedding-gallery/deploy/migrate.sh
set -euo pipefail

SRC="${1:-https://wedding-gallery-5t2.pages.dev}"
DATA="${WG_DATA:-/var/wedding/files}"
mkdir -p "$DATA"/orig "$DATA"/thumb "$DATA"/meta

echo "источник: $SRC"
curl -fsS "$SRC/api/list" -o /tmp/wg_list.json
node -e '
const fs=require("fs");
const d=JSON.parse(fs.readFileSync("/tmp/wg_list.json"));
const rows=d.files.map(f=>[f.key,f.thumbKey||"",f.name,f.uploader||"",f.kind||"",f.contentType||"",f.uploadedAt||"",f.size||0].join("\t"));
fs.writeFileSync("/tmp/wg_rows.tsv", rows.join("\n"));
process.stderr.write(d.count+" файлов к переносу\n");
'

n=0
while IFS=$'\t' read -r key thumbKey name uploader kind ct at size; do
  [ -z "$key" ] && continue
  n=$((n+1))
  id=$(printf '%s' "$key" | sed -E 's#^orig/([0-9]{10,16}-[0-9a-fA-F]{6,16}).*#\1#')
  ekey=$(node -e 'console.log(process.argv[1].split("/").map(encodeURIComponent).join("/"))' "$key")

  curl -fsS "$SRC/api/file/$ekey" -o "$DATA/orig/${key#orig/}"

  code=$(curl -s -o "$DATA/thumb/$id.jpg" -w '%{http_code}' "$SRC/api/file/thumb/$id.jpg" || true)
  [ "$code" = "200" ] || rm -f "$DATA/thumb/$id.jpg"

  WG_DATA="$DATA" node -e '
    const fs=require("fs");
    const [id,key,name,uploader,kind,ct,at,size]=process.argv.slice(1);
    const hasThumb=fs.existsSync(process.env.WG_DATA+"/thumb/"+id+".jpg");
    fs.writeFileSync(process.env.WG_DATA+"/meta/"+id+".json", JSON.stringify({
      id,key,originalName:name,uploader,kind,contentType:ct,size:Number(size)||0,
      uploadedAt:at,thumbKey:hasThumb?("thumb/"+id+".jpg"):""
    }));
  ' "$id" "$key" "$name" "$uploader" "$kind" "$ct" "$at" "$size"

  echo "[$n] $name"
done < /tmp/wg_rows.tsv

echo "готово: $n файлов в $DATA"
