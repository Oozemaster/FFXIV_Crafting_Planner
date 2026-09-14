# FFXIV Crafting Planner

Recommends what to craft and list each week, split into claimable **Bundles** so several
people can craft without flooding the same items.

**Use:** open the page, press **Load recipes**, then **Scan the market**. Claim a bundle
by number in Discord, craft it, list it.

**This document describes the tool as it is built today.** The shortage model designed on
2026-09-06 is not implemented — see [Designed but not built](#designed-but-not-built).

The page carries a version stamp beside its title, format `v[MM].[DD].[YY].[build]`. If it
does not match the version you last uploaded, the upload did not take. Current: `v09.13.26.3`.

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
| Sale history fetched | Last **200 sales** per item, any quality | Count | Feeds both the market price and weekly demand. Deliberately a count, not a period: a fast mover's 200 sales may span three weeks and a slow one's two years. Measured 2026-09-13: Wooden Loft 2.8 weeks, Wine Barrel 8.1, Masonwork Interior Wall 15, Riviera Wardrobe 75. Universalis would return up to 999, reaching about 201 weeks back; 200 was kept to limit request size. |
| Market price | Last **40 sales** of those, of the quality being priced (see Quality) | Count | Deliberate. The last 40 sales are what the item is selling for now, regardless of how long they took. |
| Weekly demand bands | **0-4 weeks at 50%**, **4-12 weeks at 30%**, **older at 20%** | Duration | Recent weeks count more without one quiet week dominating. All qualities count. |
| Listings fetched | Cheapest **20 listings** per item | Count | Competition depth and the material price ladder. Universalis returns listings cheapest first, so these are the only ones competing with you. Both qualities are kept and flagged; a craft counts only the quality it is sold as (see Quality). Your own retainers' listings are kept and flagged. |
| Price ladder retained | Cheapest **20** real listings of either quality, your own excluded | Count | Material cost calculation. |
| Staleness cutoff | **180 days** | Duration | Items whose last upload is older are dropped entirely. |
| Supply-age warning | **24 hours** | Duration | Items whose last upload is older than this are kept, but tagged with the age of the reading, because the supply count is that old. |
| Tracker sale window | Last **48 hours** per run | Duration | Overlaps the daily gap; duplicates are removed by matching timestamp, item, price and quantity. |

### Quality

HQ versus NQ is a question about the thing you sell, never about the things you buy.
Shaun, 2026-09-13.

**Crafts.** The **HQ only** box in the setup panel, off by default, means "sell as high
quality". When ticked, every craft in the scan that the game allows an HQ version of gets
its three numbers from HQ data alone — the 40-sale median from HQ sales, weekly demand
from HQ sales, current listings from HQ listings, and the one-gil undercut against the
cheapest HQ rival — requested from Universalis with its `hq=true` filter, which matters
because the 20 cheapest of a mixed list could all be NQ. Crafts with no HQ version, which
is every furnishing, behave exactly as with the box off. Rows sold as HQ are tagged "HQ".
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
scheduled jobs on time: the first 7 runs (2026-09-07 to 2026-09-13) started between 16:17
and 17:18 UTC, which is 11:17 to 12:18 Central. Treat each reading as a midday one.

### `data/items.csv`

`itemId, name, category`. Rewritten every run. 388 items through 2026-09-13; 398 from the
next run, after the 10 Ceiling Light recipes were added to the tracker's category filter
(it had not matched the planner's Furnishings group).

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

**Your own retainers** are named in the setup field (default `Spicy-soy, Momo-mochi`,
matched case-insensitively). Their listings **count as supply whatever they are priced
at**, above the junk cutoff included: ten of yours already on the board means ten fewer to
make, and repricing them is your call. They are never undercut (section 3) and never
bought from (section 4). The row is tagged "N yours listed".

**Supply age.** If the item's last Universalis upload is more than 24 hours old, the row is
tagged "supply N old" — the supply figure is from that moment and listings may have
appeared since. Over 7 days the tag reads "stale".

**Items with 20 or more real listings are dropped entirely.** Only the cheapest 20
listings are fetched. If the 20th is still below the junk cutoff there are more beyond it
that we cannot see, so `supply` would be a floor rather than a count — and 20 already
ahead of you is not a market worth entering.

**Example — Cobalt Ingot.** 40 listings from 5 distinct retainers, 19 held by one of
them.

### 3. Listing price

```
listAt = max(1, min(cheapest rival listing - 1, marketPrice))
```

The board sells cheapest first and a tie loses, so it goes one gil under the cheapest
rival, or lower still if sales say the item is worth less. Your own listings are not
rivals; undercutting yourself helps nobody.

Where no rival listings exist, `listAt` is `marketPrice` and the item is tagged "open
market".

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

A row whose materials ran short is tagged "short: material name" and the tooltip says how
many were needed, how many were listed, and whether the material has a recipe or can be
gathered.

**A material with no sale history is costed at zero**, on the rule agreed 2026-09-13:
what nobody has bought cannot be sold either, so using it costs nothing. The row is tagged
"material unpriced". Measured 2026-09-13: of the 288 materials reachable from the 398
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
| 42 | 330,199 | 7,862 | 30 units beyond the board, at 8,000 each. Tagged "short". |

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

An item with more listed than it sells in a week gets nothing. An incoming-supply term
will be subtracted alongside `supply` once the tracker can measure it.

The margin covers everything the model cannot see, chiefly competitors listing after you.
It leaves a shortage open rather than closing it, on the reasoning that the marginal
seller is the one who gets undercut.

### 7. Profit and ranking

```
profitEach = (listAt x 0.90) - materialCost
```

The 0.90 is the 10% market board sales tax. For ranking, `materialCost` is each
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
members compete on the same item. When no bundle has room for the whole quantity, the
item is cut down to the largest free space anywhere, the row is tagged "cut from N", and
the summary says so. Allocation then runs again with that item capped, so the freed slots
go to the next-best item rather than sitting empty.

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
| Junk listing cutoff | 2.0x market price | Listings above this multiple are excluded from competition. |
| Listings fetched | Cheapest 20 | Also the point at which an item counts as too crowded to enter. |
| Safety margin | 20% | Share of the demand-minus-supply gap deliberately left unfilled. Covers competitors and anything else the model does not see. |
| Max of one item | 20 | Upper limit on units of a single item within one bundle. |
| Minimum sale price | 5,000 gil | Items below this are excluded. |
| Minimum sales per week | 1 | Items below this are excluded. |
| Staleness cutoff | 180 days | Items not uploaded within this period are excluded. |
| Supply-age warning | 24 hours | Items not uploaded within this period are tagged with the age of the reading. |
| Own retainers | Spicy-soy, Momo-mochi | Listings from these count as supply but are never undercut or bought from. Editable in the setup panel. |
| Material price cap | 1.0x market price | No unit of material is ever charged above the median of its last 40 sales. |
| Vendor-cheap threshold | 100 gil | Materials a vendor sells below this are classed as buy rather than gather. |
| Priority bands | 50% / 80% | Cumulative share of a bundle's expected value. |
| Market price window | Last 40 sales | How many sales define the current price. |
| Demand weighting | 50% / 30% / 20% over 0-4, 4-12, 12+ weeks | How much recent weeks count toward demand. |
| Demand span floor | 1 week | Stops a single burst reading as a high weekly rate. |
| Recipe expansion depth | 6 levels | How far the raw material tree is followed. |
| Unpriced material | 0 gil | A material with no sale history costs nothing. Rule of 2026-09-13. |
| Failed request retry | Once, after 3 seconds | A Universalis request that fails three times in a row is tried once more at the end of the scan. |

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
is not detected by a daily reading taken around midday.

**Blanking a setup field does not restore its default.** An empty Safety margin reads as
0%, an empty Sales tax as 10%, and a 0 entered for tax also reads as 10%. Empty Slots per
bundle and Max of one item fall back to 20 and 10 rather than the page defaults of 40
and 20. Only matters if a field is cleared.

**With HQ only off, a craft's demand counts both qualities but its price and listings
are NQ.** Consistent for furnishings, which have no high-quality version. For gear, tick
HQ only, which makes all three HQ.
