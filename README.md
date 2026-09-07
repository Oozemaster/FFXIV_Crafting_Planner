# FFXIV Crafting Planner

Recommends what to craft and list each week, split into claimable **Bundles** so several
people can craft without flooding the same items.

**Use:** open the page, press **Load recipes**, then **Scan the market**. Claim a bundle
by number in Discord, craft it, list it.

**This document describes the tool as it is built today.** The shortage model designed on
2026-09-06 is not implemented — see [Designed but not built](#designed-but-not-built).

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

### Listing record (example, not current)

```
pricePerUnit   749             gil each
quantity       1               units in this listing
retainerName   "Lizianna"      selling retainer
listingID      "284993416..."  unique identifier for this listing
lastReviewTime 1788733770      ignored, see above
```

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
| Sale history fetched | Last **200 sales** per item | Count | Feeds both the market price and weekly demand. |
| Market price | Last **40 sales** of those | Count | Deliberate. The last 40 sales are what the item is selling for now, regardless of how long they took. |
| Weekly demand bands | **0-4 weeks at 50%**, **4-12 weeks at 30%**, **older at 20%** | Duration | Recent weeks count more without one quiet week dominating. |
| Listings fetched | Cheapest **30 listings** per item | Count | Competition depth and the material price ladder. Universalis returns listings cheapest first, so these are the only ones competing with you. |
| Price ladder retained | Cheapest **30** real listings | Count | Material cost calculation. |
| Staleness cutoff | **180 days** | Duration | Items whose last upload is older are dropped entirely. |
| Tracker sale window | Last **48 hours** per run | Duration | Overlaps the daily gap; duplicates are removed by matching timestamp, item, price and quantity. |

---

## Tracker files

Written to `data/` by a GitHub Action at 08:00 daily.

### `data/items.csv`

`itemId, name, category`. Rewritten every run. Currently 388 items.

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
| `sellers` | 6 | Number of distinct retainers, so one retainer holds two listings. |
| `minPrice` | 19,999 | Cheapest listing. |
| `maxPrice` | 200,000 | Most expensive listing. |
| `lastUpload` | 1788656373392 | Unix milliseconds. 26 hours before this reading. |

If `lastUpload` does not change between two dates, the second row is a repeat of the
first, not a new observation.

### `data/sales-YYYY-MM.csv`

One row per observed sale.

```
timestamp, itemId, pricePerUnit, quantity, hq
```

Deduplicated on all four of timestamp, itemId, price and quantity. Stored as individual
sales rather than daily totals so that any rate over any period can be derived later
without refetching.

---

## Calculations

### 1. Market price

Median of the last 40 recorded sales for that item, normal quality only.

```
marketPrice = median(prices of the last 40 sales)
```

Median rather than mean so a single unusual sale does not move it. A count rather than a
time period is deliberate: whether those 40 sales took three days or twenty weeks, they
are what the item is currently selling for. An item with no sale history at all is
dropped.

**Example — Glade Wardrobe.** One listing on the board at 999,999,999 gil. 25 recorded
sales between 9,500 and 45,999 gil, median 18,999. Priced at 18,999.

### 2. Real competition

```
realListings = listings priced at or below marketPrice x 2.0
supply       = sum of quantities across realListings
sellers      = count of distinct retainerName across realListings
```

Anything above the cutoff is excluded from competition and shown as "overpriced".

**Items with 30 or more real listings are dropped entirely.** Only the cheapest 30
listings are fetched. If the 30th is still below the junk cutoff there are more beyond it
that we cannot see, so `supply` would be a floor rather than a count — and 30 sellers
already ahead of you is not a market worth entering.

**Example — Cobalt Ingot.** 40 listings from 5 distinct retainers, 19 held by one of
them.

### 3. Listing price

```
listAt = min(cheapest real listing, marketPrice)
```

Where no real listings exist, `listAt` is `marketPrice` and the item is tagged "open
market".

### 4. Material cost

Listings are consumed cheapest first. Any shortfall beyond what your world has listed is
priced at the average of what was consumed, on the assumption of travelling to another
world.

```
walk realListings cheapest first until quantity is met
shortfall is priced at (gil spent so far) / (units bought so far)
```

Materials you gather yourself are priced at `marketPrice`, not zero, because the material
could have been sold instead.

**Example — Nymian Orb.** 12 listed on Seraph: one at 5,500, five between 7,000 and
7,500, six at 10,000.

| Units required | Total cost | Cost per unit |
|---|---|---|
| 6 | 42,199 | 7,033 |
| 12 | 102,199 | 8,517 |
| 42 | 357,697 | 8,517, of which 30 units off-world |

### 5. Weekly demand

Computed from the raw sale records. Each band's rate is units sold divided by the weeks
that band actually covers, so a band holding two weeks of history is not treated as four
empty ones. Bands with no history are dropped and the remaining weights renormalised.

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

### 6. How many to make

The gap between weekly demand and what is already listed, less a safety margin, rounded
up so the margin always bites.

```
gap       = max(0, weeklyDemand - supply)
safeUnits = floor(gap - ceil(gap x safetyMargin))
```

At the default 20%:

| Weekly demand | Listed now | Gap | Make |
|---|---|---|---|
| 20 | 5 | 15 | 12 |
| 44 | 20 | 24 | 19 |
| 7 | 1 | 6 | 4 |
| 8 | 9 | 0 | 0 |

An item with more listed than it sells in a week gets nothing.

The margin covers everything the model cannot see, chiefly competitors listing after you.
It leaves a shortage open rather than closing it, on the reasoning that the marginal
seller is the one who gets undercut.

### 7. Expected sales

```
expectedSales = min(yourUnits, weeklyDemand x yourUnits / (supply + yourUnits))
```

`supply` is what is listed at scan time. **Competitors who list during the week are not
modelled at all.** Every estimate is therefore an upper bound.

The `min(yourUnits, ...)` cap prevents the tool claiming sales above the number crafted.

### 8. Profit and ranking

```
profitEach   = (listAt x 0.90) - materialCost
valuePerSlot = expectedSales x profitEach
```

The 0.90 is the 10% market board sales tax.

### 9. Slot allocation

Slots are assigned one at a time. Each slot goes to whichever item gains the most from
receiving it, measured as the increase in `expectedSales x profitEach`. Because each
additional unit of an item is worth less than the previous one, slots distribute across
multiple items without any explicit diversification rule.

Bundles are then filled by repeatedly assigning the next item to whichever bundle
currently has the lowest total value. No item appears in two bundles.

### 10. Priority bands

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
| Junk listing cutoff | 2.0x market price | Listings above this multiple are excluded from competition. |
| Listings fetched | Cheapest 30 | Also the point at which an item counts as too crowded to enter. |
| Safety margin | 20% | Share of the demand-minus-supply gap deliberately left unfilled, rounded up. Covers competitors and anything else the model does not see. |
| Max of one item | 20 | Upper limit on units of a single item within one bundle. |
| Minimum sale price | 5,000 gil | Items below this are excluded. |
| Minimum sales per week | 1 | Items below this are excluded. |
| Staleness cutoff | 180 days | Items not uploaded within this period are excluded. |
| Vendor-cheap threshold | 100 gil | Materials a vendor sells below this are classed as buy rather than gather. |
| Priority bands | 50% / 80% | Cumulative share of a bundle's expected value. |
| Market price window | Last 40 sales | How many sales define the current price. |
| Demand weighting | 50% / 30% / 20% over 0-4, 4-12, 12+ weeks | How much recent weeks count toward demand. |
| Demand span floor | 1 week | Stops a single burst reading as a high weekly rate. |
| Recipe expansion depth | 6 levels | How far the raw material tree is followed. |

Fixed by the game: 10% sales tax; 40 listing slots per character.

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

**Competitors listing during the week are not modelled.** Only what is on the board at
scan time counts. Anyone listing after you takes sales the tool expected you to make, so
every estimate is an upper bound. The shortage model will supply a measured figure; until
then the tool is upfront about not tracking this rather than guessing at it.

**Sale history is capped at 200 records per item.** For furnishings that spans months. For
a fast-moving material it may cover only days, so demand for those is measured over a
shorter period than intended.

**Stackable materials are undervalued.** The tool assumes one listing holds one item,
which is true for furnishings and false for materials.

**Prices are home-world only.** Off-world purchases are priced at the local average
rather than the actual off-world price, which is usually lower.

**Intraday stockouts are invisible.** A shelf that empties at noon and refills by evening
is not detected by an 08:00 daily reading.
