// Render index.html in headless Chromium with every network call faked, click
// through Load recipes -> Scan the market, and read the result out of the DOM.
// The point is to check what the page actually shows, not what the code says.
const { chromium } = require("playwright");
const path = require("path");
const { pathToFileURL } = require("url");

// index.html and the screenshot both sit beside this script, whatever the OS.
const PAGE = pathToFileURL(path.join(__dirname, "index.html")).href;
const SHOT = path.join(__dirname, "verify.png");

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// One craftable furnishing, one material it needs. Prices are chosen so every
// changed behaviour has something to bite on.
const mkRecipe = (rid, iid, name, cat, ingId, ingName, qty, canHq) => ({
  row_id: rid,
  fields: {
    ItemResult: { row_id: iid, fields: { Name: name, IsUntradable: false, CanBeHq: !!canHq,
                  ItemUICategory: { fields: { Name: cat } } } },
    AmountResult: 1,
    AmountIngredient: [qty, 0, 0, 0, 0, 0, 0, 0],
    Ingredient: [{ row_id: ingId, fields: { Name: ingName } }],
    RecipeLevelTable: 40,
    CraftType: { fields: { Name: "Carpenter" } }
  }
});

const RECIPES = [
  // 1. own-retainer exclusion, stale supply, 40-sale window
  mkRecipe(1, 9001, "Test Wall", "Interior Wall", 9002, "Test Plank", 2),
  // 2. cheapest rival sits BELOW the median, so the never-tie rule must bind
  mkRecipe(2, 9003, "Test Rug", "Rug", 9002, "Test Plank", 2),
  // 3. its material has no sales at all. Since v09.13.26.1 that means it is
  //    costed at zero and the row is tagged "material unpriced"; the recipe
  //    below is no longer used as a cost fallback, only for the raw-materials tab.
  mkRecipe(4, 9005, "Test Lamp", "Table", 9004, "Test Ore", 2),
  mkRecipe(5, 9004, "Test Ore", "Metal", 9002, "Test Plank", 3),
  // 4. can be HQ. NQ sells at 30,000, HQ at 50,000, one listing of each. With
  //    the box off it must price and count on NQ; with it on, on HQ. Its
  //    material (Test Plank) must be unaffected either way.
  mkRecipe(6, 9006, "Test Ring", "Ring", 9002, "Test Plank", 1, true)
];

// Test Wall: 60 sales. The newest 40 sit at 80,000; the 20 oldest at 20,000.
// Median of all 60 = 80,000 only if the window is 40 -- over all 60 it is also
// 80,000, so make the old block big enough to move it: 45 old at 20,000.
const hist = [];
for (let i = 0; i < 40; i++) hist.push({ hq: false, pricePerUnit: 80000, quantity: 1, timestamp: NOW - i * 3600, buyerName: "New-" + i });
for (let i = 0; i < 45; i++) hist.push({ hq: false, pricePerUnit: 20000, quantity: 1, timestamp: NOW - 40 * 3600 - i * 7200, buyerName: "Old-" + i });
// The Rug's copy has its own buyers, so the one sale entered as Shaun's own
// below can only match the Wall's record, as a real sale could only match one item.
const rugHist = hist.map(h => ({ ...h, buyerName: "Rug-" + h.buyerName }));

