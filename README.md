# FFXIV Crafting Planner

Recommends what to craft and list each week, split into claimable **Bundles** so several
people can craft without flooding the same items.

**Use:** open the page, press **Load recipes**, then **Scan the market**. Claim a bundle
by number in Discord, craft it, list it.

**This document describes the tool as it is built today.** The incoming-supply term was
built on 2026-09-15 to Shaun's formula of 2026-09-14 (section 6a); the older design of
2026-09-06 is kept under [Designed but not built](#designed-but-not-built) for the parts
of it that remain unbuilt.

The page carries a version stamp beside its title, format `v[MM].[DD].[YY].[build]`. If it
does not match the version you last uploaded, the upload did not take. Current: `v09.19.26.5`.

- [Data sources](#data-sources)
- [Record formats](#record-formats)
- [Time windows](#time-windows)
- [Tracker files](#tracker-files)
- [Calculations](#calculations)
- [Settings we chose](#settings-we-chose)
- [Designed but not built](#designed-but-not-built)
- [Known defects](#known-defects)

---

## Data sources

**XIVAPI** — the game's own files. Recipes, ingredients, item categories, tradability,
vendor prices, what is gatherable. Changes only when Square Enix patches the game.

**Universalis** — the market board. Players run an uploader that reports what they view,
so Universalis knows whatever somebody last looked at. This is the data that can be stale
or absent.

**The tracker's listing history** — `data/listings-YYYY-MM.csv` in this repository, written
daily by `tracker.js` (see Tracker files). The only record anywhere of what was *listed*, as
opposed to sold. The page fetches this month's and last month's file at scan time: from
its own address on GitHub Pages, or from the raw file on GitHub when the page was opened
from disk. Everything the page knows about these files is in one object, `READINGS`, with
two calls — `load()` and `readingsFor(itemId)` — so a database could replace the files
later without touching the calculations.

**Tesseract.js** — the only code the page loads from outside itself, and only when a
screenshot of the Sale History window is given to the Your sales table (section 6a).
Fetched from jsdelivr at that moment, about 7 MB in four files (the library, its worker,
the recognition engine as WebAssembly, and the English model, which the library keeps in
the browser's IndexedDB afterwards). A page that never sees a screenshot never asks for it.

### Universalis fields we ignore

| Field | Reason |
|---|---|
| `regularSaleVelocity`, `nqSaleVelocity`, `hqSaleVelocity` | Value changes with how much history is requested. The same item returned 0, 83 and 1,320 units per day for three different request sizes. |
| `averagePrice`, `currentAveragePrice` | Computed over whatever slice was requested. |
| `unitsForSale`, `listingsCount` | Capped by the number of listings requested. Requesting 20 made every crowded item report exactly 20. |
| `lastReviewTime` | Identical across every listing of an item, and equal to that item's upload time. Verified on 4 items covering 40+ listings, zero variation. It records the snapshot, not the listing. |

---

## Record formats

### Sale record

```
itemId        6668            which item
timestamp     1788725070      unix seconds, precise to the second
pricePerUnit  900             gil each
quantity      1               units in this single purchase
hq            false           high quality flag
buyerName     "Mike Kelvin"   purchasing character
```

### Listing record

```
pricePerUnit   100000               gil each
quantity       1                    units in this listing
hq             false                high quality flag
retainerName   "Evelyn-virtvs"      selling retainer
listingID      "28499341639631650"  the game's own identifier for this listing
lastReviewTime 1789345692           ignored, see above
```

`listingID` is a 17-digit number that identifies the listing itself, not the upload;
it is carried by every listing (2,368 of 2,368 in a full snapshot on 2026-09-14, all
distinct) and by **no sale record**, on either endpoint or in Universalis' published
schema. So a sale cannot be tied to the listing it came from; only its price, quantity,
time and buyer are known.

### Item-level field

`lastUploadTime` — when a player last viewed this item. Determines whether a reading is
new information or a repeat of an old one.

On the first tracker run (2026-09-07), reading ages ranged from 0.5 hours to 21 days.
29% had been refreshed within 24 hours.

An item with no upload time has never been viewed by anyone running the uploader. Those
are discarded rather than treated as empty shelves.

---

## Time windows

Every window currently in use. Some are counts of records, some are periods of time; the
type column says which.

| Window | Current value | Type | Applies to |
|---|---|---|---|
| Sale history fetched | Last **200 sales** per item, any quality | Count | Feeds both the market price and weekly demand. Deliberately a count, not a period: a fast mover's 200 sales may span three weeks and a slow one's two years. Measured 2026-09-13: Wooden Loft 2.8 weeks, Wine Barrel 8.1, Masonwork Interior Wall 15, Riviera Wardrobe 75. Universalis would return up to 999, reaching about 201 weeks back; 200 was kept to limit request size. |
| Market price | Last **40 sales** of those, of the quality being priced (see Quality) | Count | Deliberate. The last 40 sales are what the item is selling for now, regardless of how long they took. |
| Weekly demand bands | **0-4 weeks at 50%**, **4-12 weeks at 30%**, **older at 20%** | Duration | Recent weeks count more without one quiet week dominating. All qualities count. |
| Listings fetched | Cheapest **20 listings** per material; **up to 100** (every listing) per craft | Count | Competition depth and the material price ladder. Universalis returns listings cheapest first, so the cheapest twenty are the only ones competing with you. A craft is fetched whole so its live count can be set against the tracker's reading (section 6a). Both qualities are kept and flagged; a craft counts only the quality it is sold as (see Quality). Your own retainers' listings are kept and flagged. |
| Price ladder retained | Cheapest **20** real listings of either quality, your own excluded | Count | Material cost calculation. |
| Staleness cutoff | **180 days** | Duration | Items whose last upload is older are dropped entirely. |
| Supply-age warning | **24 hours** | Duration | Items whose last upload is older than this are kept. Their age was shown as a tag until 2026-09-16, when Shaun removed the row tags as noise; it is still computed (`supplyAge`, `oldSupply`) and not shown. |

### Quality

HQ versus NQ is a question about the thing you sell, never about the things you buy.
Shaun, 2026-09-13.

**Crafts.** The **HQ only** box in the setup panel, off by default, means "sell as high
quality". When ticked, every craft in the scan that the game allows an HQ version of gets
its three numbers from HQ data alone — the 40-sale median from HQ sales, weekly demand
from HQ sales, current listings from HQ listings, and the one-gil undercut against the
cheapest HQ rival — requested from Universalis with its `hq=true` filter, which matters
because the 20 cheapest of a mixed list could all be NQ. Crafts with no HQ version, which
is every furnishing, behave exactly as with the box off. (Rows sold as HQ were tagged "HQ"
until 2026-09-16.)
With the box off, a craft is priced and its competition counted on NQ; its demand counts
every sale.

**Materials.** Either quality, always: the market price is the median of the last 40 sales
of any quality, and the ladder walks listings of any quality, cheapest first. You buy
whatever is cheapest and your own crafting makes the result HQ. Measured 2026-09-13 on
Seraph: HQ listings of commodity materials sit level with NQ or a gil under (Silver Ingot
500 NQ, 499 HQ; Cotton Yarn 150, 148), so the ladder is barely moved; the mixed median can
differ from the NQ-only one in either direction (Silver Ingot 651 against 300, Mythril
Ingot 526 against 785), because the last 40 mixed sales cover a different period from the
last 40 NQ ones.

An item that is both a craft in the scan and a material in another craft is fetched
twice and priced HQ as a craft, either quality as a material.

Whether an item can be HQ comes from XIVAPI's `CanBeHq` on the Item sheet, read off each
recipe's result as recipes load.

---

## Tracker files

Written to `data/` by a GitHub Action scheduled for 13:13 UTC daily. GitHub does not run
scheduled jobs on time: the first 8 runs (2026-09-07 to 2026-09-14) started between 16:17
and 18:35 UTC, which is 11:17 to 13:35 Central. Treat each reading as a midday one.

The tracker records what was listed and nothing else. It does not know whose retainers
are whose, and it does not record sales: Universalis keeps roughly 200 weeks of those per
item and the planner reads them live. Until 2026-09-14 it kept a `sales-YYYY-MM.csv`
with a 48-hour window; that window missed 4 of Shaun's 11 September sales, because a
sale only reaches Universalis when somebody next views the item, so the file was stopped
and deleted.

### `data/items.csv`

`itemId, name, category`. Rewritten every run. 388 items through 2026-09-13; 398 from the
next run, after the 10 Ceiling Light recipes were added to the tracker's category filter
(it had not matched the planner's Furnishings group). Since v09.16.26.1 the page reads it
too, through `READINGS.names()`: when a screenshot is given to Your sales before any
recipes are loaded, these 398 names are what the rows are matched against.

### `data/stock-YYYY-MM.csv`

One row per item per day.

```
2026-09-07 , 6347 , 7 , 7 , 6 , 19999 , 200000 , 1788656373392
```

| Column | Value | Meaning |
|---|---|---|
| `date` | 2026-09-07 | Date the row was recorded. |
| `itemId` | 6347 | Cross-reference against `items.csv`. |
| `unitsListed` | 7 | Total units on the board. |
| `listings` | 7 | Number of separate listings. |
| `sellers` | 6 | Number of distinct retainers, so one retainer holds two listings. Computed, no longer shown (removed from the Supply cell 2026-09-16). |
| `minPrice` | 19,999 | Cheapest listing. |
| `maxPrice` | 200,000 | Most expensive listing. |
| `lastUpload` | 1788656373392 | Unix milliseconds. 26 hours before this reading. |

If `lastUpload` does not change between two dates, the second row is a repeat of the
first, not a new observation.

**Rows dated 2026-09-07 to 2026-09-14 with `lastUpload` 0 are empty boards, not
unread items.** The tracker asked Universalis for no sale entries, and with none
requested Universalis reports an empty board's upload time as 0 (measured 2026-09-14 on
Riviera Wardrobe: `entries=0` gave 0, `entries=1` gave the real time). 425 of the
3,114 rows from those eight days are affected, every one with zero listings; their true
upload time is unknown. From 2026-09-15 the request asks for one entry and the column is
correct.

### `data/listings-YYYY-MM.csv`

One row per listing per reading, from 2026-09-15. A reading is one item at one upload
time; the tracker writes its listings the first time it sees that reading and never
again, so a day on which nothing was refreshed adds nothing. Over the first eight days
27% of items refreshed on a typical day, so expect roughly 1,200 rows a day.

```
1789311745342 , 6347 , 28499341639806030 , Nekoquatro , 7000 , 1 , 0
```

| Column | Value | Meaning |
|---|---|---|
| `lastUpload` | 1789311745342 | The reading, in unix milliseconds. Same value as `stock`'s column. |
| `itemId` | 6347 | Cross-reference against `items.csv`. |
| `listingID` | 28499341639806030 | The game's identifier for this listing (see Record formats). |
| `retainerName` | Nekoquatro | Selling retainer. The planner removes the user's own by name. |
| `pricePerUnit` | 7,000 | Gil each. |
| `quantity` | 1 | Units in this listing. |
| `hq` | 0 | 1 for high quality. |

Every listing is written, whoever posted it and whatever the price: the file is the
board as it stood, not a judgment about it. A reading that found the board empty gets
one marker row with a blank `listingID` and quantity 0, so "nobody had this listed" is
distinguishable from "never read". Which files the planner reads, and what it does with
them, is described under Calculations once that is built.

---

## Calculations

**What a row shows.** Since v09.16.26.3 (2026-09-16) a craft in a bundle, and a row on All
items, carries **no tags** — except the red **Overflow** tag Shaun asked for on 2026-09-19
(section 8). Shaun: "The items in the bundles don't need any tags. If I need
more info, we'll add tags later." Removed that day: "HQ", "HQ only" on the heading, "cut
from N", "open market", "stale", "supply N days old", "N yours listed", "GC seal mats" /
"GC", "N/wk incoming", "inflow unmeasured", "material unpriced" / "unpriced mat" and
"short: material", and the seller count in the Supply cell. Everything they said is still
computed and most of it is still in a tooltip — Supply, Mats each, Profit each, and the
Listed/wk column on All items. What stays: the notes on **materials** — the price or "never
sold, costed at 0", "(gatherable)", "GC seals", and the MANUAL_NOTES sourcing labels
("Unspoiled Node", "Dungeon", "Buy Only", "Allied Society") on the material lines and in the
Materials tabs. Any new tag is run past Shaun first.

### 1. Market price

Median of the last 40 recorded sales for that item. For a craft, sales of the quality
you are selling — NQ, or HQ with the box ticked; for a material, sales of either quality
(see Quality).

```
marketPrice = median(prices of the last 40 sales)
```

Median rather than mean so a single unusual sale does not move it. A count rather than a
time period is deliberate: whether those 40 sales took three days or twenty weeks, they
are what the item is currently selling for. An item with no sale history at all is
dropped.

**Example — Glade Wardrobe.** One listing on the board at 999,999,999 gil. 25 recorded
sales between 9,500 and 45,999 gil, median 18,999. Priced at 18,999.

### 2. Current listings

```
realListings = listings of the quality being sold, priced at or below marketPrice x 2.0,
               your own retainers included
supply       = sum of quantities across realListings
sellers      = count of distinct retainerName across realListings
```

Anything above the cutoff is excluded from competition and shown as "overpriced".

**Your own retainers** are the names of the retainer sections under Your sales (section
6a; since v09.19.26.1 — until then one setup field, default `Spicy-soy, Momo-mochi`).
Each must be the name as the market board shows it, matched case-insensitively. Their
listings **count as supply whatever they are priced at**, above the junk cutoff included: ten of yours already on the board means ten fewer to
make, and repricing them is your call. They are never undercut (section 3) and never
bought from (section 4). (The row was tagged "N yours listed" until 2026-09-16; the count
is still in the row's data.)

**Supply age.** The item's last Universalis upload can be days old, so the supply figure is
from that moment and listings may have appeared since. Until 2026-09-16 a row more than
24 hours old was tagged "supply N old" and one over 7 days "stale"; Shaun removed both as
noise — the crafter gives the tool some leniency. The age is still computed, not shown.

**Items with 20 or more real listings are dropped entirely.** Twenty already ahead of
you is not a market worth entering. Since 2026-09-15 a craft is fetched whole (up to 100
listings), so the count is exact; a material is fetched twenty deep, and if all twenty are
real there are more beyond them, so for it `supply` is a floor.

**Example — Cobalt Ingot.** 40 listings from 5 distinct retainers, 19 held by one of
them.

### 3. Listing price

```
listAt = max(1, min(cheapest rival listing - 1, marketPrice))
```

The board sells cheapest first and a tie loses, so it goes one gil under the cheapest
rival, or lower still if sales say the item is worth less. Your own listings are not
rivals; undercutting yourself helps nobody.

Where no rival listings exist, `listAt` is `marketPrice`. (The item was tagged "open
market" until 2026-09-16; removed — every board is an open market.)

### 4. Material cost

**Every ingredient written on the recipe is costed as bought.** An intermediate with a
recipe of its own — Silver Ingot, Iron Rivets — is costed at its own market price, not at
what its ingredients would cost. The market price is the measure of how hard the thing is
to obtain, however you obtain it. Gathering or crafting a material yourself is therefore
not a cost saving in this model; it is gil you did not spend, and the Mats each column is
the most that gathering can add back to the profit shown.

One rule, applied per unit of material:

```
walk the material's realListings cheapest first, your own retainers excluded
each unit costs        min(that listing's price, marketPrice)
once listings run out  marketPrice
never sold here        0
```

A listing above the market price is not a price you are stuck with; it is a cue to buy on
another world at the going rate, so no unit ever costs more than the median. A listing
above 2.0x the median is not in the ladder at all and costs the same as a unit bought
elsewhere: the median. Shaun, 2026-09-13.

The ranking uses this rule for a single craft (the cheapest rungs). The bundle view
re-runs it for the quantity recommended and shows that in Mats each; the difference is
the cheapest rungs running out. Divided by yield for recipes that make more than one per
craft. Shards and crystals are materials like any other.

Until 2026-09-16 a row whose materials ran short was tagged "short: material name", with a
tooltip saying how many were needed, how many were listed, and whether the material has a
recipe or can be gathered. Shaun removed it: a material cannot be short, the crafter
gathers or buys the rest. The shortfall is still costed at the market price.

**A material with no sale history is costed at zero**, on the rule agreed 2026-09-13:
what nobody has bought cannot be sold either, so using it costs nothing. The material line
says "never sold, costed at 0" (the row's own "material unpriced" tag was removed
2026-09-16). Measured 2026-09-13: of the 288 materials reachable from the 398
level-50 furnishing recipes, 287 have a sale on Seraph; the one that does not is Odin's
Mantle, which is untradeable.

Materials marked `selfSource` in `MANUAL_NOTES` (Nymian Orb) are costed at the market
price for the whole quantity rather than walked up the listing ladder, because they are
farmed, not bought.

**Example — Nymian Orb.** 12 listed on Seraph: one at 5,500, five between 7,000 and
7,500, six at 10,000. Market price 8,000.

| Units required | Total cost | Cost per unit | Note |
|---|---|---|---|
| 6 | 42,199 | 7,033 | Cheapest six, all under the median. |
| 12 | 90,199 | 7,517 | The six at 10,000 are charged at 8,000 each. |
| 42 | 330,199 | 7,862 | 30 units beyond the board, at 8,000 each. (Was tagged "short" until 2026-09-16.) |

### 5. Weekly demand

Computed from the raw sale records, high quality and normal quality alike. Each band's
rate is units sold divided by the weeks that band actually covers, so a band holding two
weeks of history is not treated as four empty ones. Bands the history never reaches are
dropped and the remaining weights renormalised: an item whose 200 sales span six weeks
uses the 0-4 band at 62.5% and the 4-12 band at 37.5%.

```
band 0-4 weeks    weight 0.50
band 4-12 weeks   weight 0.30
band 12+ weeks    weight 0.20

bandRate     = unitsSoldInBand / weeksTheBandCovers
weeklyDemand = sum(bandRate x weight) / sum(weights used)
```

Bands are measured backwards from **today**, not from the item's most recent sale. An
item that sold forty times but nothing in six months reads as 0.32 per week, not 3.55.

Where the history is not truncated, the span is floored at one week, so four sales in one
afternoon read as 4 per week rather than 28.

**Example.** Nymian Wall Lantern, 50 sales over 24.4 weeks: **2.45 per week**. Manor
Couch, 40 sales over 10.2 weeks: **3.56 per week**. Universalis' own figures for these
were 7 and 0.2.

### 6. How many to make (shortage)

The gap between weekly demand and what is already listed, less a safety margin, rounded
down once at the end. Shaun's formula, 2026-09-13.

```
shortage = floor((weeklyDemand - supply) x (1 - safetyMargin))
```

At the default 20%:

| Weekly demand | Listed now | Gap | Make |
|---|---|---|---|
| 20 | 5 | 15 | 12 |
| 44 | 20 | 24 | 19 |
| 7.6 | 0 | 7.6 | 6 |
| 8 | 9 | 0 | 0 |

An item with more listed than it sells in a week gets nothing.

Since 2026-09-15 the formula also subtracts what other sellers list in a week, measured
(section 6a):

```
shortage = floor((weeklyDemand - supply - incomingSupply) x (1 - safetyMargin))
```

For an item with no earlier reading to measure from, `incomingSupply` is 0, so it comes out
exactly as it did before. (The row was tagged "inflow unmeasured", and a measured one
"N/wk incoming", until 2026-09-16; Shaun removed both — the figure is settled inside the
quantity.) Since v09.19.26.1 the bundle's Supply cell reads `1+3/wk vs 5/wk`: one unit
listed now, about three a week being listed by others, against demand of five a week
(Shaun, 2026-09-19: "I want the user to see the inflow and current listings"). An item
with no earlier reading shows no inflow term, `1 vs 5/wk`, and its tooltip says why. The
one-decimal rate is in the tooltip and in the Listed/wk column on All items.

The margin covers everything the model still cannot see. It leaves a shortage open rather
than closing it, on the reasoning that the marginal seller is the one who gets undercut.

### 6a. Incoming supply

What other sellers list in a week. Shaun's formula, 2026-09-14; junk cutoff added
2026-09-15.

```
incomingSupply = max(0, newListings - previousListings + purchases) / weeks
```

| Term | Meaning |
|---|---|
| `previousListings` | Units on the board at the tracker's reading at least **14 days** before the live reading — the most recent such reading — or the oldest reading the tracker has if none is that old. Your own retainers' listings removed, and listings priced above **2.0x the market price** removed, the same cutoff as section 2. |
| `newListings` | Units on the board at the live reading, with the same two removals. The tracker records every listing at any price, so the live board is fetched whole too — up to 100 listings per craft rather than the cheapest 20 — and both are cut at the same point. |
| `purchases` | Units sold between the two readings' upload times, from Universalis' sale history, less the sales you entered as your own (below). Every sale, whatever the price: a sale is a sale. |
| `weeks` | The time between the two upload times, never less than one week. |

Whatever is on the board now that was not there before, plus whatever sold in between,
had to be listed in between. Your own listings and sales come out so you are not counted
as your own competitor. The result is floored at zero: a negative means a listing was
pulled, or a sale happened that Universalis never recorded, and either way nothing new was
listed. Both readings are counted on the quality the craft is sold as (see Quality). The
period ends at the live reading's upload time, not at the moment of the scan, because
Universalis knows nothing after it.

The junk cutoff uses today's market price for both readings, not the price at the time of
the earlier one, so a shift in price between them does not read as listings appearing or
vanishing. Measured on the first day of data, 2026-09-15: Amdapori Wall Lantern had 14
listings above the cutoff at both readings; without the cut they read as 14 against 14,
which happens to cancel, but a single new overpriced listing would have counted as a
unit a week of incoming supply while counting as nothing in section 2.

**Your own sales.** The setup panel holds them under one section per retainer (since
v09.19.26.1, 2026-09-19: the guild's retainers pay different tax). A section is added
with **Add a retainer** and carries the retainer's name, its own "Tax on its sales" field,
its own Add a sale and Add from a screenshot buttons, and a table of its sales copied from
its Sale History window in game: the item, the price as shown there, quantity, buyer, and
date and time. The first retainer's tax starts at the game's 5%; each one added after copies the
last one's. Removing a retainer asks first, then takes its sales with it. The window shows
the price *after* tax, to the minute; Universalis records the price the buyer paid, to the
second, with the buyer's name. So each row is matched against one recorded sale on
quantity, on the minute, on the buyer if one was typed, and on price once **that
retainer's** tax is added back — within one gil, because 59,999 and 60,000 both show as
58,200 at 3%. **A row that names an item is only tried against that item's sales**
(Shaun, 2026-09-16; the Item column is a dropdown of every loaded recipe name that can
also be typed in); a row with the item left blank is tried against every item's, as
before. Retainers and rows are kept in the session file and nowhere else: a fresh page
starts with none, so nobody else who opens the tool sees your sales (until 2026-09-19 the
browser remembered them between visits). The status line after a scan says how many rows
matched a recorded sale.

**Rows from a screenshot.** The window cannot be copied as text, so a screenshot of it —
dropped on a retainer's section, pasted with Ctrl+V (into the section last clicked or
typed in, else the first), or chosen with the section's button — is read by
Tesseract (see Data sources) and its rows are added to the table as ordinary editable
rows. The picture is scaled 2x and, being light text on a dark ground, inverted; each
line is then read from the right: date and time (`M/D H:MM a.m.`, no year — this year,
or last year if that would put it in the future; anything after the time is ignored,
because the window's edge can leave a stray character there), the buyer (character names
are two capitalised words; a name the reader ran together, "ElaraBell", is split again at
the second capital), the price, and what is left is the item. The item text is matched to a known
name: the longest known name it contains; for a name the window cut short with "…", the
known name that begins with what was left; then a known name within two characters; else
the text itself with the icon column's leftovers stripped. The gil glyph after the price
is read as "»" or, sometimes, as one more digit, so with commas present only the
comma-grouped part counts (`58,2009` → 58,200).

**Stacks.** The window has no quantity column: a stack sale is one row with the quantity
printed small in the bottom corner of the item's icon, and the price shown is the stack's
total, net of tax (Shaun, 2026-09-16, from a Momo-mochi screenshot: 25,317 for 30 Ovibos
Milk and 32,913 for 39 are both 843.9 a unit). The whole-image pass never reads those
digits, so for every row the icon's bottom corner — placed from where the item's name
starts, 2.7 to 0.1 name-heights to its left and 0.2 to 1.75 below its centre line — is cut
out of the picture and read on its own with only digits allowed. A number from 2 up is
the quantity and the row's price becomes the total divided by it, to the nearest gil, as
the table wants for a stack; anything else is quantity 1. The status line says how many
stacks were priced that way.

A row already in the table (same item, price, quantity, buyer and minute) is not added
again, so the same screenshot twice adds nothing; two real sales that agree on all five
stay two rows.

Measured on Shaun's three screenshots of 2026-09-16 — Spicy-soy (681x541, 12 rows),
Momo-mochi (687x556, 12 rows) and a second Momo-mochi (675x312, 8 rows, 7 of them
stacks): **32 of 32 rows** read with price, buyer, time and, where the name is one the
page knows, item; **7 of 7 stack quantities** read (four 20s, two 30s, one 39) at
confidence 95–96 and **no quantity read on any of the 25 plain rows**; 1–3 seconds a
screenshot once the library was loaded. The rules were shaped on these screenshots as
they went: the second first read 11 of 12 (a stray "i" after one time) with one buyer run
together; the third first read the 39 as 1 until the crop was bounded as above (the whole
icon width dropped the 20s to confidence 7–26; reaching the icon's bottom edge lost the
30s). What still misreads: 1 buyer of 32 ("Ahri Inori" as `Ahrilnori`, a capital I read
as an l, in one of its two rows), and an item the page has no name for keeps the window's
cut text ("Levinchrome Aethersa"). At 3x the glyph read as a digit on 3 of 12 prices
(absorbed by the price rule); the thousands comma was lost on 3 of 32 (`34913»`), which
reading digits only absorbs. Three screenshots, one window, one font size: check the
rows, especially buyers, because a misread buyer's name means the row matches nothing.

**Fixture** (verify.js, Test Wall): live reading 3 days old with two rival units, one of
yours and one rival at 999,999 against an 80,000 median; tracker readings 30, 20 and 10
days back, the 20-day one holding one rival unit, one of yours and one rival at 500,000;
29 sales in the period, one of them entered as yours. Previous 1, new 2, purchases 28,
17 days: **11.9 a week**, and the 20-day reading is the one used. Had the cutoff failed
on the live side the figure would read 12.4; on the tracker side, 11.5.

**What to expect.** The tracker began writing listings on 2026-09-15, so the earliest a
reading can be 14 days old is 2026-09-29; until then the oldest reading is used and the
rate is spread over a full week. Refresh is sparse — 27% of items on a typical day, 32%
never refreshed in the first eight days — so an item can go weeks between readings, and a
newly refreshed item has no earlier reading at all. Both cases show in the Listed/wk
column's tooltip on All items (the row tags were removed 2026-09-16).

### 7. Profit and ranking

```
profitEach = (listAt x 0.95) - materialCost
```

The 0.95 is the 5% market board sales tax (the default; the Sales tax field sets it. It was
10% until 2026-09-19, when Shaun found the game's rate is 5%). For ranking, `materialCost` is each
ingredient at its market price (section 4); the bundle view shows the same figure with
materials at what the listings actually ask for the quantity recommended. Expected profit
for a row is quantity times profit each. **Competitors who list during the week are not
modelled**; the safety margin in section 6 is what covers them.

Until 2026-09-13 an "expected sales" curve discounted each additional unit of an item.
Under the shortage cap it was provably flat — the cap keeps quantity below the demand gap,
and inside that range the curve returns the quantity unchanged — so it was removed.

### 8. Slot allocation

Total slots are bundles times slots per bundle. The most profitable item takes as many as
its shortage and the per-item cap allow, then the next, until the slots run out.

Bundles are then filled by handing each item, whole, to whichever bundle currently has the
lowest total value and room for it. No item appears in two bundles, so no two guild
members compete on the same item — with the one exception below. When no bundle has room for the whole quantity, the
item is cut down to the largest free space anywhere and the summary line above the
bundles says so (the row's "cut from N" tag was removed 2026-09-16). Allocation then runs again with that item capped, so the freed slots
go to the next-best item rather than sitting empty.

**Overflow** (Shaun, 2026-09-19). His first guild run asked for 7 bundles of 40 and got 120
slots filled: only 47 of 136 candidates had any shortage, and the one big one, Wall
Planter at 33, was cut to the 20-per-item cap. His rule: when bundles still have slots
after the pass above, a craft whose shortage was more than Max of one item sends the rest
out as extra rows — most profitable craft first, at most Max of one item of it in any one
bundle, each row to the bundle worth least that has room — until the shortage is filled
or every bundle is full ("Overflow still capped at 20/bundle, split across bundles, with
the bundles balanced for profit"). It is the one case where a craft is in more than one
bundle; the hint above the bundles says so when it happens. The red **Overflow** tag, the
only tag a craft carries, goes by origin: the craft's first-pass row (the one the cap
cut, usually 20) is plain wherever it sits, and every row the overflow step added is
tagged. Because an added row goes to the poorest bundle with room, it can land in an
earlier bundle than the plain row, so a tagged row may come first in reading order.
Shaun chose this over tagging by bundle order on 2026-09-19 ("Tag by origin"), having
seen both; v09.19.26.4 briefly did the other. An Overflow row has its own Made tally, and
Mats each walks the material ladder once per craft, plain row first, a later row starting
where the earlier ones stopped, so the second twenty are not costed on the same cheap
listings as the first. On the 09-19 file this adds 13 Wall Planters (120 → 133 slots).

### 9. Priority bands

Within a bundle, items are sorted by their contribution to that bundle's total expected
value, then banded by cumulative share of **that bundle's total expected value**:

| Band | Cumulative share |
|---|---|
| Craft first | 0% to 50% |
| Craft next | 50% to 80% |
| If time allows | 80% to 100% |

---

## Settings we chose

Judgment calls, not game rules.

| Setting | Current | Effect |
|---|---|---|
| Junk listing cutoff | 2.0x market price | Listings above this multiple are excluded from competition, and from both readings of incoming supply. |
| Listings fetched | Cheapest 20 per material | Twenty or more real listings is also the point at which a craft counts as too crowded to enter. |
| Safety margin | 20% | Share of the demand-minus-supply gap deliberately left unfilled. Covers competitors and anything else the model does not see. |
| Max of one item | 20 | Upper limit on units of a single item within one bundle. Shortage beyond it goes to other bundles as Overflow rows (section 8) while any have slots free. |
| Minimum sale price | 5,000 gil | Items below this are excluded. |
| Minimum sales per week | 1 | Items below this are excluded. |
| Staleness cutoff | 180 days | Items not uploaded within this period are excluded. |
| Supply-age warning | 24 hours | Items not uploaded within this period are flagged in the row's data; the tag that showed it was removed 2026-09-16. |
| Own retainers | none | The retainer sections under Your sales. Listings from these count as supply but are never undercut or bought from. |
| Material price cap | 1.0x market price | No unit of material is ever charged above the median of its last 40 sales. |
| Vendor-cheap threshold | 100 gil | Materials a vendor sells below this are classed as buy rather than gather. |
| Priority bands | 50% / 80% | Cumulative share of a bundle's expected value. |
| Market price window | Last 40 sales | How many sales define the current price. |
| Demand weighting | 50% / 30% / 20% over 0-4, 4-12, 12+ weeks | How much recent weeks count toward demand. |
| Demand span floor | 1 week | Stops a single burst reading as a high weekly rate. |
| Recipe expansion depth | 6 levels | How far the raw material tree is followed. |
| Unpriced material | 0 gil | A material with no sale history costs nothing. Rule of 2026-09-13. |
| Failed request retry | Once, after 3 seconds | A Universalis request that fails three times in a row is tried once more at the end of the scan. |
| Incoming-supply gap | 14 days | The previous reading is the most recent one at least this old. Shorter periods read one seller's batch as a weekly rate. |
| Listings fetched per craft | Up to 100 | Universalis' ceiling. Crafts are counted whole so the live count matches the tracker's. |
| Sales tax | 5% | The market board's cut of every sale, taken off the list price for profit. Was 10% until 2026-09-19. |
| Tax on your own sales | 5% for the first retainer; each after copies the last | Per retainer. What the Sale History window took off, added back to match that retainer's sales against Universalis. Separate from the Sales tax used for profit; Shaun's own retainers clear at 3%. |

Fixed by the game: 5% sales tax; 40 listing slots per character.

Set by choice: recipe level 50 and under.

---

## Designed but not built

Specified on 2026-09-06 and awaiting tracker data. None of this affects current output.

**Shortage detection.** Average demand and average supply both measured over time from
our own records, rather than demand as a rate against supply as a snapshot.

```
availableSupply = openingStock + listingsAddedDuringWeek
shortfall       = averageDemand - availableSupply
flag when shortfall >= max(25% of averageDemand, 3 units)
confirm after two consecutive flagged weeks
```

**Quantity to craft.** Worked example: demand 50, supplied last week 20, shortfall 30.
Competitors are assumed to add 10% of the shortfall, rounded up (3). A further 10%,
rounded up, is left deliberately unfilled (3). Craft 24.

**Baseline weighting.** 50% to the three weeks before last, 30% to the eight weeks before
that, 20% to everything older. The most recent week is excluded from the baseline so that
the anomaly being detected does not move the baseline it is measured against.

**Data quality gate.** Minimum 10 sales, and at least 3 separate weeks each containing 3
or more sales.

**Price window.** Median over approximately 3 weeks rather than a fixed count of sales.

Every constant above is unvalidated.

---

## Known defects

**Competitors listing during the week are measured only where the tracker has an earlier
reading.** Items without one are treated as before: an upper bound (the tag that said so
was removed 2026-09-16; the Listed/wk column on All items shows a dash). Until the
tracker has run for two weeks on the listings file (2026-09-29), every measured rate is
over a shorter period than intended and spread over a full week.

**A row in Your sales with the item left blank** matches any item's sale with the same
buyer, minute, quantity and price; two crafts sharing such a sale record would both take
the row out. Since v09.16.26.1 a row that names its item is only tried against that item,
and rows read from a screenshot always carry the name.

**Rows read from a screenshot are as good as the reading.** Measured 32 of 32 rows and 7
of 7 stack quantities on three screenshots, with 1 buyer of 32 misread ("Ahri Inori" as
`Ahrilnori`); a misread buyer's name (the field the game prints smallest) leaves the row
matching nothing, silently, and a price read with the gil glyph as an extra digit and no
comma (`349133` for 34,913) cannot be told from a real price. The rows are editable and
the status line after a scan says how many matched.

**Purchases between two readings are a floor for a fast seller.** The 200-sale history may
not reach back to the previous reading; the Listed/wk tooltip on All items says so when
that happens (the row tag was removed 2026-09-16).

**Sale history is capped at 200 records per item.** For furnishings that spans months. For
a fast-moving material it may cover only days, so demand for those is measured over a
shorter period than intended.

**Stackable materials are undervalued.** The tool assumes one listing holds one item,
which is true for furnishings and false for materials.

**Prices are home-world only.** Off-world purchases are priced at the local average
rather than the actual off-world price, which is usually lower.

**Intraday stockouts are invisible.** A shelf that empties at noon and refills by evening
is not detected by a daily reading taken around midday.

**Blanking a setup field does not restore its default.** An empty Safety margin reads as
0%, an empty Sales tax as 5%, and a 0 entered for tax also reads as 5%. Empty Slots per
bundle and Max of one item fall back to 20 and 10 rather than the page defaults of 40
and 20. Only matters if a field is cleared.

**With HQ only off, a craft's demand counts both qualities but its price and listings
are NQ.** Consistent for furnishings, which have no high-quality version. For gear, tick
HQ only, which makes all three HQ.
