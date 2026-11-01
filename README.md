# Mawaid Ingredient Calculator

Type the number of thaals, choose lunch or dinner, and add the dishes. The app shows how much of every ingredient is needed **per thaal** and **in total**. Press **Confirm & save** and the menu is saved to this repository, one file per day.

The quantities come from the past menu sheets. Each sheet row records the ingredients bought for a whole menu, such as Aloo Pitha + Dal Gosht + Chawal. The app compares hundreds of these menus to work out what each dish uses on its own.

## Using the app

| Tab | What it does |
| --- | --- |
| **Calculate** | Enter the date, Lunch or Dinner, the thaal count (`74+15` works too) and the dishes. Dish names autocomplete. You get a table with per-thaal and total quantities. You can change any total, remove an item, add an extra ingredient, see the list by dish, copy it for WhatsApp, or print it. Then press **Confirm & save**. |
| **History** | Every confirmed meal, newest first, read from the `data/` folder. You can search, open a meal, **Edit** it, **Use again** for another day, copy the list, or delete it. |
| **Dishes** | Every known dish with its per-thaal recipe and how often it was made. Here you can fix a recipe by hand or add a new dish that has no history yet. |
| **Settings** | Connect GitHub, import the history sheet, and see how well the formulas match the history. |

Colour dots on dishes show how reliable the numbers are. Green means the dish was made 5 or more times. Amber means 2 to 4 times. Red means once, so the numbers are a rough estimate. Blue means the recipe was entered by hand.

## Opening the app

These are static files, so there is no server to run.

- **GitHub Pages (recommended):** in the repo go to *Settings → Pages → Deploy from a branch → `main` / root*. The app will be at `https://tmoosabhoy6.github.io/Mawaid-ingredient-demand-calculator-/`, and it finds this repository automatically.
- **On a computer:** run `npm start` (or `python3 -m http.server 8000`) and open http://localhost:8000.

## Saving: the repo is the database

```
data/2026-11-01.json        one file per day: every confirmed meal that day
model/model.json            the learned per-thaal formulas (model.js is the same data for offline use)
model/manual-recipes.json   recipes entered or corrected by hand
model/aliases.json          spelling variants to merge (e.g. "alu pitha" -> "Aloo Pitha")
history/                    the original menu sheets
```

Each save goes to the device first and then to GitHub through the GitHub API. If there is no internet or no token yet, saves wait in a queue. The app retries every 30 seconds, so nothing is lost. The badge at the top right shows the state: **On this device**, **N waiting**, or **Saved to GitHub**.

**Connecting:** create a fine-grained personal access token that covers only this repository, with **Contents: Read and write**. Paste it in *Settings → Save to GitHub* and press **Save & test**. The token stays in that browser only and is never stored in the repo. Each phone or computer needs it entered once.

## Adding the real history

**From the app:** go to *Settings → Import menu history*. Upload the `.xlsx` or `.csv`, or copy the cells from Google Sheets and paste them. Check which column is which, press **Analyse**, then **Use & save to GitHub**.

**From the command line:** put the files in `history/`, then:

```bash
npm install          # only needed for .xlsx files
npm run build-model  # or: npm run build-model:with-confirmed
npm test
```

The importer expects one row per ingredient per menu. Column names are matched loosely. Date, meal, thaals and menu only need to appear on the first row of each menu. Dates are read day first (dd/mm/yyyy). Units such as kg, gm, ltr, ml, nos, dozen and pkt are converted automatically.

| Date | Meal | Thaals | Menu | Ingredient | Qty | Unit |
| --- | --- | --- | --- | --- | --- | --- |
| 01/04/2026 | Lunch | 74+15 | Aloo Pitha + Dal Gosht + Chawal | Onion | 18 | kg |
| | | | | Mutton | 40 | kg |

If the real sheets use a different layout, the importer in `js/engine.js` (`rowsToMenus`) is the only part that needs to change.

## How the formulas are worked out

For every ingredient, each past menu gives one equation:

```
amount used ÷ thaals  =  sum of (that ingredient's per-thaal amount for each dish on the menu)
                         + items served with every meal (salad, water, ...)
```

These equations are solved together across all menus. The fit uses non-negative least squares, so no quantity can come out below zero. This is the "exclusion method" done for every dish at once. For example, if Dal Gosht + Chawal used 10 kg of onion and Dal Gosht + Roti also used 10 kg, the onion comes from Dal Gosht. A few more rules apply:

- Dishes that only ever appeared together cannot be separated. The app says so, but the combined total is still right.
- If the exact same menu was made before, the app offers the average of those times instead.
- Recipes typed in the Dishes tab always replace the learned ones.

`npm test` checks this on made-up data (`tools/sample/`). The method recovers the hidden recipes to within about 1% on average.

> **The current formulas are SAMPLE data** so that the app can be tried out. A yellow banner shows this until the real history is imported.

## Files

```
index.html, css/style.css   the app
js/engine.js                parsing, units, training, calculation (shared by the app and the tools)
js/store.js                 GitHub saving, offline queue, history loading
js/app.js                   screens and interactions
js/config.js                default repository / branch
tools/                      build-model.js, make-sample.js, test-engine.js
```

Not built yet: pricing and cost per thaal, payment vouchers, and stock-out. Prices can be added later as one more column per ingredient.