// Incoming supply. The Wall's live reading is 3 days old; the tracker holds
// readings 30, 20 and 10 days back, and the rule must pick 20 (the most recent
// at least 14 days before the live one). At 20 days the board held Rival-one,
// one of Shaun's own, and Rival-junk at 500,000 — above twice the 80,000
// median, so not counted — so PreviousListings = 1. Live: Rival-one, Rival-two,
// his own again and Rival-junk at 999,999, so NewListings = 2. Sales between
// 20 and 3 days back: the 20,000 block aged 72h or more, i = 16..44, 29 sales;
// one of them (Old-20, 80 hours old, shown as 19,400 after 3% tax) is entered
// as his own below, so Purchases = 28 and
// inflow = (2 - 1 + 28) / (17 / 7) = 11.94 a week. If the junk cutoff failed
// on the live side that would read 12.35; on the tracker side, 11.53.
// The Rug has one reading 15 days back that found the board empty: 4 listed now,
// 85 sold since, inflow = 89 / (15 / 7) = 41.53 a week.
const ms = d => (NOW - d * DAY) * 1000;
const LISTINGS_CSV = [
  "lastUpload,itemId,listingID,retainerName,pricePerUnit,quantity,hq",
  ms(30) + ",9001,L1,Rival-one,95000,1,0",
  ms(30) + ",9001,L8,Rival-nine,95000,1,0",
  ms(20) + ",9001,L1,Rival-one,95000,1,0",
  ms(20) + ",9001,L9,Spicy-soy,90000,1,0",
  ms(20) + ",9001,L7,Rival-junk,500000,1,0",
  ms(10) + ",9001,L1,Rival-one,95000,1,0",
  ms(10) + ",9001,L2,Rival-two,99000,1,0",
  ms(15) + ",9003,,,0,0,0",
  ""
].join("\n");
const OWN_SALE = { price: "19400", qty: "1", buyer: "Old-20", t: NOW - 80 * 3600 };

const UNI = {
  9001: {
    lastUploadTime: (NOW - 3 * DAY) * 1000,          // deliberately 3 days old
    listings: [
      { pricePerUnit: 95000, quantity: 1, hq: false, retainerName: "Rival-one" },
      { pricePerUnit: 99000, quantity: 1, hq: false, retainerName: "Rival-two" },
      { pricePerUnit: 90000, quantity: 1, hq: false, retainerName: "Spicy-soy" },  // his own, must vanish
      { pricePerUnit: 999999, quantity: 1, hq: false, retainerName: "Rival-junk" } // overpriced: not supply, not inflow
    ],
    recentHistory: hist
  },
  9002: {
    lastUploadTime: NOW * 1000,
    listings: [{ pricePerUnit: 1000, quantity: 99, hq: false, retainerName: "Rival-three" }],
    recentHistory: [{ hq: false, pricePerUnit: 1000, quantity: 1, timestamp: NOW - 3600 }]
  },
  9003: {                                    // Test Rug: rival cheaper than the median
    lastUploadTime: NOW * 1000,
    listings: [{ pricePerUnit: 70000, quantity: 4, hq: false, retainerName: "Rival-four" }],
    recentHistory: rugHist
  },
  9004: {                                    // Test Ore: listed, but never sold
    lastUploadTime: NOW * 1000,
    listings: [{ pricePerUnit: 5000, quantity: 9, hq: false, retainerName: "Rival-five" }],
    recentHistory: []
  },
  9005: {
    lastUploadTime: NOW * 1000,
    listings: [{ pricePerUnit: 200000, quantity: 2, hq: false, retainerName: "Rival-six" }],
    recentHistory: hist
  },
  9006: {                                    // Test Ring: NQ at 30,000, HQ at 50,000
    lastUploadTime: NOW * 1000,
    listings: [
      { pricePerUnit: 30000, quantity: 1, hq: false, retainerName: "Rival-seven" },
      { pricePerUnit: 50000, quantity: 1, hq: true,  retainerName: "Rival-eight" }
    ],
    recentHistory: [...Array(40)].flatMap((_, i) => [
      { hq: false, pricePerUnit: 30000, quantity: 1, timestamp: NOW - i * 7200 },
      { hq: true,  pricePerUnit: 50000, quantity: 1, timestamp: NOW - i * 7200 - 3600 }
    ])
  }
};

