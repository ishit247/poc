<meta charset="utf-8">

# Menu template seed plan (from `design/Menu/Page 1-6.avif`)

Status: **built** (decisions: diet added to the catalog; eggs are `egg`, not veg; spelling fixed). Seeded counts:
veg-only template 185 items, 16 categories, 12 pictures; veg + non-veg template 310 items (185 veg, 25 egg, 100 non-veg),
24 categories, 19 pictures. Fewer than the ~370 estimated below because the estimate was rough. Data: `scripts/menu-card.ts`,
photos: `scripts/assets/menu/`, seed: `scripts/seed.ts`. The original plan follows. Source: six menu-card pages, 375x545 px each, read by eye (low resolution; some
prices need a check, see "Risks").

## What the card contains

About 370 priced lines in these sections (page: sections):

| Page | Sections |
|---|---|
| 1 | Breakfast, Salad / Papad / Raita, Noodles |
| 2 | Soup, Roll, Momos, Bread Basket |
| 3 | Snacks / Starters (Veg column, Non-Veg column) |
| 4 | Rice / Biryani, Dal, Veg Dishes |
| 5 | Paneer, Mushroom, Chicken, Mutton, Prawn, Fish, Egg |
| 6 | Tandoori (Chicken, Veg, Fish / Prawn), Beverage / Dessert |

- Every line has a green (veg) or red (non-veg) square mark, except Salad/Raita, Bread Basket and Beverage, which are
  plain (treated as veg). Eggs carry the red mark on the card; our `diet` has an `egg` value, so Egg lines map to `egg`.
- Prices are whole rupees and **"GST 5% Extra"**, so they are tax-exclusive: `price_paise = rupees * 100`, `gst_rate_bp = 500`.
  That matches `catalog_item.price_paise` (tax-exclusive). HSN `996331` (restaurant service) for every line.
- A few lines have two prices (Tandoori Chicken half/full 369/519, Omelette 69/89/79, Tea/Coffee 25/35, Papad dry/fry 29/34).
  Template rows take one price, so: split into two items ("Tandoori Chicken (Half)", "(Full)"), and for the unclear ones
  keep the first price (decision below).

## Two templates

1. **"Restaurant menu, veg only"**: every veg line from every section (green mark and the unmarked sections).
   About 250 items. No chicken, mutton, prawn, fish or egg lines; Non-Veg column, Mutton, Prawn, Fish, Egg sections and
   Tandoori Chicken / Fish are omitted entirely (no empty categories).
2. **"Restaurant menu, veg + non-veg"**: the whole card, about 370 items, same category names as the card.

Veg is a strict subset of the full menu, built from one data table in the seed (each row has a `diet`), so the two
cannot drift apart.

## Schema change needed (first, in the original migration)

`catalog_item` has no diet column, so seeding a template into a tenant would lose the green/red mark that `item.diet`
(0003) holds. Per CLAUDE.md, fix it where it was written: add `diet text CHECK (diet IN ('veg','egg','non_veg'))` to
`catalog_item` in `db/migrations/0011_catalog.sql`, and make the tenant-seeding code in the API copy it to `item.diet`.
Then the CSV import/export in `docs/catalog-templates.md` gets an optional `diet` column. Reseed with the fresh-start command.

This touches platform-admin code, not just the seed, so it is a small API step on top of the seed.

## Seed layout

- New data file `scripts/menu-card.ts`: one array `[category, name, rupees, diet]` per line, with a `photo` key on the lines
  that get a picture. Both templates are generated from it (veg template = `diet === 'veg'`).
- `scripts/seed.ts`: replace the one "School cafeteria (sample)" block with a loop that inserts both templates, their
  categories (card order), items (`sort_order` follows the card), and `catalog_image` rows + objects (`putObject` under
  `c/<sha256>`, as the existing seed does for tenant pictures).
- The seeded tenants A and B keep their own small menus; they are not linked to the templates (unchanged).
- Add a test in the nearest existing test (`apps/api/test/`, catalog tests): veg template has no non-veg/egg item;
  full template item count equals veg + egg + non-veg count; every price is a whole-rupee multiple of 100 paise.

## Pictures: how many can I build

The card has **about 20 dish photos** (page 1: 5, page 2: 5, page 3: 4, page 4: 2, page 6: 4; page 5 has none). I cannot
generate photographs, but I can **crop those photos out of the card** (the pages decode on this machine) and store each
as a WebP/PNG under the 64 KB cap. Limits:

- They are about 90-100 px wide, so they look soft on a tablet (the app targets 320 px). Fine for a thumbnail, poor on a big tile.
- One photo shows one dish, so attach it only to the matching item rather than a whole category (e.g. the noodle bowl to
  "Veg Hakka Noodles" in the veg template and "Egg Chicken Noodles" is not given it). Realistically **~12 items in the
  veg template and ~20 in the full one** get a picture; the rest show no picture, which the app already supports.
- The photos that show meat (chicken starters on page 3, tandoori chicken and prawns on page 6, the chicken soup bowl)
  go only to the full template; page 3's veg-looking ones and the veg tandoori platter can serve veg items.

## Risks and what I need from you

- Text is small; I will transcribe all prices, then **you review a generated CSV/table** before it is seeded.
  Wrong digits are the likely error, not missing items.
- The card says "Chicken Lollypop", "Panner Tikka" etc.; I will keep the card's spelling except obvious typos
  (Noodel, Panner, Lollypop), unless you want the card verbatim.

## Steps

1. Transcribe the card to `scripts/menu-card.ts` (STANDARD model fits).
2. Add `diet` to `catalog_item` (0011) and the seeding copy in the API (touches platform routes; STANDARD, small).
3. Crop and store photos, `menu-card-photos/` under `design/Menu/` or `scripts/assets/`.
4. Seed loop, tests, run `up:fresh`, and open the platform console to look at both templates.
