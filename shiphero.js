// Pink Lily Receive & Sort — ShipHero proxy (Netlify Function)
//
// The browser never sees a ShipHero token. This function holds the refresh
// token (env SHIPHERO_REFRESH_TOKEN), mints short-lived access tokens, and
// exposes ONLY these actions:
//   openPOs         — page through open (pending) POs with their lines, for preloading
//   getPO           — read a purchase order + its line items
//   getLocation     — resolve a scanned location name to a ShipHero location
//   addInventory    — inventory_add one SKU into a location (reason must be a PL Receiving tag)
//   findChange      — look up a tagged inventory change (makes retries safe)
//   receive         — add quantity_received to PO lines (purchase_order_update)
//
// Env vars (Netlify → Site settings → Environment variables):
//   SHIPHERO_REFRESH_TOKEN  required
//   APP_PIN                 strongly recommended; receivers enter it once per device
//   DEFAULT_LOCATION        optional; location every PO starts on (default "Receiving")
//   OPEN_PO_DAYS            optional; how far back the startup pull of open POs looks (default 180)
//   SHIPHERO_API_URL        optional override (used for testing)
//   SHIPHERO_REFRESH_URL    optional override (used for testing)

const API_URL = process.env.SHIPHERO_API_URL || "https://public-api.shiphero.com/graphql";
const REFRESH_URL = process.env.SHIPHERO_REFRESH_URL || "https://public-api.shiphero.com/auth/refresh";
const MAX_QTY_PER_LINE = 100000;
const MAX_LINES_PER_CALL = 500;

let cachedToken = null; // { token, expiresAt }

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

async function getAccessToken(force = false) {
  if (!force && cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  const refresh = process.env.SHIPHERO_REFRESH_TOKEN;
  if (!refresh) throw new Error("Server is missing SHIPHERO_REFRESH_TOKEN.");
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`ShipHero token refresh failed (HTTP ${res.status}).`);
  }
  const ttl = Number(body.expires_in) || 3600;
  cachedToken = { token: body.access_token, expiresAt: Date.now() + (ttl - 300) * 1000 };
  return cachedToken.token;
}

async function gql(query, variables, retried = false) {
  const token = await getAccessToken();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 && !retried) {
    cachedToken = null;
    return gql(query, variables, true);
  }
  if (res.status === 429) throw new Error("ShipHero rate limit hit. Wait a minute and try again.");
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`ShipHero returned HTTP ${res.status} with no JSON.`);
  if (body.errors && body.errors.length) {
    const e = body.errors[0];
    const code = e.code != null ? ` (code ${e.code})` : "";
    const wait = e.time_remaining ? ` Retry in ${e.time_remaining}.` : "";
    const rid = e.request_id ? ` request_id ${e.request_id}` : "";
    const err = new Error(`${e.message || "ShipHero error"}${code}.${wait}${rid}`.trim());
    err.code = e.code;
    throw err;
  }
  return body.data;
}

const LINE_FIELDS = `
  pageInfo { hasNextPage endCursor }
  edges { node { sku quantity quantity_received quantity_rejected product_name option_title barcode vendor_sku fulfillment_status note product { product { dimensions { weight height width length } } } } }`;

// Build the query with only the argument we have: ShipHero rejects an explicit
// `id: null` with "Invalid id" (code 3).
const poQuery = (by) => `
query GetPO($key: String!, $after: String) {
  purchase_order(${by}: $key) {
    request_id complexity
    data {
      id po_number fulfillment_status po_date warehouse_id packing_note
      vendor { name }
      warehouse { identifier }
      line_items(first: 250, after: $after) { ${LINE_FIELDS} }
    }
  }
}`;

function needsFAI(l) {
  const d = l.product && l.product.product && l.product.product.dimensions;
  if (!d) return false; // product not resolvable → don't block
  return ["weight", "length", "width", "height"].some((k) => !(parseFloat(d[k]) > 0));
}

function mapPO(po, lines) {
  return {
    id: po.id,
    po_number: po.po_number,
    status: po.fulfillment_status,
    po_date: po.po_date,
    vendor: po.vendor && po.vendor.name,
    warehouse: po.warehouse && po.warehouse.identifier,
    warehouse_id: po.warehouse_id,
    // packing_note containing "priority"/"push" = floor flag (same rule as the PO Sort app)
    priority: /priorit|push/i.test(po.packing_note || ""),
    lines: lines.map((l) => ({
      sku: l.sku,
      name: [l.product_name, l.option_title].filter(Boolean).join(" — "),
      option_title: l.option_title || "",
      ordered: l.quantity || 0,
      received: l.quantity_received || 0,
      rejected: l.quantity_rejected || 0,
      barcode: l.barcode || "",
      vendor_sku: l.vendor_sku || "",
      note: l.note || "",
      // ShipHero flags First Article Inspection (FAI) when the product has no weight/dimensions yet
      fai: needsFAI(l),
    })),
  };
}