// Universalis' hq=true returns only the HQ side of listings and history, and
// nothing at all for an item that cannot be HQ.
const hqOnly = it => ({ ...it,
  listings: it.listings.filter(l => l.hq),
  recentHistory: it.recentHistory.filter(h => h.hq) });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const seen = [];

  await page.route("**/*", async route => {
    const url = route.request().url();
    seen.push(url);
    const json = body => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

    if (url.includes("v2.xivapi.com/api/search")) {
      if (url.includes("sheets=Recipe")) return json({ results: RECIPES });
      return json({ results: [] });                       // GilShopItem etc.
    }
    if (url.includes("v2.xivapi.com/api/sheet")) return json({ rows: [] });
    // The tracker's listing history. The page asks for this month and last; the
    // same fixture answers both, and the page must not double-count a reading.
    if (url.includes("/data/listings-")) return route.fulfill({ status: 200, contentType: "text/csv", body: LISTINGS_CSV });
    if (url.includes("universalis.app")) {
      const ids = url.split("/").pop().split("?")[0].split(",").map(Number);
      const hq = url.includes("hq=true");
      const items = {};
      for (const id of ids) if (UNI[id]) items[id] = hq ? hqOnly(UNI[id]) : UNI[id];
      return json({ items });
    }
    return route.continue();
  });

  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto(PAGE);

  const stamp = await page.textContent(".stamp");
  const mineField = await page.inputValue("#mine");

  await page.click("#btnLoad");
  await page.waitForSelector("#btnScan:not([disabled])", { timeout: 20000 });
  // The Test Ring is gear, which the page does not tick by default.
  await page.check('#groups label[data-group="All"] input');

  // One of Shaun's own sales, as the Sale History window would show it.
  await page.click("#btnAddSale");
  await page.fill('#ownSalesBody tr:last-child [data-f="price"]', OWN_SALE.price);
  await page.fill('#ownSalesBody tr:last-child [data-f="qty"]', OWN_SALE.qty);
  await page.fill('#ownSalesBody tr:last-child [data-f="buyer"]', OWN_SALE.buyer);
  const ownStamp = await page.evaluate(t => {
    const d = new Date(t * 1000), p = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }, OWN_SALE.t);
  await page.fill('#ownSalesBody tr:last-child [data-f="time"]', ownStamp);
  await page.dispatchEvent('#ownSalesBody tr:last-child [data-f="time"]', "change");
  const ownSalesStatus = await page.textContent("#ownSalesStatus");

  // Two scans: HQ only off, then on. Only the Test Ring should change.
  const readOut = async () => {
    const status = await page.textContent("#status");
    const statusClass = await page.getAttribute("#status", "class");
    const tags = await page.$$eval("#out .tag", ns => ns.map(n => n.textContent.trim() + " || " + (n.getAttribute("title") || "")));
    const grab = () => page.$$eval("#out table tr", rows => rows.map(r =>
      [...r.querySelectorAll("th,td")].map(c => c.textContent.replace(/\s+/g," ").trim().slice(0,60))));
    const rows = await grab();
    // The Supply cell's tooltip carries the shortage arithmetic.
    const supplyTips = await page.$$eval("#out td[title*='should be filled']", tds => tds.map(t => t.getAttribute("title")));
    await page.click('#out .tabs button[data-tab="all"]');
    const allRows = await grab();
    await page.click('#out .tabs button[data-tab="pf"]');
    return { status, statusClass, tags, rows, supplyTips, allRows };
  };
  const scan = async () => {
    await page.evaluate(() => { document.getElementById("status").textContent = ""; });
    await page.click("#btnScan");
    await page.waitForFunction(() => /passed the filters/.test(document.getElementById("status").textContent),
                               null, { timeout: 30000 });
    return readOut();
  };

  const nq = await scan();
  await page.check("#hqonly");
  const hq = await scan();

  console.log("version stamp      :", stamp);
  console.log("own-retainer field :", JSON.stringify(mineField));
  console.log("own sales entered  :", JSON.stringify(ownSalesStatus));
  for (const [label, r] of [["HQ only OFF", nq], ["HQ only ON", hq]]) {
    console.log("\n=== " + label + " ===");
    console.log("status class       :", r.statusClass);
    console.log("status text        :", r.status);
    console.log("rows               :", JSON.stringify(r.rows, null, 1));
    console.log("supply tooltips    :");
    for (const t of r.supplyTips) console.log("   -", t);
    console.log("all-items rows     :", JSON.stringify(r.allRows));
    console.log("tags rendered      :");
    for (const t of r.tags) console.log("   -", t);
  }
  console.log("\npage errors        :", errors.length ? errors : "none");

  await page.screenshot({ path: SHOT, fullPage: true });
  await browser.close();
})();