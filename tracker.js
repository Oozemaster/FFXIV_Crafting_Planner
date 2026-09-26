#!/usr/bin/env node
/*
 * FFXIV market tracker
 *
 * Runs once a day on GitHub's machines and records what the market board looked
 * like. Universalis does not keep a history of what was LISTED — only what sold —
 * so this builds the record nobody currently has.
 *
 * Since 2026-09-26 it writes to the repository's `data` branch, not to main, into
 * the folder named by DATA_DIR (the workflow checks that branch out there):
 *
 *   items.csv                  the watch list: itemId, name, category
 *   archive/YYYY-MM-DD.csv.gz  every listing of every reading first seen that
 *                              day, gzipped; deleted after RETAIN_DAYS
 *   prev.csv.gz                the few readings per item the planner needs for
 *                              incoming supply (see below) — the only file the
 *                              page downloads
 *
 * The workflow then commits the folder as a single commit with no parent and
 * force-pushes it over the branch, so days that have been deleted leave nothing
 * behind in git history and the branch is never larger than RETAIN_DAYS of data.
 *
 * Sales are not recorded here. Universalis keeps roughly 200 weeks of them per
 * item, and the planner reads them live at scan time. The stock file (daily
 * totals per item) stopped on 2026-09-26: nothing read it, and every column is
 * derivable from the listings. Its rows to 2026-09-25 are in main's history.
 *
 * The tracker knows nothing about whose retainers are whose. The listing rows
 * carry the retainer name and the planner applies the user's own names when it
 * reads them, so the same files serve anyone.
 */

const WORLD       = process.env.WORLD || "Seraph";
const DIR         = process.env.DATA_DIR || "store";
const RETAIN_DAYS = 183;   // Shaun, 2026-09-25: drop everything after six months
const INFLOW_DAYS = 14;    // the planner's gap between readings (index.html)
const SLACK_DAYS  = 3;     // how far a scan's live board may run ahead of the last run

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const XIV = "https://v2.xivapi.com/api";
const UNI = "https://universalis.app/api/v2";
const DAY = 86400000;

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
// Which items to watch: whatever the planner can put in a bundle (Shaun,
// 2026-09-25) — every tradeable recipe result at any level, stars included —
// cut to what Universalis lists as marketable. Gatherables and fish were in it
// for one day; Shaun dropped them from the planner on 2026-09-26 ("This is a
// *crafting* planner"). Until 2026-09-25 it was the furnishing recipes at level
// 50 and under, 398 items. Fetched fresh each run, so a patch's new items are picked
// up by themselves.
// ---------------------------------------------------------------------------
const linkId = v => (v && typeof v === "object") ? (v.row_id ?? v.value ?? 0) : (v ?? 0);

async function search(sheet, query, fields, onRow) {
  let url = `${XIV}/search?sheets=${sheet}&query=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}&limit=500`;
  for (let page = 0; page < 60; page++) {
    const d = await getJSON(url);
    for (const r of d.results || []) onRow(r.fields || {});
    if (!d.next) break;
    url = `${XIV}/search?cursor=${encodeURIComponent(d.next)}&fields=${encodeURIComponent(fields)}&limit=500`;
  }
}

async function watchList() {
  const marketable = new Set(await getJSON(`${UNI}/marketable`));
  const seen = new Map();
  const add = (it, why) => {
    const id = linkId(it);
    if (!id || !marketable.has(id) || seen.has(id)) return;
    seen.set(id, { id, name: it?.fields?.Name || "", cat: it?.fields?.ItemUICategory?.fields?.Name || why });
  };
  await search("Recipe", "RecipeLevelTable.ClassJobLevel>=0", "ItemResult.Name,ItemResult.ItemUICategory.Name",
               f => add(f.ItemResult, "Recipe"));
  // Duty items (2026-09-26): the planner's own list, read from the one line of
  // index.html that holds it, so there is a single copy.
  const page = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const m = page.match(/^const DUTY_ITEMS = (\[.*\]);$/m);
  if (!m) throw new Error("DUTY_ITEMS not found in index.html");
  for (const [id, name] of JSON.parse(m[1]))
    add({ row_id: id, fields: { Name: name, ItemUICategory: { fields: { Name: "Duty item" } } } }, "Duty item");
  return [...seen.values()].sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------
// CSV. Hand-rolled because the data is simple and a dependency-free script
// needs no install step on the runner.
// ---------------------------------------------------------------------------
const esc = v => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const row = arr => arr.map(esc).join(",");
const LISTING_HEADER = ["lastUpload", "itemId", "listingID", "retainerName", "pricePerUnit", "quantity", "hq"];

const readGz = file => zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
const writeGz = (file, lines) =>
  fs.writeFileSync(file, zlib.gzipSync(row(LISTING_HEADER) + "\n" + lines.join("\n") + (lines.length ? "\n" : ""), { level: 9 }));
// The first two columns are numbers and never quoted, so a plain split is safe.
const keyOf = line => { const p = line.split(",", 2); return p[1] + "|" + p[0]; };

// ---------------------------------------------------------------------------
// The archive: one gzipped file per day of the readings first seen that day,
// in the listings format the planner has read since 2026-09-15. A reading is
// one item at one Universalis upload time; it is written once, the first time
// the tracker sees it, so a day on which nothing was refreshed adds nothing.
// A reading that found the board empty is one marker row: blank listingID,
// quantity 0, so "nobody had this listed" differs from "never read".
// ---------------------------------------------------------------------------
const ARCHIVE = path.join(DIR, "archive");
const archiveFiles = () => fs.existsSync(ARCHIVE)
  ? fs.readdirSync(ARCHIVE).filter(f => /^\d{4}-\d{2}-\d{2}\.csv\.gz$/.test(f)).sort() : [];

// Every reading on record: item -> sorted upload times. Kept as numbers only;
// the rows themselves are read again for the few that prev.csv.gz needs.
function indexArchive() {
  const at = new Map();
  for (const f of archiveFiles()) {
    const lines = readGz(path.join(ARCHIVE, f)).split("\n");
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const [t, id] = lines[i].split(",", 2);
      let s = at.get(+id); if (!s) at.set(+id, s = new Set());
      s.add(+t);
    }
  }
  return at;
}