async function fetchPO({ po_number, id }) {
  let after = null;
  let po = null;
  const lines = [];
  for (let page = 0; page < 40; page++) {
    const data = id
      ? await gql(poQuery("id"), { key: id, after })
      : await gql(poQuery("po_number"), { key: po_number, after });
    const d = data && data.purchase_order && data.purchase_order.data;
    if (!d) return null;
    if (!po) po = d;
    for (const e of d.line_items.edges) lines.push(e.node);
    if (!d.line_items.pageInfo.hasNextPage) break;
    after = d.line_items.pageInfo.endCursor;
    id = d.id;
  }
  return mapPO(po, lines);
}



const OPEN_POS_QUERY = `
query OpenPOs($from: ISODateTime, $after: String) {
  purchase_orders(fulfillment_status: "pending", created_from: $from) {
    request_id complexity
    data(first: 15, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id po_number fulfillment_status po_date warehouse_id created_at packing_note
        vendor { name }
        warehouse { identifier }
        line_items(first: 100) { ${LINE_FIELDS} }
      } }
    }
  }
}`;

const LOCATION_QUERY = `
query Loc($name: String!, $wh: String) {
  locations(name: $name, warehouse_id: $wh) {
    request_id complexity
    data(first: 10) { edges { node { id name warehouse_id zone pickable sellable } } }
  }
}`;

const INVENTORY_ADD = `
mutation Add($data: UpdateInventoryInput!) {
  inventory_add(data: $data) {
    request_id complexity
    warehouse_product { sku on_hand }
  }
}`;

const CHANGES_QUERY = `
query Changes($sku: String!, $wh: String, $reason: String!, $from: ISODateTime!, $to: ISODateTime!) {
  inventory_changes(sku: $sku, warehouse_id: $wh, reason: $reason, date_from: $from, date_to: $to) {
    request_id complexity
    data(first: 20) { edges { node { sku change_in_on_hand reason location_id created_at } } }
  }
}`;

// Every inventory_add reason must look like "PL Receiving · … [PLR-xxxx.n] …"
const REASON_RE = /^PL Receiving · .{1,150}\[PLR-[a-z0-9]{6,24}\.\d{1,4}\]/;
const TAG_RE = /^\[PLR-[a-z0-9]{6,24}\.\d{1,4}\]$/;

const RECEIVE_MUTATION = `
mutation Receive($data: UpdatePurchaseOrderInput!) {
  purchase_order_update(data: $data) {
    request_id complexity
    purchase_order { id po_number }
  }
}`;

