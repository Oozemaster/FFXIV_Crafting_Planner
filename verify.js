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
const mkRecipe = (rid, iid, name, cat, ingId, ingName, qty) => ({
  row_id: rid,
  fields: {
    ItemResult: { row_id: iid, fields: { Name: name, IsUntradable: false,
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
  mkRecipe(5, 9004, "Test Ore", "Metal", 9002, "Test Plank", 3)
];

// Test Wall: 60 sales. The newest 40 sit at 80,000; the 20 oldest at 20,000.
// Median of all 60 = 80,000 only if the window is 40 -- over all 60 it is also
// 80,000, so make the old block big enough to move it: 45 old at 20,000.
const hist = [];
for (let i = 0; i < 40; i++) hist.push({ hq: false, pricePerUnit: 80000, quantity: 1, timestamp: NOW - i * 3600 });
for (let i = 0; i < 45; i++) hist.push({ hq: false, pricePerUnit: 20000, quantity: 1, timestamp: NOW - 40 * 3600 - i * 7200 });

const UNI = {
  9001: {
    lastUploadTime: (NOW - 3 * DAY) * 1000,          // deliberately 3 days old
    listings: [
      { pricePerUnit: 95000, quantity: 1, hq: false, retainerName: "Rival-one" },
      { pricePerUnit: 99000, quantity: 1, hq: false, retainerName: "Rival-two" },
      { pricePerUnit: 90000, quantity: 1, hq: false, retainerName: "Spicy-soy" }   // his own, must vanish
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
    recentHistory: hist
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
  }
};

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
    if (url.includes("universalis.app")) {
      const ids = url.split("/").pop().split("?")[0].split(",").map(Number);
      const items = {};
      for (const id of ids) if (UNI[id]) items[id] = UNI[id];
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
  await page.click("#btnScan");
  await page.waitForFunction(() => /passed the filters/.test(document.getElementById("status").textContent),
                             null, { timeout: 30000 });

  const status = await page.textContent("#status");
  const statusClass = await page.getAttribute("#status", "class");
  const table = await page.textContent("#out").catch(() => "");
  const tags = await page.$$eval(".tag", ns => ns.map(n => n.textContent.trim() + " || " + (n.getAttribute("title") || "")));
  const listAt = await page.$$eval("table tr", rows => rows.map(r =>
    [...r.querySelectorAll("th,td")].map(c => c.textContent.replace(/\s+/g," ").trim().slice(0,60))));

  console.log("version stamp      :", stamp);
  console.log("own-retainer field :", JSON.stringify(mineField));
  console.log("status class       :", statusClass);
  console.log("status text        :", status);
  console.log("rows               :", JSON.stringify(listAt, null, 1));
  console.log("tags rendered      :");
  for (const t of tags) console.log("   -", t);
  console.log("page errors        :", errors.length ? errors : "none");

  await page.screenshot({ path: SHOT, fullPage: true });
  await browser.close();
})();