// ---------------------------------------------------------------------------
// prev.csv.gz — what the planner reads. For incoming supply it needs, per item,
// the most recent reading at least INFLOW_DAYS before the live board, or the
// oldest reading if none is that old. The live board at scan time is at least
// as new as the last reading here, and a scan normally runs within a day or two
// of this, so per item this keeps: the latest reading at least INFLOW_DAYS older
// than the item's newest one, every reading up to SLACK_DAYS after that point,
// and the oldest when nothing is old enough. A handful of readings per item
// instead of six months of them. The planner picks among them by its own rule.
// ---------------------------------------------------------------------------
function chooseReadings(times) {
  const ts = [...times].sort((a, b) => a - b), newest = ts[ts.length - 1];
  const cut = newest - INFLOW_DAYS * DAY;
  const old = ts.filter(t => t <= cut);
  const keep = new Set(ts.filter(t => t > cut && t <= cut + SLACK_DAYS * DAY));
  keep.add(old.length ? old[old.length - 1] : ts[0]);
  return keep;
}

// ---------------------------------------------------------------------------

async function main() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  console.log(`tracker: ${WORLD}, into ${DIR}, ${day}`);
  fs.mkdirSync(ARCHIVE, { recursive: true });

  const items = await watchList();
  console.log(`watching ${items.length} items`);
  if (items.length < 1000) throw new Error("watch list came back short — refusing to write");
  fs.writeFileSync(path.join(DIR, "items.csv"),
    row(["itemId", "name", "category"]) + "\n" + items.map(i => row([i.id, i.name, i.cat])).join("\n") + "\n");

  const known = indexArchive();
  const has = (id, t) => known.get(id)?.has(t);
  const fresh = [];
  let fetched = 0, newReadings = 0, emptyReadings = 0;

  const read = async batch => {
    // entries=1, not 0: with no sale entries requested, Universalis reports an
    // empty board as lastUploadTime 0 (measured 2026-09-14).
    const board = await getJSON(`${UNI}/${encodeURIComponent(WORLD)}/${batch.map(i => i.id).join(",")}?listings=100&entries=1`);
    for (const it of batch) {
      const b = (board.items || {})[it.id];
      if (!b) continue;
      fetched++;
      const upload = b.lastUploadTime || 0, all = b.listings || [];
      // No upload time: nobody has opened this item with the uploader running.
      if (!upload || has(it.id, upload)) continue;
      let s = known.get(it.id); if (!s) known.set(it.id, s = new Set());
      s.add(upload);
      newReadings++;
      if (!all.length) { emptyReadings++; fresh.push(row([upload, it.id, "", "", 0, 0, 0])); continue; }
      for (const l of all) fresh.push(row([upload, it.id, l.listingID || "", l.retainerName || "",
                                          l.pricePerUnit, l.quantity || 1, l.hq ? 1 : 0]));
    }
  };

  // A batch Universalis times out on is tried again at the end, once, after a
  // pause: on 2026-09-25 eight of 422 batches failed with HTTP 504.
  const failed = [];
  for (const batch of chunk(items, 40)) {
    try { await read(batch); } catch (e) { failed.push(batch); }
    await sleep(250);
  }
  let lost = 0;
  if (failed.length) {
    console.log(`  ${failed.length} batches failed; trying them again`);
    await sleep(10000);
    for (const batch of failed) {
      try { await read(batch); } catch (e) { lost += batch.length; console.log(`  batch lost (${batch.length} items): ${e.message}`); }
      await sleep(1000);
    }
  }

  // A run that got almost nothing is more likely a broken API than a dead market.
  if (fetched < items.length * 0.5) throw new Error(`only ${fetched}/${items.length} items read — refusing to write a bad day`);

  // Today's new readings, added to today's file if the tracker already ran today.
  const todayFile = path.join(ARCHIVE, day + ".csv.gz");
  const before = fs.existsSync(todayFile) ? readGz(todayFile).split("\n").slice(1).filter(Boolean) : [];
  if (before.length || fresh.length) writeGz(todayFile, before.concat(fresh));

  // Six months and no more.
  const oldest = new Date(now.getTime() - RETAIN_DAYS * DAY).toISOString().slice(0, 10);
  let dropped = 0;
  for (const f of archiveFiles()) if (f.slice(0, 10) < oldest) { fs.unlinkSync(path.join(ARCHIVE, f)); dropped++; }

  // prev.csv.gz from what remains.
  const want = new Set();
  for (const [id, times] of indexArchive()) for (const t of chooseReadings(times)) want.add(id + "|" + t);
  const prev = [];
  for (const f of archiveFiles())
    for (const line of readGz(path.join(ARCHIVE, f)).split("\n").slice(1))
      if (line && want.has(keyOf(line))) prev.push(line);
  writeGz(path.join(DIR, "prev.csv.gz"), prev);

  console.log(`read ${fetched} of ${items.length}; ${newReadings} new readings (${emptyReadings} empty boards), ` +
              `${fresh.length} listing rows; ${lost} items lost to failed requests; ` +
              `${dropped} archive days dropped; prev.csv.gz ${want.size} readings, ${prev.length} rows`);
}

if (require.main === module) main().catch(e => { console.error("tracker failed:", e.message); process.exit(1); });
module.exports = { chooseReadings };