function cleanStr(v, max = 120) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const pin = process.env.APP_PIN;
  if (pin && (event.headers["x-app-pin"] || "") !== pin) {
    return json(401, { error: "Wrong or missing app PIN." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Bad JSON" });
  }

  try {
    if (body.action === "ping") {
      return json(200, { ok: true, default_location: process.env.DEFAULT_LOCATION || "Receiving" });
    }

    if (body.action === "getPO") {
      const po_number = cleanStr(body.po_number);
      const id = cleanStr(body.id);
      if (!po_number && !id) return json(400, { error: "PO number required." });
      let po = null;
      try {
        po = await fetchPO({ po_number, id });
      } catch (e) {
        if (e.code !== 5) throw e; // 5 = Not Found
      }
      if (!po) return json(404, { error: `PO ${po_number || id} not found in ShipHero.` });
      return json(200, { po });
    }



    if (body.action === "openPOs") {
      const days = Math.min(Math.max(parseInt(process.env.OPEN_PO_DAYS || "180", 10) || 180, 7), 730);
      const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 19);
      const after = cleanStr(body.after, 200) || null;
      const data = await gql(OPEN_POS_QUERY, { from, after });
      const conn = data && data.purchase_orders && data.purchase_orders.data;
      if (!conn) return json(200, { pos: [], next: null });
      const pos = conn.edges.map((e) => e.node).filter((n) => n.po_number).map((n) => {
        const po = mapPO(n, n.line_items.edges.map((x) => x.node));
        po.complete = !n.line_items.pageInfo.hasNextPage; // false → more than 100 lines, fetch fully on scan
        return po;
      });
      return json(200, { pos, next: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null, days });
    }

    if (body.action === "getLocation") {
      const name = cleanStr(body.name, 80);
      const wh = cleanStr(body.warehouse_id, 80) || null;
      if (!name) return json(400, { error: "Location required." });
      const data = await gql(LOCATION_QUERY, { name, wh });
      const edges = (data && data.locations && data.locations.data && data.locations.data.edges) || [];
      const hit = edges.map((e) => e.node).find((n) => n.name.toUpperCase() === name.toUpperCase() && (!wh || n.warehouse_id === wh));
      if (!hit) return json(404, { error: `Location ${name} not found${wh ? " in this PO's warehouse" : ""}.` });
      return json(200, { location: hit });
    }

    if (body.action === "addInventory") {
      const sku = cleanStr(body.sku);
      const warehouse_id = cleanStr(body.warehouse_id, 80);
      const location_id = cleanStr(body.location_id, 80);
      const reason = cleanStr(body.reason, 200);
      const quantity = Number(body.quantity);
      if (!sku || !warehouse_id || !location_id) return json(400, { error: "sku, warehouse_id and location_id are required." });
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY_PER_LINE) return json(400, { error: "Invalid quantity." });
      if (!REASON_RE.test(reason)) return json(400, { error: "Invalid reason tag." });
      const data = await gql(INVENTORY_ADD, { data: { sku, warehouse_id, location_id, quantity, reason } });
      const out = data && data.inventory_add;
      if (!out) throw new Error("ShipHero returned no result for inventory_add.");
      return json(200, { ok: true, request_id: out.request_id, on_hand: out.warehouse_product && out.warehouse_product.on_hand });
    }

    if (body.action === "findChange") {
      const sku = cleanStr(body.sku);
      const tag = cleanStr(body.tag, 40);
      const wh = cleanStr(body.warehouse_id, 80) || null;
      const since = new Date(Number(body.since) || 0);
      if (!sku || !TAG_RE.test(tag) || isNaN(since)) return json(400, { error: "sku, tag and since required." });
      const from = new Date(Math.max(since.getTime() - 10 * 60e3, Date.now() - 59 * 864e5));
      const data = await gql(CHANGES_QUERY, { sku, wh, reason: tag, from: from.toISOString().slice(0, 19), to: new Date(Date.now() + 10 * 60e3).toISOString().slice(0, 19) });
      const edges = (data && data.inventory_changes && data.inventory_changes.data && data.inventory_changes.data.edges) || [];
      const hits = edges.map((e) => e.node).filter((n) => (n.reason || "").includes(tag));
      return json(200, { found: hits.length, change: hits.reduce((a, n) => a + (n.change_in_on_hand || 0), 0) });
    }

    if (body.action === "receive") {
      const po_id = cleanStr(body.po_id);
      if (!po_id) return json(400, { error: "po_id required." });
      const raw = Array.isArray(body.line_items) ? body.line_items : [];
      if (!raw.length) return json(400, { error: "No lines to receive." });
      if (raw.length > MAX_LINES_PER_CALL) return json(400, { error: "Too many lines in one call." });
      const line_items = [];
      for (const l of raw) {
        const sku = cleanStr(l.sku);
        const q = Number(l.quantity_received);
        if (!sku || !Number.isInteger(q) || q < 1 || q > MAX_QTY_PER_LINE) {
          return json(400, { error: `Invalid line: ${JSON.stringify(l).slice(0, 100)}` });
        }
        const li = { sku, quantity_received: q };
        // optional receiving log line appended (client-side) to the PO line's note
        if (typeof l.note === "string") li.note = l.note.slice(0, 2000);
        line_items.push(li);
      }
      // quantity_received is ADDITIVE in ShipHero — each call adds to the existing total.
      const data = await gql(RECEIVE_MUTATION, { data: { po_id, line_items } });
      const out = data && data.purchase_order_update;
      if (!out) throw new Error("ShipHero returned no result for purchase_order_update.");
      return json(200, { ok: true, request_id: out.request_id });
    }

    return json(400, { error: "Unknown action." });
  } catch (err) {
    if (err.code === 30) {
      const m = /(\d+)\s*(second|minute)/i.exec(err.message || "");
      const secs = m ? parseInt(m[1], 10) * (/minute/i.test(m[2]) ? 60 : 1) : 5;
      return json(429, { error: "ShipHero is busy (credit limit). Retrying shortly.", retry_after: secs });
    }
    return json(502, { error: err.message || String(err) });
  }
};
