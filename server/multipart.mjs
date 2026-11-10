/**
 * 极简 multipart/form-data 解析（只支持普通字段与文件，够用即可）。
 */
export function parseMultipart(buf, contentType){
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) return null;
  const boundary = (m[1] || m[2] || "").trim();
  if (!boundary) return null;

  const delim = Buffer.from("--" + boundary);
  const fields = {};
  const files = [];

  let pos = buf.indexOf(delim);
  if (pos < 0) return { fields, files };

  while (pos >= 0){
    let start = pos + delim.length;
    if (buf.slice(start, start + 2).toString() === "--") break;   // 结束标记
    if (buf.slice(start, start + 2).toString() === "\r\n") start += 2;

    const headEnd = buf.indexOf("\r\n\r\n", start);
    if (headEnd < 0) break;
    const head = buf.slice(start, headEnd).toString("utf8");

    const next = buf.indexOf(delim, headEnd + 4);
    if (next < 0) break;
    let bodyEnd = next;
    if (buf.slice(bodyEnd - 2, bodyEnd).toString() === "\r\n") bodyEnd -= 2;
    const body = buf.slice(headEnd + 4, bodyEnd);

    const nameM = /name="([^"]*)"/i.exec(head);
    const fileM = /filename\*?=(?:UTF-8''|")?([^";]*)"?/i.exec(head);
    const name = nameM ? nameM[1] : "";
    const filename = fileM ? decodeURIComponent(fileM[1]) : null;

    if (filename !== null){
      files.push({ field: name, filename, data: body, type: headerType(head) });
    } else if (name){
      fields[name] = body.toString("utf8");
    }
    pos = next;
  }
  return { fields, files };
}

const headerType = head => (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1]?.trim() || "application/octet-stream";
