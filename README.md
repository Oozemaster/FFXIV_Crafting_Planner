# FFXIV Weekly Craft Planner

Tells you what to craft and list each week on the market board, and splits the work
into claimable **Bundles** so several people can craft without flooding the same items.

Built for Seraph (Dynamis), for players who restock once a weekend.

**To use it:** open the page, press **Load recipes**, then **Scan the market**. Claim a
bundle by number in Discord, craft it, list it.

---

## Where the data comes from

Two free public sources. Nothing is stored on a server — the page fetches everything
live in your browser.

| Source | What it provides |
|---|---|
| [Universalis](https://universalis.app) | Every recent sale on your world — when, price, quantity, buyer. Plus what is listed right now, at what price, by which retainer. |
| [XIVAPI](https://v2.xivapi.com) | Recipes and ingredients, item categories, what is gatherable, what vendors sell and for how much. |

Universalis also publishes convenient summary figures — sale velocity, average price,
listing counts. **The tool ignores most of them.** They are calculated over whatever
slice of data the request happened to ask for, and change depending on how much history
you request. The tool reads the raw sale records and does its own arithmetic instead.

---

## How it decides what to recommend

**1. What is it worth?** From what people actually paid recently, not what sellers are
asking. A single joke listing at a billion gil does not make an item valuable.

**2. What does it cost to make?** Ingredients priced at market value, walking the real
listing ladder — buying 40 of something costs more per unit than buying 4, because you
work up from the cheapest listing. Materials you gather yourself are still counted at
market price, because anything you dig up you could have sold instead. Gathering saves
you the gil, not the cost.

**3. Will it actually sell?** Compares weekly demand against what is already listed
against you, plus an allowance for rivals listing more during the week. Expected sales
are capped at what you actually made — you cannot sell ten of something you crafted
three of.

**4. What is one listing slot worth?** The scarce resource is retainer space, not gil
and not time. Everything is ranked by what a single slot earns in a week.

**5. Spread the risk.** Slots are handed out one at a time to whichever item gains most
from the next one. Because returns diminish, this naturally spreads across several items
instead of piling everything into the single best one.

**6. Split into bundles.** No two bundles share an item, so two people never craft the
same thing. Within a bundle, items are marked *Craft first*, *Craft next*, or *If time
allows* — if someone runs short on time, the top ones matter most.

---

## Numbers we chose ourselves

These are judgment calls, not facts about the game. They are the first things to adjust
when the recommendations feel wrong.

| Setting | Current | Why, and when to change it |
|---|---|---|
| Junk listing cutoff | **2.5×** | Listings priced above 2.5× the real sale price are ignored entirely and not counted as competition. Lower it if obvious troll listings still leak in. |
| Rival restocking | **100%** | Assumes rivals list about as many as sell each week. Lower it toward 50 if things sell better than predicted. |
| Max of one item | **20** | Stops a bundle becoming a single grind. Lower it for more variety per bundle. |
| Minimum sale price | **5,000 gil** | Ignores cheap items. Raise it to focus on higher-value crafts. |
| Minimum sales per week | **1** | Ignores items nobody buys. |
| Ignore data older than | **14 days** | Universalis data is uploaded by players; stale items get dropped. |
| Vendor-cheap threshold | **100 gil** | A material a vendor sells below this is "just buy it" rather than "go gather it". |
| Priority bands | **50% / 80%** | Items making up the first half of a bundle's value are *Craft first*; up to 80% is *Craft next*; the rest is *If time allows*. |

Fixed by the game, not by us: the **10% sales tax**, and **40 listing slots** per
character (two retainers, twenty each).

Set by choice: **recipe level 50 and under**, so every guild member can use the same
list regardless of their crafting levels.

---

## What it does not know

- Assumes one listing holds one item. True for furnishings, false for stackable
  materials, which are undervalued here.
- Prices come from your own world. Buying materials on another world is often cheaper;
  when your world runs short, the shortfall is priced at the same local average.
- Universalis only knows what players have uploaded. An item nobody has looked at
  recently has stale data.
- Weekly demand is measured over a short window, so items that sell in occasional
  bursts read as noisier than they are. **This is the biggest known source of error and
  is being fixed.**
- Real demand is unknowable when supply runs out — if everything listed sells, you learn
  what was supplied, not what people wanted.

---

## Planned: shortage detection

The current version compares a *rate* (weekly demand) against a *snapshot* (what is
listed right now), which flatters every recommendation. The fix is to record what is on
the market every day, building a history nobody currently has, so both sides can be
measured the same way.

Once roughly a month of data exists, the tool will look for items where supply has
genuinely fallen below normal demand — a real shortage worth filling, rather than a
market that is merely busy.

Proposed rules, all of which need real data before they can be trusted:

| Rule | Proposed | Reasoning |
|---|---|---|
| Shortage threshold | **25% of demand, or 3 items** | Whichever is larger. Below this it is normal week-to-week noise. |
| Confirmation | **2 consecutive weeks** | A single low week is usually one supplier taking a week off. Simulation says this cuts false alarms from ~30% to ~9%. |
| Safety buffer | **0.5 units per active retainer** | Deliberately undersupply so a gap remains. The more sellers watching an item, the more of them will also spot the opening. |
| Baseline weighting | **50 / 30 / 20** | Half the weight on the last month, 30% on the two months before, 20% on older data. The most recent week is excluded — otherwise the baseline chases the very anomaly it should be detecting. |
| Minimum data | **10 sales, and 3 separate weeks with 3+ sales each** | Twelve sales in one afternoon is one buyer's shopping trip, not a market. |
| Price used | **Median over ~3 weeks** | Median rather than average, so one spiky week does not drag the estimate up. |

Every number in that second table is a guess until a month of collection proves or
disproves it.
