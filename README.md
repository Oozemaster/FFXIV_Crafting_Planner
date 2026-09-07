# FFXIV Weekly Craft Planner

Tells you what to craft and list each week, and splits the work into claimable
**Bundles** so several people can craft without flooding the same items.

**To use it:** open the page, press **Load recipes**, then **Scan the market**. Claim a
bundle by number in Discord, craft it, list it.

Everything below is the workshop manual — what the tool sees, what it does with it, and
how to tell when something has gone wrong. You do not need it to use the tool.

- [What the tool actually sees](#what-the-tool-actually-sees)
- [The tracker files](#the-tracker-files)
- [Every calculation, in plain English and in maths](#every-calculation)
- [Diagnosing a bad recommendation](#diagnosing-a-bad-recommendation)
- [Numbers we chose ourselves](#numbers-we-chose-ourselves)
- [What it cannot know](#what-it-cannot-know)

---

## What the tool actually sees

Two free websites. Nothing is stored on a server — your browser fetches it all live.

**XIVAPI** knows the game's own files: every recipe, its ingredients, what category an
item is, whether it can be sold at all, what a vendor charges, what can be gathered.
This data never changes except when Square Enix patches the game.

**Universalis** knows the market board. Players run an uploader that reports what they
see, so Universalis knows whatever somebody last looked at. This is the part that can be
stale or missing.

### A sale record — this is literally everything we get

```
timestamp     1788725070      when it sold, to the second
pricePerUnit  900             gil each
quantity      1               how many in that one purchase
hq            false           high quality or not
buyerName     "Mike Kelvin"   who bought it
```

Five facts. That's the whole record. Anything else about sales is us doing arithmetic.

### A listing record — what is on the board right now

```
pricePerUnit   749             gil each
quantity       1               how many in this listing
retainerName   "Lizianna"      which retainer is selling it
listingID      "284993416..."  a unique tag for this listing
lastReviewTime 1788733770      unreliable, ignored (see below)
```

### The one field that matters most: last upload time

Every item carries a timestamp saying **when a player last looked at it**. This is the
single most important thing to understand about the data, because:

- If nobody has viewed an item in three weeks, Universalis still cheerfully reports
  numbers. They are three weeks old.
- An item showing **0 listings with no upload time** means *nobody has ever looked*, not
  *the shelf is empty*. Those are completely different and must never be confused.

From the first tracker run, ages of readings ranged from **30 minutes to 21 days**, and
only about **29%** had been refreshed within a day.

### Things we deliberately ignore

| Field | Why ignored |
|---|---|
| `regularSaleVelocity` and friends | Universalis' own "sales per day" figure. It changes depending on how much history you ask for — the same item returned 0, 83, and 1,320 per day for three different requests. We count the raw sales ourselves. |
| `averagePrice`, `currentAveragePrice` | Same problem — computed over whatever slice was requested. |
| `unitsForSale`, `listingsCount` | Capped by how many listings we asked for. Asking for 20 made every crowded item report exactly 20. We count the listings we received. |
| `lastReviewTime` on listings | Looked like it might reveal how long a listing had sat there. All 40 listings of one item shared the same value to the second — it reflects the upload, not the listing. Useless. |

**The rule: read raw records, do our own arithmetic.** Every summary number this project
trusted from an API turned out to depend on how the question was asked.

---

## The tracker files

The tracker runs at 8am daily on GitHub's machines and writes to `data/`.

### `data/items.csv` — the watch list

`itemId, name, category`. Refreshed every run, so a patch that adds furnishings gets
picked up without anyone editing anything. Currently 388 items.

### `data/stock-YYYY-MM.csv` — one row per item per day

A real row, decoded:

```
2026-09-07 , 6347 , 7 , 7 , 6 , 19999 , 200000 , 1788656373392
```

| Column | This row | Means |
|---|---|---|
| date | 2026-09-07 | the morning it was recorded |
| itemId | 6347 | look it up in `items.csv` |
| unitsListed | 7 | seven of them on the board |
| listings | 7 | across seven separate listings |
| sellers | 6 | belonging to six different retainers — so one person has two |
| minPrice | 19,999 | cheapest one |
| maxPrice | 200,000 | dearest one. A 10x spread usually means a silly listing at the top |
| lastUpload | 1788656373392 | when a player last looked. **26 hours before this reading** |

That last column is how you tell a real observation from a stale echo. If it does not
change between two days, that day's row is the same reading copied over, not news.

### `data/sales-YYYY-MM.csv` — one row per sale ever observed

```
timestamp, itemId, pricePerUnit, quantity, hq
```

Deduplicated, so the overlapping daily windows never double-count. Stored as individual
sales rather than daily totals **on purpose** — any rate over any window can be worked
out later without re-fetching, and we are never stuck with somebody else's summary.

---

## Every calculation

Each one below: what it does in plain words, then the actual formula, then a real
example from Seraph.

### 1. What is this item worth?

**Plain English:** take every sale we have seen recently and use the middle one. Not the
average, because a single 500,000 gil sale would drag it up. Not what people are asking,
because anyone can list a chair for a billion gil.

```
marketPrice = median(prices of all recent sales)
```

**Real example — Glade Wardrobe.** One listing on the board, at 999,999,999 gil. Its 25
actual sales ran from 9,500 to 45,999, median **18,999**. The tool prices it at 18,999
and treats the billion-gil listing as scenery. An earlier version used the cheapest
listing and made this the single best item on the board.

### 2. Which listings are real competition?

**Plain English:** ignore anything priced more than two and a half times what the item
genuinely sells for. Nobody is buying those, so they are not competing with you.

```
realListings = listings where price <= marketPrice x 2.5
supply       = total units across those listings
sellers      = how many different retainers those belong to
```

**Real example — Cobalt Ingot.** 40 listings, but only **5 different retainers**, and 19
of the 40 belonged to one person. Counting listings says "crowded". Counting people says
otherwise.

### 3. What price should you list at?

**Plain English:** undercut the cheapest real listing, but never assume you will get more
than the item genuinely sells for.

```
listAt = min( cheapest real listing , marketPrice )
```

If nothing is listed at all, use marketPrice, and the item gets an **open market** tag.

### 4. What do the materials cost?

**Plain English:** you buy the cheapest listing first, then the next cheapest, and so on.
Buying forty of something costs more per unit than buying four. If your world runs out,
you can travel to another world, so the rest are priced at the same average.

```
walk the listings cheapest first until you have enough
any shortfall is priced at the average of what you did buy
```

**Real example — Nymian Orb.** Seraph had twelve: one at 5,500, five between 7,000 and
7,500, six at 10,000.

| You need | It costs | Per unit |
|---|---|---|
| 6 | 42,199 | 7,033 |
| 12 | 102,199 | 8,517 |
| 42 | 357,697 | 8,517 (30 bought off-world) |

An earlier version priced all 42 at 5,500 and overstated the bundle by a million gil.

**Materials you gather yourself still count at market price.** A log you dug up could
have been sold, so using it costs you what it was worth. Gathering saves you the gil, not
the cost.

### 5. Will it actually sell?

**Plain English:** you are splitting demand with everyone else selling it — both what is
already listed, and what rivals will list during the week. And you cannot sell more than
you made.

```
rivals        = unitsAlreadyListed + (weeklyDemand x rivalRestocking)
expectedSales = min( yourUnits , weeklyDemand x yourUnits / (rivals + yourUnits) )
```

`rivalRestocking` defaults to 1, meaning rivals list about as many as sell each week —
which they must, in a settled market, since every unit sold was listed by somebody.

**Why the cap matters:** without `min(yourUnits, ...)` the tool once claimed you would
sell 32 lanterns when the bundle told you to craft 11. That single bug overstated a week
by roughly two times.

### 6. What is one listing slot worth?

**Plain English:** you only have forty slots. The question is never "is this profitable"
but "is this the best thing to put in a slot".

```
profitEach     = (listAt x 0.90) - materialCost      the 0.90 is the 10% sales tax
valuePerSlot   = expectedSales x profitEach
```

### 7. How the slots get handed out

**Plain English:** give away one slot at a time, always to whichever item gains most from
getting the next one. Because each extra copy of an item is worth less than the last, the
slots naturally spread across several items instead of piling into the single best one.

Then split into bundles by repeatedly giving the next item to whichever bundle is
currently worth least, so bundles come out roughly even and no two share an item.

### 8. Craft first, craft next, if time allows

**Plain English:** the items making up the first half of a bundle's value are *Craft
first*. Up to 80% is *Craft next*. The rest is *If time allows*. So if somebody bails
halfway through, the important ones are already done.

---

## Diagnosing a bad recommendation

| What you see | What it usually means | Where to look |
|---|---|---|
| An item looks absurdly profitable | Its market price came from very few sales, or one odd sale | Check `sales-YYYY-MM.csv` for that itemId — how many sales, how spread out |
| An item you know sells well is missing | Filtered out before ranking | Lower **Min sale price**, lower **Min sales per week**, or raise **Ignore data older than** |
| Numbers swing a lot between two scans | Thin sale history, so the median jumps when one sale enters or leaves | Same file — few rows means an unstable price |
| A bundle is nearly all one item | The per-item cap is doing its job but is set high | Lower **Max of one item** |
| **travel to buy** on many items | Your world is thin on those materials | Not an error — it is telling you to shop off-world |
| **stale** tag | Nobody has looked at that item in over a week | Nothing to fix. The tag is the warning |
| **open market** but it never sells | Proven past demand, nothing listed now — but demand may have moved on | Check the sale dates in `sales-YYYY-MM.csv`; if they are all old, the market died |
| Stock reads 0 every single day | Either genuinely empty, or never uploaded | Check `lastUpload` in `stock-YYYY-MM.csv`. **0 means never seen, not empty** |
| A whole day of tracker rows looks identical to yesterday | Universalis was not refreshed for those items | Compare the `lastUpload` column between the two days |
| Everything got less profitable after an update | We probably corrected an assumption that was flattering the numbers | Check the git history on this file |

### Sanity checks you can run any time

- Pick a recommended item, open its wiki link, and check the recipe matches.
- Search that itemId in `sales-YYYY-MM.csv`. Fewer than about ten sales means treat the
  price as a guess.
- Compare **minPrice** and **maxPrice** in the stock file. A gap of more than about 10x
  means somebody is parking a silly price, which is expected and handled.
- After listing something, note what it actually sold for. That is the only number in
  this whole project that is not an estimate.

---

## Numbers we chose ourselves

Judgment calls, not facts about the game. First things to adjust when recommendations
feel wrong.

| Setting | Current | What it does |
|---|---|---|
| Junk listing cutoff | **2.5x** | Listings above this multiple of the real sale price are ignored entirely |
| Rival restocking | **100%** | How much rivals are assumed to list during the week. Lower toward 50 if things sell better than predicted |
| Max of one item | **20** | Stops a bundle becoming a single grind |
| Minimum sale price | **5,000 gil** | Ignores cheap items |
| Minimum sales per week | **1** | Ignores items nobody buys |
| Ignore data older than | **14 days** | Drops items whose data is too old to trust |
| Vendor-cheap threshold | **100 gil** | Below this, a vendor material is "just buy it" rather than "go gather it" |
| Priority bands | **50% / 80%** | Where *Craft first* ends and *Craft next* begins |

Fixed by the game: the **10% sales tax**, **40 listing slots** (two retainers, twenty
each). Set by choice: **recipe level 50 and under**, so every guild member can use the
same list.

---

## What it cannot know

- **Real demand, when supply runs out.** If everything listed sells, you learn what was
  supplied, not what people wanted. The tracker exists to fix this.
- **Whether a stockout happened between two 8am readings.** A shelf can empty at noon and
  be refilled by evening and we would never see it.
- **Historical stock.** Universalis keeps only what is listed right now. Anything about
  the past board comes from our own tracker, starting 2026-09-07.
- Assumes one listing holds one item. True for furnishings, false for stackable materials.
- Prices are from your own world only.
- Weekly demand currently comes from a short window, so items selling in occasional bursts
  read as noisier than they are. **Largest known error, being fixed.**
