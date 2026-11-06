# joinfs-proximity-chart

Interactive d3 chart of how close aircraft types are to each other, using the same similarity rules JoinFS uses to pick a stand-in model (`JoinFS/docs/model-matching.md`, sections 5-8). Shipped as a self-contained web component; the aircraft data lives in separate files that are loaded lazily, so updating the data means replacing a file.

Each aircraft type is a node labelled with its ICAO type designator. Each node is linked to its most similar types (force-directed layout, so similar types end up close together). Hover for name and manufacturer; click a node to dim everything but its ten most similar types and to list them in the side panel, with a "why" breakdown per feature.

## Embedding

Put these files in one folder on your web server:

- `joinfs-proximity-chart.js` (the component, d3 is bundled in)
- `aircraft-specs.json`, `doc8643.json`, `airlines.json` (data, fetched when the element is connected)
- `joinfs-proximity-chart-<locale>.json` (translations, fetched on demand)

```html
<joinfs-proximity-chart></joinfs-proximity-chart>
<script src="/charts/joinfs-proximity-chart.js"></script>
```

Data and language files are resolved relative to the script's own URL, so the page may live anywhere. Loading from a `file://` page works only in English and without data (browsers block `fetch`); serve the folder, e.g. `python -m http.server`.

| Attribute | Meaning |
|---|---|
| `lang` | Language (observed; can change at runtime). Default: browser languages, else `en`. |
| `src` | Aircraft data, default `aircraft-specs.json` (relative to the script). |
| `focus` | ICAO type (or alias) to select, e.g. `focus="A320"` (also `element.focus('A320')`). |
| `search` | Search text (ICAO type, alias, name, manufacturer, title hint). Without `focus`, the best match is selected, as if the text had been typed into the form and confirmed. |
| `theme` | `light` or `dark` forces a theme; default follows the system and changes live with it. The demo page has no language or theme switch: both are auto-detected (`?lang=` and `?theme=` still override them). |
| `color-by` | `engineType` (default), `manufacturer`, `wing` or `gear`. |
| `engine-type`, `engines`, `wing`, `gear`, `manufacturer` | Filters; values as in the data (`piston`, `2`, `high`, `tricycle`, `Cessna`). |
| `callsign` | Callsign or airline to match: an ICAO callsign or code (`DLH123`, `DLH`) or an airline name (`Lufthansa`). The airline is looked up in the loaded models list itself (its airline code column and livery names); the toolbar shows which one was found. That airline's liveries are listed first and an installed type that has one is preferred as the best match (unless it is more than 15 points less similar). Without a models list it has no effect. |
| `aircraft-title` | Title of the remote aircraft (not `title`, which is the browser's tooltip attribute). For a collapsed ICAO designator (`GLID`, `GLIM`, `UHEL` ...) the title picks the line of the data that describes the aircraft (its title hints), and with a models list the installed model JoinFS would inject is marked. Select the designator first (`search=GLID`). Without a models list it only picks the line. |
| `k` | Neighbours per aircraft used for links (1-12, default 10). |
| `min-proximity` | Minimum proximity in percent for links (default 20). |
| `show-uninstalled` | `true` also lists aircraft that are not installed in the sidebar (only with a models list loaded; default: installed types only). Also a checkbox in *Filters & view*. |

## Installed models and liveries

"Load installed models…" takes a JoinFS models list (`models - <simulator>.txt`, e.g. `%LocalAppData%JoinFS-FS2024models - Microsoft Flight Simulator 2024.txt`). It is read in the browser and never uploaded. Each model is assigned to the aircraft whose ICAO type or alias equals the model's ICAO type (field 9; models without one are ignored); the component can also be given the text with `element.loadModels(text, name)`.

- **The answer is JoinFS' answer.** With a models list loaded, the aircraft that is marked (check, first livery, "most similar" list) is the installed model JoinFS' own matcher would inject for the selected type, the callsign's airline and the title: the same scoring (exact type, airline, class code, wake, size and speed similarity, near-identical bonus, plausibility gate), written down once more in `src/joinfs-matcher.js`. So the right airline on a look-alike beats the exact type of another airline exactly as in JoinFS (a `B739` with the callsign `RYR` shows the Ryanair `B738`), and nothing beats an exact type when the airline is not installed in a family JoinFS knows. `doc8643.json` (class code and wake per designator) and `airlines.json` (ICAO airlines) are generated from the JoinFS resources by `npm run sync-data`; without them the map falls back to type proximity (attributes `doc8643-src`, `airlines-src` name other locations). The test `test/joinfs-parity.test.mjs` runs 281 scenarios that JoinFS' own tests wrote to `test/fixtures/MatchScenarios.json` (winner, total points and match type must be identical); after a change of JoinFS' matching, regenerate them there (`JOINFS_UPDATE_GOLDEN=1`) and run `npm run sync-data`.
- **Collapsed designators** (`GLID`, `GLIM`, `UHEL`, `GYRO`, `BALL` ...): ICAO uses one code for many aircraft, so the data holds generic class lines for them (manufacturer `-`, e.g. "Glider, 15 m class"). They only supply parameters (size, weight, speed, wing, gear) for titles that list them as a hint; they are never an aircraft to inject and are dimmed as not installed, except as the place of the injected model. With a title the map shows the model JoinFS would inject: same title hint first, then the same kind of aircraft, then the closest parameters, the generic model only as a last resort. The same scenarios run against JoinFS' own matcher (`test/fixtures/folded-scenarios.json`).
- **The model set's own types:** while a models list is loaded, tags it uses that the data does not know (e.g. `SZD30`, `AS7`, `LS4`, `JS3-15`) get a node of their own, with the parameters of the class line that lists their title hint and name/manufacturer from the list. The data file only carries real type designators; the nodes disappear with "Remove model list".
- Aircraft without an installed model stay visible, in the chart and in the "most similar aircraft" list, but dimmed. Installed ones carry a green ✔ in the list; the selected installed aircraft gets one in the chart and the side panel.
- The side panel of an installed aircraft lists its liveries (the variation column), with a filter field. Click one to choose it (green ✔); `joinfs-proximity-livery` fires with `detail: { icao, title, livery }`.

Colour-by, the five filters (engine type, engines, wing, landing gear, manufacturer) and the neighbour and proximity sliders live in a modal dialog behind the "Filters & view" button, which shows the number of active filters.

CSS custom property `--joinfs-proximity-height` sets the height (default `680px`). The element fires `joinfs-proximity-select` (`detail: { icao, neighbours }`) when an aircraft is selected.

The component fires `joinfs-proximity-change` whenever the user changes a control; `detail` holds the non-default form state under the attribute names (also readable as `element.state`).

`index.html` is a demo page: every attribute above is accepted as a query string parameter, and the address bar follows the form, so a view can be shared, e.g. `?lang=de&search=cardinal&color-by=manufacturer&engine-type=piston&wing=high&k=6&min-proximity=40&focus=C177`. `q`, `s` and `icao` are aliases of `search` (`?q=C177`, `?s=C177`, `?icao=C177`; if several are given, `search` wins, then `q`, `s`, `icao`): opening the demo page with an ICAO type shows the chart as if that type had been searched for in the form (this is the link to use from JoinFS). The component itself never reads the URL.

## Languages

English is built into the script. `de, es, fr, it, ko, nl, pt, uk` are `joinfs-proximity-chart-<locale>.json` files next to the script (the locales JoinFS ships, plus Ukrainian). Regional tags reduce to the primary subtag (`pt-BR` becomes `pt`). A language file that can't be loaded is reported with `console.warn` and the component continues in English.

To add a translation: copy one JSON file, rename it to the new locale, translate the values (keep the keys and `{placeholders}`), add the locale to `LOCALES` in `src/i18n.js`, run `npm run check-locales` and `npm run build`.

## Installed model: livery before exact type (airliners)

For an airliner request, an installed model of the requested airline that is at least 80 % alike (physical score) ranks above every model without that airline, even above the exact ICAO type. The airline must be certain: a known ICAO airline code that was given, or a callsign like `UAE123` (a registration such as `N748UA` never counts, and neither does an airline only guessed from the title). Helicopters, balloons, gliders, motor gliders and light general aviation (wake category L) keep "exact type first". Both the requested and the installed type must be airliners.

## Proximity

Per pair of types (`src/proximity.js`):

- **Physical similarity**: weight (3.0), wing span (2.0), length (1.5), cruise speed (2.0), engine count (2.0), engine type (2.0), wing position (1.0), landing gear (1.5). The numeric features use a log ratio that saturates at a factor of 4 (weight) or 2 (the others). Points = round(100 x score x confidence).
- **Same manufacturer** +40, if both are rotorcraft or both fixed wing and the weights are within a factor of 2.5.
- **Almost identical** up to +60 (`NEAR_MAX`): rises smoothly from 0 at a physical score of 0.8 to the maximum at identical specs, scaled by the confidence, and only when at least 75 % of the weighted features are known. There is no list of aircraft families any more: how alike two aircraft are decides.
- **Plausibility gate**: rotorcraft vs fixed wing, or weights differing by more than a factor of 8, are never neighbours.
- A pair is accepted when the physical score is at least 0.5. The percentage shown is points / 200.

Not included: the identity points (class code, wake category, airline) that JoinFS adds when matching an installed model, because the spec file has no such data.

## Development

```
npm install
npm run build          # bundle src/ into joinfs-proximity-chart.js
npm test               # algorithm tests
npm run check-locales  # key/placeholder parity of all language files
npm run sync-data      # copy aircraft-specs.json and derive doc8643.json / airlines.json from the JoinFS repository
```
