import crypto from "node:crypto";
export const API = "https://api.servicem8.com/api_1.0";
export const SCOPES =
  "vendor read_customers manage_customers read_customer_contacts manage_customer_contacts read_jobs create_jobs read_job_materials manage_job_materials read_attachments manage_attachments read_job_payments read_tax_rates";
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
export function approvedLines(snapshot) {
  const d = snapshot.details || {},
    lines = d.services || [],
    amount = Number(snapshot.amount);
  if (!Number.isFinite(amount) || amount <= 0 || !lines.length)
    throw Error("The approved quote has no valid priced services");
  if (typeof d.gstRegistered !== "boolean")
    throw Error(
      "This historical quote has no GST snapshot. Review its approved tax treatment before transfer.",
    );
  if (lines.some((line) => line.priceSnapshot != null &&
      (!Number.isFinite(Number(line.priceSnapshot)) || Number(line.priceSnapshot) < 0)))
    throw Error("The approved quote contains an invalid service price");
  const sum = lines.reduce(
    (s, l) => s + Math.max(0, Number(l.priceSnapshot) || 0),
    0,
  );
  // Legacy line prices cannot be reconstructed safely from today's rates.
  if (!sum)
    return [
      {
        name: "Approved TurnKey quote (see attached PDF)",
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
              (weight += Math.max(0, Number(l.priceSnapshot) || 0))) /
              sum,
          ) - allocated;
    remaining -= cents;
    allocated += cents;
    return {
      name:
        String(l.label || l.svc || "Service").slice(0, 200) +
        ` (${Number(l.qty) || 0} units)`,
      quantity: "1",
      price: (cents / 100 / (d.gstRegistered ? 1.15 : 1)).toFixed(6),
      displayed_amount: (cents / 100).toFixed(2),
      displayed_amount_is_tax_inclusive: d.gstRegistered ? "1" : "0",
      sort_order: String(i),
    };
  });
}
// Deterministic, dependency-free PDF of the approved public terms and line totals.
export function quotePdf({ reference, business, customer, snapshot }) {
  const lines = [
    business?.name || "Service provider",
    "APPROVED QUOTE " + reference,
    "Customer: " + (customer.name || ""),
    "Property: " + (customer.address || ""),
    "",
    ...approvedLines(snapshot).map(
      (x) => `${x.name}    $${x.displayed_amount}`,
    ),
    "",
    "Approved customer total: $" + Number(snapshot.amount).toFixed(2),
    snapshot.details?.gstRegistered ? "Includes GST (15%)." : "No GST charged.",
    "",
    ...String(snapshot.details?.publicTerms || "").split("\n"),
  ];
  const wrapped = lines.flatMap((s) => String(s).match(/.{1,90}/g) || [""]),
    pages = [];
  for (let i = 0; i < wrapped.length; i += 45)
    pages.push(wrapped.slice(i, i + 45));
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
      page
        .map((l, i) => (i ? "T* " : "") + "(" + clean(l) + ") Tj")
        .join("\n") +
      " ET";
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
