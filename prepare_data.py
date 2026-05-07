"""Prepare data for the dealer map web app.
Outputs three JSON files into ./data/:
  - dealers.json : array of {id, brand, name, address, city, state, zip, phone, lat, lng}
  - counties.json: {fips: {name, state, acres_2022, acres_2007, growth, irrigated_pct?}}
  - us-counties.json: TopoJSON/GeoJSON of US counties
"""
import csv, json, os, re, urllib.request
from collections import defaultdict
import pgeocode

DEALER_FILES = {
    "Reinke":   "/home/user/workspace/reinke_us_dealers_final.csv",
    "Valley":   "/home/user/workspace/valley_us_dealers_final.csv",
    "Zimmatic": "/home/user/workspace/zimmatic_us_dealers_final.csv",
}

OUT_DIR = "/home/user/workspace/dealer-map/data"
os.makedirs(OUT_DIR, exist_ok=True)

# ============================================================
# 1) Geocode dealers via ZIP centroid
# ============================================================
nomi = pgeocode.Nominatim('us')

# Cache ZIP -> (lat, lng, place, county) to avoid duplicate lookups
zip_cache = {}
def geocode_zip(z):
    if not z: return (None, None, None, None)
    z = str(z).strip().split('-')[0].zfill(5)
    if z in zip_cache: return zip_cache[z]
    try:
        r = nomi.query_postal_code(z)
        lat, lng = r.latitude, r.longitude
        if lat != lat or lng != lng:  # NaN
            zip_cache[z] = (None, None, None, None)
            return zip_cache[z]
        zip_cache[z] = (float(lat), float(lng), str(r.place_name), str(r.county_name))
        return zip_cache[z]
    except Exception:
        zip_cache[z] = (None, None, None, None)
        return zip_cache[z]

dealers = []
dealer_id = 0
for brand, path in DEALER_FILES.items():
    with open(path) as f:
        for row in csv.DictReader(f):
            zip_clean = (row.get('zip') or '').strip().split('-')[0]
            lat, lng, place, county = geocode_zip(zip_clean)
            if lat is None or lng is None:
                continue
            dealer_id += 1
            dealers.append({
                'id': dealer_id,
                'brand': brand,
                'name': row.get('dealer_name', '').strip(),
                'address': row.get('address', '').strip(),
                'city': row.get('city', '').strip(),
                'state': row.get('state', '').strip(),
                'zip': zip_clean,
                'phone': (row.get('phone') or '').strip(),
                'lat': round(lat, 5),
                'lng': round(lng, 5),
            })

print(f"Geocoded {len(dealers)} dealers")
by_brand = defaultdict(int)
for d in dealers: by_brand[d['brand']] += 1
print(dict(by_brand))

with open(f"{OUT_DIR}/dealers.json", "w") as f:
    json.dump(dealers, f, separators=(',', ':'))

