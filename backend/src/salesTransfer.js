import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
// Read only the public service catalog; never load internal cost configuration.
const catalogContext = { window: {} };
vm.runInNewContext(readFileSync(new URL("../../pricing-engine.js", import.meta.url), "utf8"), catalogContext);
const PUBLIC_SERVICES = catalogContext.window.TK_PRICING.SERVICES;
export const API = "https://api.servicem8.com/api_1.0";
export const SCOPES =
  "vendor read_customers manage_customers read_customer_contacts manage_customer_contacts read_jobs create_jobs manage_jobs read_job_materials manage_job_materials read_attachments manage_attachments read_job_payments read_tax_rates read_schedule";
export const hash = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
export const uuid = (value) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
    String(value),
  );
export function stableUuid(...parts) {
  const hex = hash(parts.join(":")).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = "8";
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export class ServiceM8Error extends Error {
  constructor(status, authMode = "oauth") {
    super(
      status === 401
        ? authMode === "api_key"
          ? "ServiceM8 rejected this API key. Check that the key is valid, active and copied in full."
          : "ServiceM8 access expired. Reconnect the account."
        : status === 403
          ? "ServiceM8 permissions are insufficient. Reconnect with the required scopes."
          : status === 429
            ? "ServiceM8 rate limit reached. The task will retry."
            : `ServiceM8 request failed (${status}).`,
    );
    this.status = status;
    this.code = status === 401
      ? authMode === "api_key" ? "SERVICEM8_API_KEY_REJECTED" : "SERVICEM8_RECONNECT_REQUIRED"
      : status === 403 ? "SERVICEM8_PERMISSION_DENIED"
      : status === 429 ? "SERVICEM8_RATE_LIMITED" : "SERVICEM8_REQUEST_FAILED";
  }
}
export async function request(
  path,
  { credentials, method = "GET", body, fetchImpl = fetch, base = API } = {},
) {
  if (!/^\/[a-z0-9_/?=.%&$,'\-]+$/i.test(path))
    throw Error("Invalid ServiceM8 resource path");
  const headers = {
    Accept: "application/json",
    ...(credentials.apiKey
      ? { "X-API-Key": credentials.apiKey }
      : { Authorization: "Bearer " + credentials.access_token }),
  };
  const multipart = body instanceof FormData,
    form = body instanceof URLSearchParams;
  if (body && !multipart)
    headers["Content-Type"] = form
      ? "application/x-www-form-urlencoded"
      : "application/json";
  const res = await fetchImpl(base + path, {
    method,
    headers,
    body: body ? (multipart || form ? body : JSON.stringify(body)) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new ServiceM8Error(res.status, credentials.apiKey ? "api_key" : "oauth");
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw Error("ServiceM8 returned invalid JSON");
  }
  if (
    (data.errorCode != null && String(data.errorCode) !== "0") ||
    data.success === false
  ) {
    const code = Number(data.errorCode);
    if ([401, 403, 429].includes(code)) throw new ServiceM8Error(code, credentials.apiKey ? "api_key" : "oauth");
    throw Error(
      "ServiceM8 rejected the request. Review the account permissions and supplied fields.",
    );
  }
  return {
    data,
    recordUuid: res.headers.get("x-record-uuid"),
    nextCursor: res.headers.get("x-next-cursor"),
  };
}
export function approvedLines(snapshot, { mode = "approved" } = {}) {
  const d = snapshot.details || {},
    lines = d.services || [],
    amount = Number(snapshot.amount);
  if (!Number.isFinite(amount) || amount <= 0 || !lines.length)
    throw Error("The approved quote has no valid priced services");
  if (typeof d.gstRegistered !== "boolean")
    throw Error(
      "This historical quote has no GST snapshot. Review its approved tax treatment before transfer.",
    );
  const savedPrice = line => line.priceSnapshot ?? line.fixedPrice;
  if (lines.some((line) => savedPrice(line) != null &&
      (!Number.isFinite(Number(savedPrice(line))) || Number(savedPrice(line)) < 0)))
    throw Error("The approved quote contains an invalid service price");
  const sum = lines.reduce(
    (s, l) => s + Math.max(0, Number(savedPrice(l)) || 0),
    0,
  );
  // Legacy line prices cannot be reconstructed safely from today's rates.
  if (!sum)
    return [
      {
        name: (mode === "quote" ? "Draft" : "Approved") + " TurnKey quote (see attached PDF)",
        quantity: "1",
        price: (amount / (d.gstRegistered ? 1.15 : 1)).toFixed(6),
        displayed_amount: amount.toFixed(2),
        displayed_amount_is_tax_inclusive: d.gstRegistered ? "1" : "0",
      },
    ];
  let remaining = Math.round(amount * 100),
    weight = 0,
    allocated = 0;
  return lines.map((l, i) => {
    const cents =
      i === lines.length - 1
        ? remaining
        : Math.round(
            (amount *
              100 *
              (weight += Math.max(0, Number(savedPrice(l)) || 0))) /
              sum,
          ) - allocated;
    remaining -= cents;
    allocated += cents;
    return {
      name:
        String(l.label || PUBLIC_SERVICES[l.svc]?.label || PUBLIC_SERVICES[l.svc]?.name || l.svc || "Service").slice(0, 200) +
        ` (${Number(l.qty) || 0} units)`,
      quantity: "1",
      price: (cents / 100 / (d.gstRegistered ? 1.15 : 1)).toFixed(6),
      displayed_amount: (cents / 100).toFixed(2),
      displayed_amount_is_tax_inclusive: d.gstRegistered ? "1" : "0",
      sort_order: String(i),
    };
  });
}
// Geometry uses one coordinate system per drawing; malformed vertices never get joined.
function outlinePages(input) {
  if (!Array.isArray(input) || !input.length || input.length > 64) return [];
  const num = v => (typeof v === "number" || typeof v === "string" && v.trim()) && Number.isFinite(Number(v)) ? Number(v) : null;
  const parse = (points, geo, minimum) => {
    if (!Array.isArray(points) || points.length < minimum || points.length > 2000) return null;
    const out = points.map(p => {
      const x = num(geo ? p?.lng : p?.x), y = num(geo ? p?.lat : p?.y);
      return x !== null && y !== null && (geo ? Math.abs(x) <= 180 && Math.abs(y) <= 85 : Math.abs(x) <= 1e7 && Math.abs(y) <= 1e7) ? { x, y } : null;
    });
    return out.every(Boolean) && new Set(out.map(p => JSON.stringify(p))).size >= minimum ? out : null;
  };
  const areas = input.map(a => {
    const service = PUBLIC_SERVICES[a?.service || a?.svc];
    if (!service || !["open", "closed"].includes(service.shape)) return null;
    const min = service.shape === "closed" ? 3 : 2;
    return { service, geo: parse(a.geoPts, true, min), pixels: parse(a.points, false, min) };
  });
  // Do not omit areas or overlay unrelated screen and geographic coordinates.
  if (areas.some(a => !a)) return [];
  const geo = areas.every(a => a.geo);
  if (!geo && !areas.every(a => a.pixels)) return [];
  const anchor = geo ? areas[0].geo[0].x : 0;
  const shapes = areas.map((a, i) => ({ service: a.service, tag: i + 1, points: (geo ? a.geo : a.pixels).map(p => {
    if (!geo) return p;
    const lng = anchor + ((p.x - anchor + 540) % 360 - 180);
    const sin = Math.sin(p.y * Math.PI / 180);
    return { x: (lng + 180) / 360, y: .5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) };
  }) }));
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const a of shapes) for (const p of a.points) {
    minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);
  }
  const scale = Math.min(500 / Math.max(maxX-minX,1e-10), 350 / Math.max(maxY-minY,1e-10));
  const pages = [];
  for (let offset=0; offset<shapes.length; offset+=16) {
    const group=shapes.slice(offset,offset+16), commands=["q 2 w"];
    for (const [i,a] of group.entries()) {
      const color = /^#[a-f0-9]{6}$/i.test(a.service.color) ? a.service.color : "#138a72";
      const rgb = [1,3,5].map(n => (parseInt(color.slice(n,n+2),16)/255).toFixed(4)).join(" ");
      const pts=a.points.map(p=>({x:297.5+(p.x-(minX+maxX)/2)*scale,y:545-(p.y-(minY+maxY)/2)*scale}));
      commands.push(rgb+" RG",pts.map((p,j)=>`${p.x.toFixed(2)} ${p.y.toFixed(2)} ${j ? "l" : "m"}`).join(" ")+(a.service.shape === "closed" ? " h S" : " S"));
      const center=pts.reduce((c,p)=>({x:c.x+p.x/pts.length,y:c.y+p.y/pts.length}),{x:0,y:0});
      commands.push(`BT /F1 10 Tf ${center.x.toFixed(2)} ${center.y.toFixed(2)} Td (${a.tag}) Tj ET`);
      const label=String(a.service.label).replace(/[^\x20-\x7e]/g,"?").replace(/[\\()]/g,"\\$&");
      commands.push(`${rgb} rg BT /F1 10 Tf 45 ${320-i*15} Td (${a.tag}. ${label}) Tj ET 0 g`);
    }
    commands.push("Q");
    pages.push({ text: ["Measured service outlines", "Saved outline diagram - not aerial imagery.",
      geo ? "Geographic coordinates" : "Sketch coordinates - not geographically positioned"], drawing: commands.join("\n") });
  }
  return pages;
}
// Deterministic, dependency-free PDF of the approved public terms and line totals.
export function quotePdf({ reference, business, customer, snapshot, mode = "approved" }) {
  if (!["quote", "approved"].includes(mode)) throw Error("Invalid quote PDF mode");
  const lines = [
    business?.name || "Service provider",
    (mode === "quote" ? "DRAFT QUOTE " : "APPROVED QUOTE ") + reference,
    "Customer: " + (customer.name || ""),
    "Property: " + (customer.address || ""),
    "",
    ...approvedLines(snapshot, { mode }).map(
      (x) => `${x.name}    $${x.displayed_amount}`,
    ),
    "",
    (mode === "quote" ? "Quoted customer total: $" : "Approved customer total: $") + Number(snapshot.amount).toFixed(2),
    snapshot.details?.gstRegistered ? "Includes GST (15%)." : "No GST charged.",
    "",
    ...String(snapshot.details?.publicTerms || "").split("\n"),
  ];
  const wrapped = lines.flatMap((s) => String(s).match(/.{1,90}/g) || [""]),
    pages = [];
  for (let i = 0; i < wrapped.length; i += 45)
    pages.push({ text: wrapped.slice(i, i + 45) });
  pages.push(...outlinePages(snapshot.details?.areaPolys));
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kids = [];
  for (const page of pages) {
    const pageId = objects.length + 1,
      streamId = pageId + 1;
    kids.push(pageId + " 0 R");
    const clean = (s) =>
      s.replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, "\\$&");
    const stream =
      "BT /F1 11 Tf 45 790 Td 16 TL " +
      page.text
        .map((l, i) => (i ? "T* " : "") + "(" + clean(l) + ") Tj")
        .join("\n") +
      " ET\n" + (page.drawing || "");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let out = "%PDF-1.4\n",
    offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const start = Buffer.byteLength(out);
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(out);
}
