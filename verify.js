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
const mkRecipe = (rid, iid, name, cat, ingId, ingName, qty, canHq, yld) => ({
  row_id: rid,
  fields: {
    ItemResult: { row_id: iid, fields: { Name: name, IsUntradable: false, CanBeHq: !!canHq,
                  ItemUICategory: { fields: { Name: cat } } } },
    AmountResult: yld || 1,
    AmountIngredient: [qty, 0, 0, 0, 0, 0, 0, 0],
    Ingredient: [{ row_id: ingId, fields: { Name: ingName } }],
    // A row of the level table, as XIVAPI returns it: the row number is not the
    // level. Test Ring stands in for a 50-star recipe (row 55 = level 50, 1 star).
    RecipeLevelTable: rid === 6 ? { row_id: 55, fields: { ClassJobLevel: 50, Stars: 1 } }
                                : { row_id: 40, fields: { ClassJobLevel: 40, Stars: 0 } },
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
  mkRecipe(6, 9006, "Test Ring", "Ring", 9002, "Test Plank", 1, true),
  // 5. a material sold in stacks (2026-09-25). Yield 3, two Test Planks a
  //    craft. Ten sales of 20 in the last two weeks and five of 99 before them,
  //    so the stack is 20 (the median over two weeks, not 99 and not the
  //    median over all fifteen). Material cost per unit is 2 x 1,000 / 3.
  mkRecipe(7, 9007, "Test Ingot", "Metal", 9002, "Test Plank", 2, false, 3)
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
const OWN_SALE = { item: "Test Wall", price: "19400", qty: "1", buyer: "Old-20", t: NOW - 80 * 3600 };

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

// Test Ingot: 5,000 a unit. Ten sales of 20 in the last 10 days, five of 99
// at 16 to 20 days old. One rival listing of 99 at 4,800.
const ingotHist = [
  ...[...Array(10)].map((_, i) => ({ hq: false, pricePerUnit: 5000, quantity: 20, timestamp: NOW - i * DAY - 3600, buyerName: "Ingot-" + i })),
  ...[...Array(5)].map((_, i) => ({ hq: false, pricePerUnit: 5000, quantity: 99, timestamp: NOW - (16 + i) * DAY, buyerName: "Ingot-old-" + i }))];
UNI[9007] = { lastUploadTime: NOW * 1000,
  listings: [{ pricePerUnit: 4800, quantity: 99, hq: false, retainerName: "Rival-ingot" }],
  recentHistory: ingotHist };

// Duty items (2026-09-26). Added to the page's list for the test only:
//   Test Minion  duty level 30, 60 minutes, sells at 300,000 -> 285,000 after
//                tax, less 60,000 of time at 1,000 a minute = 225,000 a unit:
//                in a Duty Bundle
//   Test Roll    duty level 20, 10 minutes, sells at 5,000 -> 4,750 after tax,
//                less 10,000 of time: no margin, left out
//   Test Card    duty level 40, above the default Duty Level of 50 - 20 = 30:
//                never priced
const TEST_DUTY = [[9011, "Test Minion", [[30, 60]]], [9012, "Test Roll", [[20, 10]]], [9013, "Test Card", [[40, 5]]]];
const dutyHist = (price, who) => [...Array(10)].map((_, i) => ({ hq: false, pricePerUnit: price, quantity: 1, timestamp: NOW - i * DAY - 60, buyerName: who + i }));
UNI[9011] = { lastUploadTime: NOW * 1000, listings: [], recentHistory: dutyHist(300000, "Minion-") };
UNI[9012] = { lastUploadTime: NOW * 1000, listings: [], recentHistory: dutyHist(5000, "Roll-") };
UNI[9013] = { lastUploadTime: NOW * 1000, listings: [], recentHistory: dutyHist(900000, "Card-") };

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
    // Since 2026-09-26 one gzipped file on the data branch, served as raw bytes.
    if (url.includes("/data/prev.csv.gz")) return route.fulfill({ status: 200, contentType: "application/octet-stream", body: require("zlib").gzipSync(LISTINGS_CSV) });
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
  const mineAtStart = await page.inputValue("#mine");

  // Two of Shaun's retainers, each with its own tax (2026-09-19): the first
  // starts at the game's 5% and is set to 3%; the second must copy the 3% and
  // is set to 5%. A third is added and removed again, accepting the confirm, to check
  // that the names field follows.
  page.on("dialog", d => d.accept());
  const addRetainer = async (name, tax) => {
    await page.click("#btnAddRetainer");
    const copied = await page.inputValue('.retainer:last-child [data-r="tax"]');
    await page.fill('.retainer:last-child [data-r="name"]', name);
    if (tax != null) await page.fill('.retainer:last-child [data-r="tax"]', String(tax));
    return copied;
  };
  const firstTax = await addRetainer("Spicy-soy", 3);
  const copiedTax = await addRetainer("Momo-mochi", 5);
  const thirdTax = await addRetainer("Temp-one");
  const mineWithThree = await page.inputValue("#mine");
  await page.click('.retainer:last-child [data-r="del"]');
  const mineField = await page.inputValue("#mine");

  await page.click("#btnLoad");
  await page.waitForSelector("#btnScan:not([disabled])", { timeout: 20000 });
  // The Test Ring is gear, which the page does not tick by default.
  await page.check('#groups label[data-group="All"] input');

  // The Item dropdown fills from the loaded recipes.
  const itemOptions = await page.$$eval("#itemNames option", os => os.map(o => o.value));

  // One of Shaun's own sales, as the Sale History window would show it, under
  // the first retainer: 19,400 is 20,000 after 3%, so it matches only if the
  // tax comes from that retainer's field and not the second's 5%.
  const ROW = '.retainer:first-child tbody tr:last-child ';
  await page.click('.retainer:first-child [data-r="add"]');
  await page.fill(ROW + '[data-f="item"]', OWN_SALE.item);
  await page.fill(ROW + '[data-f="price"]', OWN_SALE.price);
  await page.fill(ROW + '[data-f="qty"]', OWN_SALE.qty);
  await page.fill(ROW + '[data-f="buyer"]', OWN_SALE.buyer);
  const ownStamp = await page.evaluate(t => {
    const d = new Date(t * 1000), p = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }, OWN_SALE.t);
  await page.fill(ROW + '[data-f="time"]', ownStamp);
  await page.dispatchEvent(ROW + '[data-f="time"]', "change");
  const ownSalesStatus = await page.textContent("#ownSalesStatus");

  // The item rule on its own: a row that names an item is only tried against
  // that item's sales. One sale, one row that fits it on every other field.
  const itemRule = await page.evaluate(() => {
    const sale = [{ q: 1, t: 1000000, p: 20000, buyer: "Old-20" }];
    const row = item => [{ item, price: 19400, qty: 1, buyer: "Old-20", time: 1000000 * 1000, tax: 0.03 }];
    return { named: removeOwnSales(sale, row("Test Wall"), "Test Wall").matched,
             other: removeOwnSales(sale, row("Test Rug"), "Test Wall").matched,
             blank: removeOwnSales(sale, row(""), "Test Wall").matched };
  });

  // An Overflow row starts up the material ladder where the craft's earlier
  // rows stopped (2026-09-19). Ladder: 5 at 900, then 10 at 1,100; median
  // 1,000. Five units from the bottom cost 4,500; five more, skipping those,
  // cost 5 x min(1,100, 1,000) = 5,000; and 20 with 5 skipped is 10 x 1,000
  // off the ladder plus 10 more at the median = 20,000.
  const ladderRule = await page.evaluate(() => {
    LADDER.set(999901, [{ price: 900, qty: 5 }, { price: 1100, qty: 10 }]); PRICE.set(999901, 1000);
    const r = { first: ladderCost(999901, 5).cost, next: ladderCost(999901, 5, 5).cost,
                far: ladderCost(999901, 20, 5).cost, farImported: ladderCost(999901, 20, 5).imported };
    LADDER.delete(999901); PRICE.delete(999901);
    return r;
  });

  // Each row carries its own retainer's tax (2026-09-19): 20,000 gross shows
  // as 19,000 at 5% and as 19,400 at 3%, so 19,000 matches at 5% only.
  const taxRule = await page.evaluate(() => {
    const sale = () => [{ q: 1, t: 1000000, p: 20000, buyer: "Old-20" }];
    const row = tax => [{ item: "Test Wall", price: 19000, qty: 1, buyer: "Old-20", time: 1000000 * 1000, tax }];
    return { at5: removeOwnSales(sale(), row(0.05), "Test Wall").matched,
             at3: removeOwnSales(sale(), row(0.03), "Test Wall").matched };
  });

  // The screenshot reader's parser, on lines exactly as Tesseract returned
  // them from Shaun's Spicy-soy and Momo-mochi screenshots of 2026-09-16 (2x,
  // no threshold), plus one price with the gil glyph read as a digit (seen at
  // 3x), a merged "am.", a merged date and time, a date past today (last
  // year), the window's cut-short name, a stray character after the time
  // (the window's edge), and a buyer run together. The two header lines must
  // parse as nothing.
  const parsed = await page.evaluate(() => {
    fillItemNames(["Corner Counter", "Belah'dian Crystal Lantern", "Riviera Wardrobe", "Walnut Cartonnier", "Sylphic Wall Lantern",
                   "Straight Stepping Stones", "Botanist's Garden"]);
    const now = new Date(2026, 8, 16, 21, 0);
    const lines = [
      "|   ®  -  Corner Counter                           57,667» Katsu Pendragon               9/13 7:28 p.m.",
      "i |  }  Riviera Wardrobe                          32,979» Wilamena Ocana                9/9 11:24am.",
      "¥  Belah'dian Crystal Lant...                 58,2009 Siera Moon                      9/9 10:48 a.m.",
      "Walnut Cartonnier                         34913» Totoka Towa                     9/118:26 p.m.",
      "  Sylphic Wall Lantern                        31,039» Seduciia Bodhi                   12/31 12:15 a.m.",
      "s  Straight Stepping Stones                 33,948» Asumi Shinku                   9/13 3:39 p.m.         i",
      "|    i)  Botanist's Garden                           29,097» ElaraBell                          9/13 8:27 am.",
      "                  Item                                       Materia             Price           Buyer                                              Date/Time",
      "Spicy-soy"
    ];
    const fmt = s => s && [s.item, s.price, s.qty, s.buyer, new Date(s.time).toLocaleString("en-US", { hour12: false })].join(" | ");
    // A stack's row: the two Ovibos Milk totals from the third screenshot,
    // 25,317 for 30 and 32,913 for 39, must both come out at 844 a unit.
    const milk = (l, q) => fmt(priceStack(parseSaleLine(l, now), q));
    return lines.map(l => fmt(parseSaleLine(l, now))).concat([
      milk("=  Ovibos Milk                                25,317» Ahri Inori                     12/23 10:14 p.m.", 30),
      milk("=  Ovibos Milk                                  32913» Beeef Cake                      12/23 9:33 p.m.", 39)]);
  });

  // Two scans: HQ only off, then on. Only the Test Ring should change.
  const readOut = async () => {
    const status = await page.textContent("#status");
    const statusClass = await page.getAttribute("#status", "class");
    const tags = await page.$$eval("#out .tag", ns => ns.map(n => n.textContent.trim() + " || " + (n.getAttribute("title") || "")));
    const grab = () => page.$$eval("#out table tr", rows => rows.map(r =>
      [...r.querySelectorAll("th,td")].map(c => c.textContent.replace(/\s+/g," ").trim().slice(0,60))));
    const rows = await grab();
    // Bundle headers: slots and value, to see the balance and the overflow.
    const heads = await page.$$eval("#out .pf header", hs => hs.map(h => h.textContent.replace(/\s+/g, " ").trim()));
    // The Supply cell's tooltip carries the shortage arithmetic.
    const supplyTips = await page.$$eval("#out td[title*='should be filled']", tds => tds.map(t => t.getAttribute("title")));
    await page.click('#out .tabs button[data-tab="all"]');
    const allRows = await grab();
    await page.click('#out .tabs button[data-tab="pf"]');
    return { status, statusClass, tags, rows, heads, supplyTips, allRows };
  };
  const scan = async () => {
    await page.evaluate(() => { document.getElementById("status").textContent = ""; });
    await page.click("#btnScan");
    await page.waitForFunction(() => /passed the filters/.test(document.getElementById("status").textContent),
                               null, { timeout: 30000 });
    return readOut();
  };

  const nq = await scan();
  const stackRows = await page.evaluate(() => LAST.rows.map(r => ({ name: r.name, stack: r.stack, supply: r.supply,
    slots: slotsFor(r, LAST.cfg.margin), perUnit: Math.round(r.margin * 100) / 100 })));
  const ingotTm = await page.evaluate(() => { const r = LAST.rows.find(r => r.name === "Test Ingot"); if (!r) return null;
    const t = trueMargin(r, 5, 0); return { crafts5: craftsFor(r, 5), units5: t.units, mats5: t.mats, each5: Math.round(t.each * 100) / 100 }; });

  // Bundles to make re-plans the last scan in place, no scan (2026-09-19),
  // but only once its tick is clicked: typing 3 alone must change nothing and
  // light the tick; the tick must then show three bundles and leave the
  // status line untouched; Enter applies too.
  const statusBefore = await page.textContent("#status");
  const bundles = async () => (await page.$$("#out .pf")).length;
  const tickOff = async () => page.$eval('[data-tick="pf"]', b => b.disabled);
  const replan = { tickAtRest: await tickOff() };
  await page.fill("#pf", "3");
  await page.dispatchEvent("#pf", "input");
  replan.typedOnly = await bundles();
  replan.tickLit = !(await tickOff());
  await page.click('[data-tick="pf"]');
  replan.ticked = await bundles();
  replan.tickAfter = await tickOff();
  replan.tab = await page.textContent('#out .tabs button[data-tab="pf"]');
  replan.statusSame = (await page.textContent("#status")) === statusBefore;
  await page.fill("#pf", "5");
  await page.dispatchEvent("#pf", "input");
  await page.press("#pf", "Enter");
  replan.enter = await bundles();

  // Max (2026-09-25): as few bundles as hold every unit the shortage allows.
  // Ticking it re-plans at once, shuts the field and writes the count into it;
  // unticking keeps that count. Every allowed unit must be placed.
  const slotsUsed = () => page.$$eval("#out .pf .jobs", js => js.reduce((a, j) => a + +(/(\d+) slots/.exec(j.textContent) || [0, 0])[1], 0));
  const maxRun = {};
  await page.check("#pfmax");
  maxRun.bundles = await bundles();
  maxRun.field = await page.inputValue("#pf");
  maxRun.fieldShut = await page.$eval("#pf", i => i.disabled);
  maxRun.tickShut = await tickOff();
  maxRun.placed = await slotsUsed();
  maxRun.allowed = await page.evaluate(() => LAST.rows.reduce((a, r) => a + slotsFor(r, LAST.cfg.margin), 0));
  maxRun.statusSame = (await page.textContent("#status")) === statusBefore;
  // Export To Teamcraft: the link goes to the clipboard; catch it and read it back.
  await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async t => { window.__copied = t; }; });
  await page.click("#btnTeamcraft");
  const tcLink = await page.evaluate(() => window.__copied);
  const tc = { status: await page.textContent("#teamcraftStatus"), link: tcLink,
    rows: tcLink && Buffer.from(decodeURIComponent(tcLink.split("/import/")[1]), "base64").toString() };
  await page.uncheck("#pfmax");
  maxRun.offBundles = await bundles();
  maxRun.offField = await page.inputValue("#pf");
  maxRun.offOpen = !(await page.$eval("#pf", i => i.disabled));
  await page.fill("#pf", "5");
  await page.press("#pf", "Enter");

  // Apply to last scan (2026-09-26): Min sale price 70,000 drops Test Rug
  // (69,999) and Test Ring (29,999) and keeps Wall, Lamp and Ingot (20 x 4,799
  // = 95,980 a slot), with no request to Universalis. HQ only ticked at the
  // same time needs a scan: it must be named and not applied. Then back.
  const reapply = { enabledAfterScan: !(await page.$eval("#btnReapply", b => b.disabled)) };
  const uniBefore = seen.filter(u => u.includes("universalis.app")).length;
  await page.fill("#minprice", "70000");
  await page.check("#hqonly");
  await page.click("#btnReapply");
  reapply.names = await page.evaluate(() => LAST.rows.map(r => r.name).sort());
  reapply.hqKept = await page.evaluate(() => LAST.cfg.hq);
  reapply.status = await page.textContent("#status");
  reapply.newRequests = seen.filter(u => u.includes("universalis.app")).length - uniBefore;
  await page.uncheck("#hqonly");
  await page.fill("#minprice", "5000");
  await page.click("#btnReapply");
  reapply.restored = await page.evaluate(() => LAST.rows.length);

  await page.check("#hqonly");
  const hq = await scan();

  // Duty Items: until now the box was unticked, so none of the three may have
  // been priced. Tick it: Duty Level appears at 30; scan again.
  const priced = id => seen.some(u => u.includes("universalis.app") && u.split("/").pop().split("?")[0].split(",").includes(String(id)));
  await page.evaluate(t => DUTY_ITEMS.push(...t), TEST_DUTY);
  const duty = { boxAtStart: await page.isChecked("#xDuty"), fieldHidden: await page.$eval("#dutyLevelWrap", e => getComputedStyle(e).display === "none"),
                 pricedBefore: [9011, 9012, 9013].filter(priced) };
  await page.uncheck("#hqonly");
  await page.check("#xDuty");
  duty.level = await page.inputValue("#dutyLevel");
  await scan();
  duty.rows = await page.evaluate(() => LAST.rows.filter(r => r.duty).map(r => ({ name: r.name, level: r.level, minutes: r.minutes,
    gilPerMin: Math.round(r.gilPerMin), margin: Math.round(r.margin), slots: slotsFor(r, LAST.cfg.margin) })));
  duty.heads = await page.$$eval("#out .pf h3", hs => hs.map(h => h.textContent));
  duty.dutyRow = await page.$$eval("#out .pf", ps => { const p = ps.find(x => /Duty Bundle/.test(x.querySelector("h3").textContent));
    return p ? [...p.querySelectorAll("tbody tr td")].map(td => td.textContent.trim()).slice(0, 5) : null; });
  duty.cardPriced = priced(9013);
  await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async t => { window.__copied = t; }; });
  await page.click("#btnTeamcraft");
  const dl = await page.evaluate(() => window.__copied);
  duty.teamcraftHasMinion = !!dl && Buffer.from(decodeURIComponent(dl.split("/import/")[1]), "base64").toString().split(";").some(x => x.startsWith("9011,"));
  duty.status = (await page.textContent("#status")).match(/Duty items:[^.]*\./)?.[0];

  console.log("version stamp      :", stamp);
  console.log("own-retainer field :", JSON.stringify(mineField), "(page start " + JSON.stringify(mineAtStart) +
              ", with a third " + JSON.stringify(mineWithThree) + ")");
  console.log("retainer tax       : first " + firstTax + ", second copied " + copiedTax + ", third copied " + thirdTax + " (want 5, 3, 5)");
  console.log("own sales entered  :", JSON.stringify(ownSalesStatus));
  console.log("item dropdown      :", JSON.stringify(itemOptions));
  console.log("item rule matched  :", JSON.stringify(itemRule), "(want named 1, other 0, blank 1)");
  console.log("tax rule matched   :", JSON.stringify(taxRule), "(want at5 1, at3 0)");
  console.log("ladder skip        :", JSON.stringify(ladderRule), "(want first 4500, next 5000, far 20000, farImported 10)");
  console.log("re-plan, no scan   :", JSON.stringify(replan),
              "(want tickAtRest true, typedOnly 5, tickLit true, ticked 3, tickAfter true, tab Bundles3, statusSame true, enter 5)");
  console.log("max bundles        :", JSON.stringify(maxRun),
              "(want placed = allowed, field = bundles, fieldShut/tickShut true, statusSame true, off keeps the count and opens the field)");
  console.log("teamcraft export   :", JSON.stringify(tc));
  console.log("apply to last scan :", JSON.stringify(reapply),
              "(want enabled, names Test Ingot/Lamp/Wall, hqKept false, status names HQ only, newRequests 0, restored 5)");
  console.log("stacks and junk    :", JSON.stringify(stackRows),
              "(want Ingot stack 20, every other 1; Wall supply 2.5 (own listing out, junk at half) and Lamp 1)");
  console.log("ingot 5 slots      :", JSON.stringify(ingotTm), "(want crafts5 34, units5 100, mats5 680)");
  console.log("duty items         :", JSON.stringify(duty),
              "(want box false, field hidden, nothing priced before; level 30; only Test Minion (30, 60 min, margin 225,000, 6 slots) in a Duty Bundle, time 6.0 h, Expected 1,710,000 (sale value; the 225,000 margin only sorts); Test Card never priced; Teamcraft has it)");
  console.log("screenshot lines   :");
  for (const l of parsed) console.log("   -", l);
  for (const [label, r] of [["HQ only OFF", nq], ["HQ only ON", hq]]) {
    console.log("\n=== " + label + " ===");
    console.log("status class       :", r.statusClass);
    console.log("status text        :", r.status);
    console.log("bundle headers     :", JSON.stringify(r.heads));
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