# ============================================================
# 2) County data — read TSVs from /home/user/workspace/usda/
# ============================================================
STATE_FIPS = {
    'ALABAMA':'01','ALASKA':'02','ARIZONA':'04','ARKANSAS':'05','CALIFORNIA':'06','COLORADO':'08',
    'CONNECTICUT':'09','DELAWARE':'10','FLORIDA':'12','GEORGIA':'13','HAWAII':'15','IDAHO':'16',
    'ILLINOIS':'17','INDIANA':'18','IOWA':'19','KANSAS':'20','KENTUCKY':'21','LOUISIANA':'22',
    'MAINE':'23','MARYLAND':'24','MASSACHUSETTS':'25','MICHIGAN':'26','MINNESOTA':'27','MISSISSIPPI':'28',
    'MISSOURI':'29','MONTANA':'30','NEBRASKA':'31','NEVADA':'32','NEW HAMPSHIRE':'33','NEW JERSEY':'34',
    'NEW MEXICO':'35','NEW YORK':'36','NORTH CAROLINA':'37','NORTH DAKOTA':'38','OHIO':'39','OKLAHOMA':'40',
    'OREGON':'41','PENNSYLVANIA':'42','RHODE ISLAND':'44','SOUTH CAROLINA':'45','SOUTH DAKOTA':'46',
    'TENNESSEE':'47','TEXAS':'48','UTAH':'49','VERMONT':'50','VIRGINIA':'51','WASHINGTON':'53',
    'WEST VIRGINIA':'54','WISCONSIN':'55','WYOMING':'56'
}
STATE_ABBR = {
    'ALABAMA':'AL','ALASKA':'AK','ARIZONA':'AZ','ARKANSAS':'AR','CALIFORNIA':'CA','COLORADO':'CO',
    'CONNECTICUT':'CT','DELAWARE':'DE','FLORIDA':'FL','GEORGIA':'GA','HAWAII':'HI','IDAHO':'ID',
    'ILLINOIS':'IL','INDIANA':'IN','IOWA':'IA','KANSAS':'KS','KENTUCKY':'KY','LOUISIANA':'LA',
    'MAINE':'ME','MARYLAND':'MD','MASSACHUSETTS':'MA','MICHIGAN':'MI','MINNESOTA':'MN','MISSISSIPPI':'MS',
    'MISSOURI':'MO','MONTANA':'MT','NEBRASKA':'NE','NEVADA':'NV','NEW HAMPSHIRE':'NH','NEW JERSEY':'NJ',
    'NEW MEXICO':'NM','NEW YORK':'NY','NORTH CAROLINA':'NC','NORTH DAKOTA':'ND','OHIO':'OH','OKLAHOMA':'OK',
    'OREGON':'OR','PENNSYLVANIA':'PA','RHODE ISLAND':'RI','SOUTH CAROLINA':'SC','SOUTH DAKOTA':'SD',
    'TENNESSEE':'TN','TEXAS':'TX','UTAH':'UT','VERMONT':'VT','VIRGINIA':'VA','WASHINGTON':'WA',
    'WEST VIRGINIA':'WV','WISCONSIN':'WI','WYOMING':'WY'
}
SUPPRESSED = {"(D)", "(Z)", "(L)", "(NA)", "(X)", "(S)", "", None}

def load_year(year):
    """Return {fips: {name, state, acres}}. TSV columns (positional):
    state_fips, state_fips_dup, state_abbr, state_name, county_code, county_code_dup, county_name, year, value."""
    path = f"/home/user/workspace/usda/irrigated_{year}.tsv"
    out = {}
    with open(path) as f:
        for line in f:
            parts = line.rstrip('\n').split('\t')
            if len(parts) < 9: continue
            sfips = parts[0].strip().zfill(2)
            state_abbr = parts[2].strip()
            state = parts[3].strip().upper()
            cfips = parts[4].strip().zfill(3)
            county = parts[6].strip()
            val = parts[8].strip().replace(',', '')
            if val in SUPPRESSED: continue
            try:
                acres = int(val)
            except ValueError:
                continue
            fips = sfips + cfips
            out[fips] = {
                'fips': fips,
                'name': county.title(),
                'state': state_abbr or STATE_ABBR.get(state, ''),
                'acres': acres,
            }
    return out

acres_2022 = load_year(2022)
acres_2007 = load_year(2007)

print(f"Counties 2022: {len(acres_2022)}, 2007: {len(acres_2007)}")

# Merge
counties = {}
for fips, rec in acres_2022.items():
    a07 = acres_2007.get(fips, {}).get('acres')
    counties[fips] = {
        'name': rec['name'],
        'state': rec['state'],
        'acres_2022': rec['acres'],
        'acres_2007': a07,
        'growth_pct': round((rec['acres'] - a07) / a07 * 100, 1) if a07 and a07 > 0 else None,
    }

with open(f"{OUT_DIR}/counties.json", "w") as f:
    json.dump(counties, f, separators=(',', ':'))
print(f"Wrote counties.json ({len(counties)} counties)")

# ============================================================
# 3) US Counties GeoJSON (low-res) — fetch from Plotly's CDN
# ============================================================
# Use the standard US county TopoJSON from plotly (well-tested, ~500KB)
GEO_URL = "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json"
geo_path = f"{OUT_DIR}/us-counties.json"
if not os.path.exists(geo_path):
    print(f"Fetching {GEO_URL}")
    urllib.request.urlretrieve(GEO_URL, geo_path)
print(f"GeoJSON size: {os.path.getsize(geo_path)/1024:.0f} KB")

print("\nDone.")
