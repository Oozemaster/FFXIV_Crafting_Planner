#!/usr/bin/env node
/*
 * FFXIV market tracker
 *
 * Runs once a day on GitHub's machines and records what the market board looked
 * like. Universalis does not keep a history of what was LISTED — only what sold —
 * so this builds the record nobody currently has.
 *
 * Writes two things:
 *
 *   data/stock-YYYY-MM.csv      one row per item per day: totals for the board
 *   data/listings-YYYY-MM.csv   one row per listing, written only when an item's
 *                               reading is new — see below
 *
 * Sales are not recorded here. Universalis keeps roughly 200 weeks of them per
 * item, and the planner reads them live at scan time, so a copy would only fall
 * behind (its 48-hour window missed 4 of Shaun's 11 September sales, because a
 * sale reaches Universalis only when somebody next views the item).
 *
 * The tracker knows nothing about whose retainers are whose. The listing rows
 * carry the retainer name and the planner applies the user's own names when it
 * reads them, so the same files serve anyone.
 */

const WORLD     = process.env.WORLD || "Seraph";
const MAX_LEVEL = +(process.env.MAX_LEVEL || 50);

const fs = require("fs");
const path = require("path");

const XIV = "https://v2.xivapi.com/api";
const UNI = "https://universalis.app/api/v2";

// Housing and furnishing categories, matched loosely against the game's own names.
// Must stay identical to the Furnishings group in index.html, or the tracker
// watches a different set of items from the one the planner recommends. Until
// 2026-09-13 this copy lacked `ceiling|lamp|light` and never recorded the ten
// Ceiling Light recipes.
const HOUSING = /furnish|table|chair|bed|rug|wall|floor|garden|outdoor|exterior|fence|roof|window|door|partition|stage|placard|orchestrion|ceiling|lamp|light/i;

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

// ---------------------------------------------------------------------------
// Listings file
//
// Universalis only updates an item when a player with the uploader opens it,
// so most days most items come back unchanged: 62% to 84% per day over the
// first week. A reading is identified by the item and its upload time, and the
// listings are written once per reading, the first time the tracker sees it.
// A day on which nothing changed adds nothing.
//
// The planner's IncomingSupply needs the listings as they stood at a reading
// at least two weeks back — every listing, whoever posted it, at whatever
// price — to set against the board as it stands now. That is all this file is.
//
// A reading that found the board empty still has to be on record, or the
// planner could not tell "nobody had this listed" from "never read". It gets
// one marker row with no listing in it: blank listingID, quantity 0.
// ---------------------------------------------------------------------------
const LISTING_HEADER = ["lastUpload", "itemId", "listingID", "retainerName", "pricePerUnit", "quantity", "hq"];

const listingsFile = month => `data/listings-${month}.csv`;

// Every (item, upload time) already written, from this month's file and last
// month's, so a reading that straddles the month boundary is not written twice.
function recordedReadings(month) {
  const keys = new Set();
  const [y, m] = month.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  for (const file of [listingsFile(prev), listingsFile(month)]) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    // The first two columns are numbers and never quoted, so a plain split is safe.
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split(",");
      if (p.length >= 2 && p[0] && p[1]) keys.add(`${p[1]}|${p[0]}`);
    }
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
  const recorded = recordedReadings(month);

  const stockRows = [], listingRows = [];
  let fetched = 0, failed = 0, newReadings = 0, emptyReadings = 0;

  for (const batch of chunk(items, 40)) {
    const ids = batch.map(i => i.id).join(",");
    try {
      // entries=1, not 0: with no sale entries requested, Universalis reports an
      // empty board as lastUploadTime 0, indistinguishable from an item nobody has
      // ever uploaded. Measured 2026-09-14 on Riviera Wardrobe: entries=0 gave 0,
      // entries=1 gave the real time. The first eight days of stock rows carry
      // that defect: 425 of 3,114 rows read lastUpload 0, every one an empty board.
      const board = await getJSON(`${UNI}/${encodeURIComponent(WORLD)}/${ids}?listings=100&entries=1`);
      const boardItems = board.items || {};

      for (const it of batch) {
        const b = boardItems[it.id];
        if (!b) { failed++; continue; }
        const upload = b.lastUploadTime || 0;
        const all = b.listings || [];

        // Stock totals stay as they always were: normal quality only, so the
        // eight days recorded before the listings file began remain comparable.
        const nq       = all.filter(l => !l.hq);
        const units    = nq.reduce((a, l) => a + (l.quantity || 1), 0);
        const sellers  = new Set(nq.map(l => l.retainerName).filter(Boolean)).size;
        const prices   = nq.map(l => l.pricePerUnit).filter(p => p > 0).sort((a, b) => a - b);

        stockRows.push([
          day, it.id, units, nq.length, sellers,
          prices[0] || "", prices[prices.length - 1] || "",
          upload                          // the check on whether this reading is fresh
        ]);
        fetched++;

        // The listings themselves, once per reading. No upload time means no
        // player has ever opened this item with the uploader running; there is
        // no reading to record.
        if (!upload || recorded.has(`${it.id}|${upload}`)) continue;
        recorded.add(`${it.id}|${upload}`);
        newReadings++;
        if (!all.length) {
          emptyReadings++;
          listingRows.push([upload, it.id, "", "", 0, 0, 0]);
          continue;
        }
        for (const l of all) {
          listingRows.push([upload, it.id, l.listingID || "", l.retainerName || "",
                            l.pricePerUnit, l.quantity || 1, l.hq ? 1 : 0]);
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
    throw new Error(`only ${fetched}/${items.length} items read — refusing to write a bad day`);
  }

  appendCsv(stockFile,
    ["date", "itemId", "unitsListed", "listings", "sellers", "minPrice", "maxPrice", "lastUpload"],
    stockRows);

  if (listingRows.length) appendCsv(listingsFile(month), LISTING_HEADER, listingRows);

  console.log(`wrote ${stockRows.length} stock rows; ${newReadings} new readings ` +
              `(${emptyReadings} with an empty board), ${listingRows.length} listing rows; ${failed} items missed`);
}

main().catch(e => { console.error("tracker failed:", e.message); process.exit(1); });
