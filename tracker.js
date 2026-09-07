#!/usr/bin/env node
/*
 * FFXIV market tracker
 *
 * Runs once a day on GitHub's machines and records what the market board looked
 * like. Universalis does not keep a history of what was LISTED — only what sold —
 * so this builds the record nobody currently has.
 *
 * Writes two things, and the split matters:
 *
 *   data/stock-YYYY-MM.csv   one row per item per day: what was on the board
 *   data/sales-YYYY-MM.csv   one row per observed sale, deduplicated
 *
 * Sales are stored as raw facts rather than daily totals, so any rate over any
 * window can be worked out later without re-fetching. Every summary figure this
 * project has trusted from an API has turned out to depend on how the question
 * was asked; raw records do not have that problem.
 */

const WORLD     = process.env.WORLD || "Seraph";
const MAX_LEVEL = +(process.env.MAX_LEVEL || 50);
const SALES_WINDOW_H = 48;      // overlaps the daily gap generously; duplicates are removed

const fs = require("fs");
const path = require("path");

const XIV = "https://v2.xivapi.com/api";
const UNI = "https://universalis.app/api/v2";

// Housing and furnishing categories, matched loosely against the game's own names.
const HOUSING = /furnish|table|chair|bed|rug|wall|floor|garden|outdoor|exterior|fence|roof|window|door|partition|stage|placard|orchestrion/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function getJSON(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "ffxiv-craft-planner-tracker" } });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
      return await r.json();
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(800 * Math.pow(2, i));
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// Which items to watch. Fetched fresh each run rather than kept in a file, so a
// patch that adds furnishings is picked up without anyone editing a list.
// ---------------------------------------------------------------------------
async function watchList() {
  const fields = ["ItemResult.Name", "ItemResult.IsUntradable",
                  "ItemResult.ItemUICategory.Name", "RecipeLevelTable"].join(",");
  let url = `${XIV}/search?sheets=Recipe&query=${encodeURIComponent("RecipeLevelTable<=" + MAX_LEVEL)}` +
            `&fields=${encodeURIComponent(fields)}&limit=500`;
  const seen = new Map();
  for (let page = 0; page < 25; page++) {
    const d = await getJSON(url);
    for (const r of d.results || []) {
      const f = r.fields || {}, it = f.ItemResult;
      const id = it?.row_id ?? it?.value ?? 0;
      const name = it?.fields?.Name || "";
      const cat = it?.fields?.ItemUICategory?.fields?.Name || "";
      if (!id || !name || it?.fields?.IsUntradable) continue;
      if (!HOUSING.test(cat)) continue;
      if (!seen.has(id)) seen.set(id, { id, name, cat });
    }
    if (!d.next) break;
    url = `${XIV}/search?cursor=${encodeURIComponent(d.next)}&fields=${encodeURIComponent(fields)}&limit=500`;
  }
  return [...seen.values()].sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------
// CSV helpers. Hand-rolled because the data is simple and a dependency-free
// script needs no install step on the runner.
// ---------------------------------------------------------------------------
const esc = v => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const row = arr => arr.map(esc).join(",");

function appendCsv(file, header, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fresh = !fs.existsSync(file);
  const body = rows.map(row).join("\n");
  fs.appendFileSync(file, (fresh ? row(header) + "\n" : "") + body + (body ? "\n" : ""));
}

// Existing sale keys for this month, so a 48h window overlapping yesterday's run
// does not record the same sale twice.
function existingSaleKeys(file) {
  const keys = new Set();
  if (!fs.existsSync(file)) return keys;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    if (p.length >= 4) keys.add(`${p[0]}|${p[1]}|${p[2]}|${p[3]}`);
  }
  return keys;
}

// ---------------------------------------------------------------------------

async function main() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);

  console.log(`tracker: ${WORLD}, recipes at level ${MAX_LEVEL} or below, ${day}`);

  const items = await watchList();
  console.log(`watching ${items.length} furnishing items`);
  if (!items.length) throw new Error("watch list came back empty — refusing to write");

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/items.csv",
    row(["itemId", "name", "category"]) + "\n" +
    items.map(i => row([i.id, i.name, i.cat])).join("\n") + "\n");

  const stockFile = `data/stock-${month}.csv`;
  const salesFile = `data/sales-${month}.csv`;
  const known = existingSaleKeys(salesFile);

  const stockRows = [], saleRows = [];
  let fetched = 0, failed = 0, newSales = 0;

  for (const batch of chunk(items, 40)) {
    const ids = batch.map(i => i.id).join(",");
    try {
      // Listings tell us the stock; history tells us what moved. Asked for
      // together so both describe the same moment.
      const [board, hist] = await Promise.all([
        getJSON(`${UNI}/${encodeURIComponent(WORLD)}/${ids}?listings=100&entries=0`),
        getJSON(`${UNI}/history/${encodeURIComponent(WORLD)}/${ids}?entriesWithin=${SALES_WINDOW_H * 3600}&entriesToReturn=999`)
      ]);

      const boardItems = board.items || {};
      const histItems  = hist.items  || {};

      for (const it of batch) {
        const b = boardItems[it.id];
        if (!b) { failed++; continue; }

        const listings = (b.listings || []).filter(l => !l.hq);
        const units    = listings.reduce((a, l) => a + (l.quantity || 1), 0);
        const sellers  = new Set(listings.map(l => l.retainerName).filter(Boolean)).size;
        const prices   = listings.map(l => l.pricePerUnit).filter(p => p > 0).sort((a, b) => a - b);

        stockRows.push([
          day, it.id, units, listings.length, sellers,
          prices[0] || "", prices[prices.length - 1] || "",
          b.lastUploadTime || 0            // the check on whether this reading is fresh
        ]);
        fetched++;

        const h = histItems[it.id];
        for (const e of (h?.entries || [])) {
          const key = `${e.timestamp}|${it.id}|${e.pricePerUnit}|${e.quantity}`;
          if (known.has(key)) continue;
          known.add(key);
          saleRows.push([e.timestamp, it.id, e.pricePerUnit, e.quantity, e.hq ? 1 : 0]);
          newSales++;
        }
      }
    } catch (e) {
      failed += batch.length;
      console.log(`  batch failed (${batch.length} items): ${e.message}`);
    }
    await sleep(250);
  }

  // A run that got almost nothing is more likely a broken API than a dead market.
  // Better to write nothing than to record a day of phantom zeroes.
  if (fetched < items.length * 0.5) {
    throw new Error(`only ${fetched}/${items.length} items priced — refusing to write a bad day`);
  }

  appendCsv(stockFile,
    ["date", "itemId", "unitsListed", "listings", "sellers", "minPrice", "maxPrice", "lastUpload"],
    stockRows);

  if (saleRows.length) {
    saleRows.sort((a, b) => a[0] - b[0]);
    appendCsv(salesFile, ["timestamp", "itemId", "pricePerUnit", "quantity", "hq"], saleRows);
  }

  console.log(`wrote ${stockRows.length} stock rows, ${newSales} new sales, ${failed} items missed`);
}

main().catch(e => { console.error("tracker failed:", e.message); process.exit(1); });
