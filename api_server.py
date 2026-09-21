#!/usr/bin/env python3
"""
Pivot Sites API — persistent backend for user-added irrigation pivot sites.

Sites are tagged by "source" (Verizon, Google Earth, AgSense, or user-added).
Data is stored in SQLite alongside the site files.

Endpoints
---------
GET    /api/sources                 -> list of sources with counts + colors
POST   /api/sources                 -> add a new source
DELETE /api/sources/{name}          -> remove a source (only if empty)

GET    /api/sites                   -> list all sites
POST   /api/sites                   -> add a single site
DELETE /api/sites/{site_id}         -> remove one site

POST   /api/sites/import            -> bulk import (multipart file: CSV, KML, GeoJSON)
                                       + form field 'source' selects the source tag
"""
import io
import json
import re
import sqlite3
import xml.etree.ElementTree as ET
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

DB_PATH = Path(__file__).parent / "data" / "pivot_sites.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

db = sqlite3.connect(str(DB_PATH), check_same_thread=False)
db.row_factory = sqlite3.Row
db.execute("""
CREATE TABLE IF NOT EXISTS sources (
    name  TEXT PRIMARY KEY,
    color TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
""")
db.execute("""
CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    name   TEXT,
    lat    REAL NOT NULL,
    lng    REAL NOT NULL,
    radius_m REAL,
    notes  TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source) REFERENCES sources(name) ON DELETE CASCADE
)
""")
db.execute("CREATE INDEX IF NOT EXISTS idx_sites_source ON sites(source)")

# Seed with the three sources the user requested — idempotent
DEFAULT_SOURCES = [
    ("Verizon Sites",     "#EE0000"),  # Verizon red
    ("Google Earth Sites","#4285F4"),  # Google blue
    ("AgSense Sites",     "#F5A623"),  # AgSense amber
]
for name, color in DEFAULT_SOURCES:
    db.execute("INSERT OR IGNORE INTO sources (name, color) VALUES (?, ?)", (name, color))
db.commit()


@asynccontextmanager
async def lifespan(app):
    yield
    db.close()

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class SourceIn(BaseModel):
    name: str
    color: str = "#666666"


class SiteIn(BaseModel):
    source: str
    name: str | None = None
    lat: float
    lng: float
    radius_m: float | None = None
    notes: str | None = None


# ---------- Sources ----------

@app.get("/api/sources")
def list_sources():
    rows = db.execute("""
        SELECT s.name, s.color,
               (SELECT COUNT(*) FROM sites WHERE source = s.name) AS count
        FROM sources s ORDER BY s.name
    """).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/sources", status_code=201)
def add_source(s: SourceIn):
    name = s.name.strip()
    if not name:
        raise HTTPException(400, "Source name is required")
    if len(name) > 60:
        raise HTTPException(400, "Source name too long (max 60 chars)")
    color = (s.color or "#666666").strip()
    if not re.match(r"^#[0-9A-Fa-f]{6}$", color):
        color = "#666666"
    try:
        db.execute("INSERT INTO sources (name, color) VALUES (?, ?)", (name, color))
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"Source '{name}' already exists")
    return {"name": name, "color": color, "count": 0}


@app.delete("/api/sources/{name}")
def delete_source(name: str):
    row = db.execute("SELECT COUNT(*) AS c FROM sites WHERE source = ?", (name,)).fetchone()
    if row and row["c"] > 0:
        raise HTTPException(409, f"Source '{name}' has {row['c']} sites; delete them first")
    db.execute("DELETE FROM sources WHERE name = ?", (name,))
    db.commit()
    return {"deleted": name}


# ---------- Sites ----------

@app.get("/api/sites")
def list_sites():
    rows = db.execute("SELECT id, source, name, lat, lng, radius_m, notes FROM sites ORDER BY id").fetchall()
    return [dict(r) for r in rows]


@app.post("/api/sites", status_code=201)
def add_site(s: SiteIn):
    if not _source_exists(s.source):
        raise HTTPException(400, f"Unknown source '{s.source}'")
    if not (-90 <= s.lat <= 90 and -180 <= s.lng <= 180):
        raise HTTPException(400, "lat/lng out of range")
    cur = db.execute(
        "INSERT INTO sites (source, name, lat, lng, radius_m, notes) VALUES (?, ?, ?, ?, ?, ?)",
        (s.source, s.name, s.lat, s.lng, s.radius_m, s.notes),
    )
    db.commit()
    return {"id": cur.lastrowid, **s.model_dump()}


