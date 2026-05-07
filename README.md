# Pivot Irrigation Dealer Map

Interactive Leaflet map of US center-pivot irrigation dealers (Reinke, Valley, Zimmatic) overlaid with USDA 2022 county-level irrigated acreage.

## Features

- **Brand toggles** — Reinke, Valley, Zimmatic (652 total US dealers, 649 geocoded)
- **County choropleth** — 2022 irrigated acres, teal-to-magenta scale
- **County popups** — 2022/2007 acres, 15-year % change, FIPS, state gap classification
- **Service radius rings** — Off / 25 / 50 / 100 / 150 / 200 mi
- **Search** — dealers and counties
- **Marker clustering** at low zoom
- **Light/dark mode** based on system preference
- **Mobile responsive** with collapsible sidebar

## Run locally

```bash
python3 -m http.server 5000
```

Then open http://localhost:5000.

## Data sources

- **USDA Census of Agriculture** (2007, 2022) — county-level irrigated acres
- **Reinke** dealer locator (`https://www.reinke.com/find-a-dealer`)
- **Valley** dealer locator (`https://www.valleyirrigation.com/dealer-locator`)
- **Lindsay/Zimmatic** dealer locator (`https://www.lindsay.com/usca/en/dealer-locator`)
- County GeoJSON: [plotly/datasets](https://github.com/plotly/datasets)

## Project structure

```
dealer-map/
├── index.html
├── style.css
├── app.js
├── prepare_data.py        # geocoding + data prep
└── data/
    ├── dealers.json       # 649 geocoded dealers
    ├── counties.json      # 2,848 counties (2022 acres + growth)
    └── us-counties.json   # GeoJSON boundaries
```

## Key finding

The single defensible commercial gap is the **Mississippi Delta** (AR, MS, LA): ~7.96M irrigated acres but only 15 dealer locations across all three brands combined. Arkansas is worst-served at 678,457 acres per dealer.