@app.delete("/api/sites/{site_id}")
def delete_site(site_id: int):
    db.execute("DELETE FROM sites WHERE id = ?", (site_id,))
    db.commit()
    return {"deleted": site_id}


# ---------- Bulk import ----------

@app.post("/api/sites/import")
async def import_sites(source: str = Form(...), file: UploadFile = File(...)):
    if not _source_exists(source):
        raise HTTPException(400, f"Unknown source '{source}'. Create it first.")
    raw = await file.read()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 20MB)")
    filename = (file.filename or "").lower()
    try:
        text = raw.decode("utf-8", errors="replace")
        if filename.endswith(".kml") or filename.endswith(".kmz"):
            rows = _parse_kml(text)
        elif filename.endswith(".geojson") or filename.endswith(".json"):
            rows = _parse_geojson(text)
        else:
            rows = _parse_csv(text)
    except Exception as e:
        raise HTTPException(400, f"Could not parse file: {e}")

    if not rows:
        raise HTTPException(400, "No valid rows found in file")

    inserted = 0
    for r in rows:
        try:
            lat = float(r["lat"]); lng = float(r["lng"])
            if not (-90 <= lat <= 90 and -180 <= lng <= 180):
                continue
        except (KeyError, TypeError, ValueError):
            continue
        db.execute(
            "INSERT INTO sites (source, name, lat, lng, radius_m, notes) VALUES (?, ?, ?, ?, ?, ?)",
            (source, r.get("name"), lat, lng,
             _tofloat(r.get("radius_m")), r.get("notes")),
        )
        inserted += 1
    db.commit()
    return {"imported": inserted, "source": source, "skipped": len(rows) - inserted}


# ---------- Helpers ----------

def _source_exists(name: str) -> bool:
    return db.execute("SELECT 1 FROM sources WHERE name = ?", (name,)).fetchone() is not None


def _tofloat(v):
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _parse_csv(text: str) -> list[dict]:
    import csv
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        return []
    # Normalize headers: lat/latitude, lng/lon/long/longitude, name, radius/radius_m, notes
    norm = {h: h.strip().lower() for h in reader.fieldnames}
    lat_key = _find_key(norm, ["lat", "latitude", "y"])
    lng_key = _find_key(norm, ["lng", "lon", "long", "longitude", "x"])
    name_key = _find_key(norm, ["name", "site", "label", "title", "id"])
    rad_key  = _find_key(norm, ["radius_m", "radius", "r"])
    notes_key = _find_key(norm, ["notes", "note", "description", "desc"])
    if not (lat_key and lng_key):
        raise ValueError("CSV must have lat/latitude and lng/longitude columns")
    out = []
    for row in reader:
        out.append({
            "lat": row.get(lat_key),
            "lng": row.get(lng_key),
            "name": row.get(name_key) if name_key else None,
            "radius_m": row.get(rad_key) if rad_key else None,
            "notes": row.get(notes_key) if notes_key else None,
        })
    return out


def _find_key(norm: dict, candidates: list[str]) -> str | None:
    for orig, low in norm.items():
        if low in candidates:
            return orig
    return None


def _parse_geojson(text: str) -> list[dict]:
    gj = json.loads(text)
    features = gj.get("features") if isinstance(gj, dict) else None
    if features is None and isinstance(gj, list):
        features = gj
    if not features:
        return []
    out = []
    for f in features:
        geom = f.get("geometry") or {}
        props = f.get("properties") or {}
        if geom.get("type") == "Point":
            coords = geom.get("coordinates") or []
            if len(coords) >= 2:
                out.append({
                    "lng": coords[0],
                    "lat": coords[1],
                    "name": props.get("name") or props.get("title"),
                    "radius_m": props.get("radius_m") or props.get("radius"),
                    "notes": props.get("description") or props.get("notes"),
                })
    return out


def _parse_kml(text: str) -> list[dict]:
    # Strip KML namespace so we can query with plain tag names
    text = re.sub(r'\sxmlns="[^"]+"', "", text, count=1)
    root = ET.fromstring(text)
    out = []
    for pm in root.iter("Placemark"):
        name_el = pm.find("name")
        desc_el = pm.find("description")
        for pt in pm.iter("Point"):
            coord_el = pt.find("coordinates")
            if coord_el is None or not coord_el.text:
                continue
            parts = coord_el.text.strip().split(",")
            if len(parts) < 2:
                continue
            try:
                lng = float(parts[0]); lat = float(parts[1])
            except ValueError:
                continue
            out.append({
                "lat": lat, "lng": lng,
                "name": name_el.text if name_el is not None else None,
                "notes": desc_el.text if desc_el is not None else None,
                "radius_m": None,
            })
    return out


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
