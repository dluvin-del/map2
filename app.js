// =============================================================
// Pivot Irrigation Dealer Map
// =============================================================

const BRAND_COLORS = {
  Reinke:   '#A84B2F',
  Valley:   '#20808D',
  Zimmatic: '#7A39BB',
  'T-L':    '#D97706',
};

// Map a brand name to a CSS-class-safe slug ("T-L" -> "TL")
function brandClass(brand) {
  return String(brand || '').replace(/[^A-Za-z0-9]/g, '');
}

// State
let dealers = [];
let counties = {};
let countiesGeo = null;
let dealerMarkers = {};         // brand -> L.featureGroup
let countyLayer = null;
let underservedLayer = null;     // overlay highlighting underserved counties
let radiusMiles = 100;
let activeRadius = null;
let activeDealer = null;
let allRadiiLayer = null;        // L.layerGroup of circles for every visible dealer
let allRadiiVisible = false;
let pivotsData = null;           // [[lat, lng, radius_m], ...] - 80k entries
let pivotsLayer = null;
let pivotsVisible = false;
const PIVOT_MIN_ZOOM = 7;        // don't render pivots below this zoom (too many, too small)
const visibleBrands = new Set(['Reinke', 'Valley', 'Zimmatic', 'T-L']);
let countyInfoEnabled = true;
let countiesVisible = true;
let underservedVisible = false;

// Base tile layers (light, dark, aerial)
let baseLayer = null;
let labelsLayer = null;
let aerialLayer = null;
let aerialLabelsLayer = null;
let aerialActive = false;

// State acres-per-dealer cache (for gap classification)
const stateGap = {};

// =============================================================
// Map init
// =============================================================
const map = window._map = L.map('map', {
  zoomControl: true,
  attributionControl: true,
  preferCanvas: true,
}).setView([39.5, -98.5], 5);   // center of contiguous US

// Use CartoDB Positron tiles — neutral, lets data sing
const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
const tileUrl = isDark
  ? 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png'
  : 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png';
const tileLabelsUrl = isDark
  ? 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png'
  : 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png';

// Labels go on a separate pane that sits ABOVE the choropleth
map.createPane('labels');
map.getPane('labels').style.zIndex = 650;
map.getPane('labels').style.pointerEvents = 'none';

baseLayer = L.tileLayer(tileUrl, {
  maxZoom: 18,
  attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
}).addTo(map);
labelsLayer = L.tileLayer(tileLabelsUrl, { maxZoom: 18, pane: 'labels', attribution: '' }).addTo(map);

// Esri World Imagery (aerial) — not added by default
aerialLayer = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    maxZoom: 19,
    attribution: 'Tiles © <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics, USGS',
  }
);
aerialLabelsLayer = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, pane: 'labels', attribution: '' }
);

// =============================================================
// Color scale for irrigated acres
// =============================================================
function acresColor(a) {
  if (a == null) return 'transparent';
  if (a < 1000) return '#F7F6F2';
  if (a < 5000) return '#E2EEE9';
  if (a < 15000) return '#BCE2E7';
  if (a < 50000) return '#7AB6BD';
  if (a < 100000) return '#3F8E96';
  if (a < 200000) return '#20808D';
  if (a < 350000) return '#1B474D';
  return '#944454';
}

// =============================================================
// Data load
// =============================================================
Promise.all([
  fetch('./data/dealers.json').then(r => r.json()),
  fetch('./data/counties.json').then(r => r.json()),
  fetch('./data/us-counties.json').then(r => r.json()),
]).then(([d, c, geo]) => {
  dealers = d;
  counties = c;
  countiesGeo = geo;

  computeStateGap();
  buildCountyLayer();
  buildDealerLayers();
  updateCounts();
  bindUI();
  initSites();  // Load pivot-site sources + sites from backend
}).catch(err => {
  console.error('Failed to load data:', err);
  document.getElementById('map').innerHTML =
    '<div style="padding:40px;text-align:center;color:#964219">Failed to load data. Check console.</div>';
});

// =============================================================
// State-level gap classification (for county popups)
// =============================================================
function computeStateGap() {
  // Sum 2022 acres per state and dealer count per state
  const stateAcres = {};
  for (const fips in counties) {
    const c = counties[fips];
    if (!c.state) continue;
    stateAcres[c.state] = (stateAcres[c.state] || 0) + (c.acres_2022 || 0);
  }
  const stateDealers = {};
  for (const d of dealers) {
    stateDealers[d.state] = (stateDealers[d.state] || 0) + 1;
  }
  for (const st in stateAcres) {
    const dlrs = stateDealers[st] || 0;
    const apd = dlrs > 0 ? stateAcres[st] / dlrs : null;
    let label = 'No data';
    let cls = 'adequate';
    if (apd === null && stateAcres[st] > 50000) { label = 'No dealers'; cls = 'under'; }
    else if (apd === null) { label = '—'; cls = 'adequate'; }
    else if (apd > 250000) { label = 'Underserved'; cls = 'under'; }
    else if (apd > 150000) { label = 'Below average'; cls = 'under'; }
    else if (apd > 80000) { label = 'Adequate'; cls = 'adequate'; }
    else { label = 'Saturated'; cls = 'adequate'; }
    stateGap[st] = { acres: stateAcres[st], dealers: dlrs, apd, label, cls };
  }
}

// =============================================================
// County choropleth
// =============================================================
function buildCountyLayer() {
  countyLayer = L.geoJSON(countiesGeo, {
    style: feature => {
      const fips = feature.id;
      const c = counties[fips];
      const acres = c ? c.acres_2022 : null;
      return {
        fillColor: acresColor(acres),
        fillOpacity: acres ? 0.65 : 0.05,
        color: '#888',
        weight: 0.3,
      };
    },
    onEachFeature: (feature, layer) => {
      const fips = feature.id;
      const c = counties[fips];
      layer.on({
        mouseover: e => {
          if (!countyInfoEnabled) return;
          e.target.setStyle({ weight: 2, color: '#28251D' });
          e.target.bringToFront();
        },
        mouseout: e => { countyLayer.resetStyle(e.target); },
        click: (e) => {
          if (!countyInfoEnabled || !c) return;
          showCountyInfo(c, fips, e.latlng);
        },
      });
    },
  }).addTo(map);

  // Underserved overlay — hatched magenta over states classified as gaps + counties with significant acreage
  // Uses a separate GeoJSON layer that's only added/removed via the toggle
  underservedLayer = L.geoJSON(countiesGeo, {
    style: feature => {
      const fips = feature.id;
      const c = counties[fips];
      if (!c) return { fillOpacity: 0, weight: 0 };
      const gap = stateGap[c.state];
      // Highlight if the state is classified as a gap AND the county has measurable acres
      const stateUnderserved = gap && (gap.label === 'Underserved' || gap.label === 'Below average' || gap.label === 'No dealers');
      const hasAcres = (c.acres_2022 || 0) >= 5000;
      if (stateUnderserved && hasAcres) {
        // Stronger highlight for higher-acre counties in gap states
        const intensity = Math.min(1, (c.acres_2022 || 0) / 100000);
        return {
          fillColor: '#A12C7B',
          fillOpacity: 0.30 + 0.35 * intensity,
          color: '#A12C7B',
          weight: 1,
          dashArray: '4, 4',
        };
      }
      return { fillOpacity: 0, weight: 0, interactive: false };
    },
    interactive: false,
  });
}

function showCountyInfo(c, fips, latlng) {
  const gap = stateGap[c.state] || {};
  const growth = c.growth_pct;
  const growthStr = growth == null ? 'N/A' :
    (growth > 0 ? `+${growth}%` : `${growth}%`);
  const growthColor = growth == null ? 'var(--text-muted)' :
    growth > 10 ? 'var(--success)' :
    growth < -10 ? 'var(--error)' : 'var(--text)';

  // Irrigation share of cropland
  const irrShare = (c.acres_2022 && c.cropland) ?
    Math.round((c.acres_2022 / c.cropland) * 100) : null;

  // Top crops as bars
  let cropsHtml = '';
  if (c.top_crops && c.top_crops.length) {
    const max = c.top_crops[0].acres;
    cropsHtml = '<div class="section-h">Top crops (acres harvested)</div>' +
      c.top_crops.map(cr => {
        const pct = max ? (cr.acres / max * 100) : 0;
        return `<div class="crop-row">
          <div class="crop-bar-wrap">
            <div class="crop-bar" style="width:${pct}%"></div>
            <span class="crop-name">${escapeHtml(cr.name)}</span>
          </div>
          <span class="crop-val">${fmt(cr.acres)}</span>
        </div>`;
      }).join('');
  }

  // Nearest dealers (top 3 by distance to county centroid)
  let dealersHtml = '';
  if (latlng) {
    const nearby = dealers
      .filter(d => visibleBrands.has(d.brand))
      .map(d => ({ d, dist: haversineMiles(latlng.lat, latlng.lng, d.lat, d.lng) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3);
    if (nearby.length) {
      dealersHtml = '<div class="section-h">Nearest dealers</div>' +
        nearby.map(({ d, dist }) =>
          `<div class="row"><span class="k"><span class="dealer-dot ${brandClass(d.brand)}"></span>${escapeHtml(d.name)}</span><span class="v">${dist.toFixed(0)} mi</span></div>`
        ).join('');
    }
  }

  const html = `
    <div class="gap-tag ${gap.cls || ''}">${gap.label || '—'} (state)</div>

    <div class="section-h">Irrigation (USDA Census of Agriculture)</div>
    <div class="row"><span class="k">Irrigated 2022</span><span class="v">${fmt(c.acres_2022)} ac</span></div>
    <div class="row"><span class="k">Irrigated 2007</span><span class="v">${c.acres_2007 ? fmt(c.acres_2007) + ' ac' : 'N/A'}</span></div>
    <div class="row"><span class="k">15-yr change</span><span class="v" style="color:${growthColor}">${growthStr}</span></div>
    ${irrShare != null ? `<div class="row"><span class="k">% of cropland irrigated</span><span class="v">${irrShare}%</span></div>` : ''}

    <div class="section-h">Farms &amp; land</div>
    ${c.farms != null ? `<div class="row"><span class="k">Farm operations</span><span class="v">${fmt(c.farms)}</span></div>` : ''}
    ${c.avg_farm_size != null ? `<div class="row"><span class="k">Avg farm size</span><span class="v">${fmt(c.avg_farm_size)} ac</span></div>` : ''}
    ${c.ag_land != null ? `<div class="row"><span class="k">Ag land</span><span class="v">${fmt(c.ag_land)} ac</span></div>` : ''}
    ${c.cropland != null ? `<div class="row"><span class="k">Cropland</span><span class="v">${fmt(c.cropland)} ac</span></div>` : ''}
    ${c.cropland_harvested != null ? `<div class="row"><span class="k">Cropland harvested</span><span class="v">${fmt(c.cropland_harvested)} ac</span></div>` : ''}
    ${c.land_value_per_acre != null ? `<div class="row"><span class="k">Land value</span><span class="v">$${fmt(c.land_value_per_acre)}/ac</span></div>` : ''}
    ${c.sales_dollars != null ? `<div class="row"><span class="k">Ag product sales</span><span class="v">$${fmtShort(c.sales_dollars)}</span></div>` : ''}

    ${cropsHtml}

    <div class="section-h">State context</div>
    <div class="row"><span class="k">State irrigated</span><span class="v">${fmt(gap.acres)} ac</span></div>
    <div class="row"><span class="k">State dealers</span><span class="v">${gap.dealers || 0}</span></div>
    <div class="row"><span class="k">Acres / dealer</span><span class="v">${gap.apd ? fmt(Math.round(gap.apd)) : '—'}</span></div>

    ${dealersHtml}

    <div class="src-line">FIPS ${fips} · USDA Census of Agriculture 2022</div>
  `;
  showInfoPanel(`${c.name} County, ${c.state}`, html);
}

// =============================================================
// Dealer markers (clustered)
// =============================================================
function buildDealerLayers() {
  for (const brand of Object.keys(BRAND_COLORS)) {
    dealerMarkers[brand] = L.markerClusterGroup({
      maxClusterRadius: 50,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      iconCreateFunction: cluster => clusterIcon(cluster, brand),
    });
  }

  for (const d of dealers) {
    const marker = L.marker([d.lat, d.lng], {
      icon: L.divIcon({
        className: '',
        html: `<span class="dealer-marker ${brandClass(d.brand)}" title="${escapeHtml(d.name)}"></span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
    });
    marker.dealerData = d;
    marker.bindPopup(() => dealerPopupHtml(d));
    marker.on('click', () => {
      activeDealer = d;
      drawRadius(d);
    });
    dealerMarkers[d.brand].addLayer(marker);
  }

  for (const brand of Object.keys(BRAND_COLORS)) {
    map.addLayer(dealerMarkers[brand]);
  }
}

function clusterIcon(cluster, brand) {
  const count = cluster.getChildCount();
  const color = BRAND_COLORS[brand];
  const size = count < 10 ? 32 : count < 50 ? 38 : 46;
  return L.divIcon({
    html: `<div style="
      background:${color};
      color:white;
      width:${size}px;
      height:${size}px;
      border-radius:50%;
      display:flex;
      align-items:center;
      justify-content:center;
      border:2.5px solid white;
      box-shadow:0 2px 8px rgba(0,0,0,0.3);
      font-weight:600;
      font-family:Inter,sans-serif;
      font-size:13px;
    ">${count}</div>`,
    className: '',
    iconSize: [size, size],
    iconAnchor: [size/2, size/2],
  });
}

function dealerPopupHtml(d) {
  const phone = d.phone ? `<div class="popup-row"><span class="k">Phone</span><a href="tel:${d.phone.replace(/\D/g,'')}">${escapeHtml(d.phone)}</a></div>` : '';
  const addr = d.address ? `<div class="popup-row">${escapeHtml(d.address)}</div>` : '';
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.address || (d.lat+','+d.lng))}`;
  return `
    <div class="popup-title">${escapeHtml(d.name)}</div>
    <span class="popup-brand ${brandClass(d.brand)}">${d.brand}</span>
    ${addr}
    ${phone}
    <div class="popup-row" style="margin-top:6px">
      <a href="${mapsUrl}" target="_blank" rel="noopener">Open in Google Maps →</a>
    </div>
  `;
}

// =============================================================
// Service radius
// =============================================================
function drawRadius(d) {
  if (activeRadius) { map.removeLayer(activeRadius); activeRadius = null; }
  if (radiusMiles <= 0) return;
  const meters = radiusMiles * 1609.34;
  activeRadius = L.circle([d.lat, d.lng], {
    radius: meters,
    color: BRAND_COLORS[d.brand],
    weight: 2,
    fillColor: BRAND_COLORS[d.brand],
    fillOpacity: 0.08,
    dashArray: '4, 6',
  }).addTo(map);
}

function clearRadius() {
  if (activeRadius) { map.removeLayer(activeRadius); activeRadius = null; }
  activeDealer = null;
}

// All-dealer coverage rings: one circle per visible dealer at current radiusMiles
// Uses a Canvas renderer so 700+ circles stay performant
// IMPORTANT: pane:'overlayPane' + pointer-events:none on the canvas DOM lets clicks
// pass through to the county layer beneath. Without this, the canvas captures
// hover/click and the county info panel becomes unreachable while rings are on.
const radiiRenderer = L.canvas({ padding: 0.3 });
radiiRenderer.on('add', () => {
  const c = radiiRenderer._container;
  if (c) c.style.pointerEvents = 'none';
});

function buildAllRadii() {
  if (allRadiiLayer) { map.removeLayer(allRadiiLayer); allRadiiLayer = null; }
  if (!allRadiiVisible) return;
  const meters = (radiusMiles > 0 ? radiusMiles : 100) * 1609.34;
  const layers = [];
  for (const d of dealers) {
    if (!visibleBrands.has(d.brand)) continue;
    layers.push(
      L.circle([d.lat, d.lng], {
        renderer: radiiRenderer,
        radius: meters,
        color: BRAND_COLORS[d.brand],
        weight: 0.6,
        fillColor: BRAND_COLORS[d.brand],
        fillOpacity: 0.06,
        opacity: 0.45,
        interactive: false,
      })
    );
  }
  allRadiiLayer = L.layerGroup(layers).addTo(map);
}

// =============================================================
// Center pivot rendering
// Source: GCPIS (Tian et al. 2023, CC0) - 80,319 detected US pivots
// Strategy: only render pivots within current map bounds at zoom >= PIVOT_MIN_ZOOM
// to keep performance smooth (rendering all 80k as DOM circles would be slow)
// =============================================================
const pivotsRenderer = L.canvas({ padding: 0.3 });
pivotsRenderer.on('add', () => {
  const c = pivotsRenderer._container;
  if (c) c.style.pointerEvents = 'none';
});

function loadPivots() {
  if (pivotsData) return Promise.resolve(pivotsData);
  return fetch('./data/pivots.json').then(r => r.json()).then(d => {
    pivotsData = d;
    return d;
  });
}

function renderPivots() {
  // Always tear down before redrawing
  if (pivotsLayer) { map.removeLayer(pivotsLayer); pivotsLayer = null; }
  if (!pivotsVisible || !pivotsData) {
    updatePivotsHint();
    return;
  }
  const zoom = map.getZoom();
  if (zoom < PIVOT_MIN_ZOOM) {
    updatePivotsHint();
    return;
  }
  const bounds = map.getBounds().pad(0.1);
  const south = bounds.getSouth(), north = bounds.getNorth();
  const west = bounds.getWest(), east = bounds.getEast();

  const layers = [];
  let count = 0;
  for (let i = 0; i < pivotsData.length; i++) {
    const [lat, lng, radius] = pivotsData[i];
    if (lat < south || lat > north || lng < west || lng > east) continue;
    layers.push(L.circle([lat, lng], {
      renderer: pivotsRenderer,
      radius: radius,
      color: '#1A6B5B',
      weight: 1,
      fillColor: '#2A9D8F',
      fillOpacity: 0.18,
      opacity: 0.7,
      interactive: false,
    }));
    count++;
    // Cap at 5000 visible to keep rendering fast even at low zoom levels
    if (count >= 5000) break;
  }
  pivotsLayer = L.layerGroup(layers).addTo(map);
  updatePivotsHint(count);
}

function updatePivotsHint(visibleCount) {
  const el = document.getElementById('pivots-hint');
  if (!el) return;
  if (!pivotsVisible) {
    el.textContent = '80,319 pivots detected nationwide. Zoom in past state level (zoom 7+) to view.';
    return;
  }
  const zoom = map.getZoom();
  if (zoom < PIVOT_MIN_ZOOM) {
    el.textContent = `Zoom in to see pivots (current: ${zoom}, need ${PIVOT_MIN_ZOOM}+).`;
    return;
  }
  if (visibleCount >= 5000) {
    el.textContent = `Showing 5,000 pivots in view (capped). Zoom in for less crowding.`;
  } else {
    el.textContent = `${visibleCount.toLocaleString()} pivots in current view.`;
  }
}

// =============================================================
// UI bindings
// =============================================================
function bindUI() {
  // Brand toggles
  document.querySelectorAll('input[data-brand]').forEach(cb => {
    cb.addEventListener('change', () => {
      const brand = cb.dataset.brand;
      if (cb.checked) {
        visibleBrands.add(brand);
        map.addLayer(dealerMarkers[brand]);
      } else {
        visibleBrands.delete(brand);
        map.removeLayer(dealerMarkers[brand]);
      }
      buildAllRadii(); // refresh all-radii to match brand visibility
    });
  });

  // Aerial / satellite imagery toggle
  document.getElementById('toggle-aerial').addEventListener('change', e => {
    aerialActive = e.target.checked;
    if (aerialActive) {
      map.removeLayer(baseLayer);
      map.removeLayer(labelsLayer);
      aerialLayer.addTo(map);
      aerialLabelsLayer.addTo(map);
    } else {
      map.removeLayer(aerialLayer);
      map.removeLayer(aerialLabelsLayer);
      baseLayer.addTo(map);
      labelsLayer.addTo(map);
    }
    // Keep choropleth + dealer markers above tiles by re-adding them
    if (countiesVisible && countyLayer) countyLayer.bringToFront();
    if (underservedVisible && underservedLayer) underservedLayer.bringToFront();
  });

  // County overlay toggle
  document.getElementById('toggle-counties').addEventListener('change', e => {
    countiesVisible = e.target.checked;
    if (countiesVisible) map.addLayer(countyLayer);
    else map.removeLayer(countyLayer);
  });

  // County info toggle
  document.getElementById('toggle-county-info').addEventListener('change', e => {
    countyInfoEnabled = e.target.checked;
  });

  // Underserved highlight toggle
  document.getElementById('toggle-underserved').addEventListener('change', e => {
    underservedVisible = e.target.checked;
    if (underservedVisible) {
      underservedLayer.addTo(map);
      underservedLayer.bringToFront();
    } else {
      map.removeLayer(underservedLayer);
    }
  });

  // Radius buttons
  document.querySelectorAll('.radius-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.radius-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      radiusMiles = parseInt(btn.dataset.miles, 10);
      if (activeDealer) drawRadius(activeDealer);
      else if (radiusMiles === 0) clearRadius();
      if (allRadiiVisible) buildAllRadii(); // refresh ring sizes
    });
  });

  // Show all dealer rings toggle
  document.getElementById('toggle-all-radii').addEventListener('change', e => {
    allRadiiVisible = e.target.checked;
    buildAllRadii();
  });

  // Show actual pivots toggle
  document.getElementById('toggle-pivots').addEventListener('change', async e => {
    pivotsVisible = e.target.checked;
    if (pivotsVisible) {
      const hint = document.getElementById('pivots-hint');
      if (hint) hint.textContent = 'Loading pivot data...';
      await loadPivots();
    }
    renderPivots();
  });

  // Re-render pivots on pan/zoom (debounced via Leaflet's moveend)
  map.on('moveend zoomend', () => {
    if (pivotsVisible) renderPivots();
  });

  // Clear radius
  document.getElementById('clear-radius').addEventListener('click', clearRadius);

  // Info close
  document.getElementById('info-close').addEventListener('click', () => {
    document.getElementById('info-panel').hidden = true;
  });

  // Search
  const searchInput = document.getElementById('search');
  const resultsBox = document.getElementById('search-results');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q || q.length < 2) { resultsBox.innerHTML = ''; return; }
    const matches = [];
    // Match dealers
    for (const d of dealers) {
      if (matches.length >= 12) break;
      const hay = `${d.name} ${d.city} ${d.state}`.toLowerCase();
      if (hay.includes(q)) matches.push({ type: 'dealer', d });
    }
    // Match counties
    for (const fips in counties) {
      if (matches.length >= 18) break;
      const c = counties[fips];
      const hay = `${c.name} ${c.state}`.toLowerCase();
      if (hay.includes(q)) matches.push({ type: 'county', c, fips });
    }
    resultsBox.innerHTML = matches.map(m => {
      if (m.type === 'dealer') {
        return `<div class="search-result" data-type="dealer" data-id="${m.d.id}">
          <span>${escapeHtml(m.d.name)}</span>
          <span class="meta">${m.d.city}, ${m.d.state}</span>
        </div>`;
      } else {
        return `<div class="search-result" data-type="county" data-fips="${m.fips}">
          <span>${escapeHtml(m.c.name)} County</span>
          <span class="meta">${m.c.state} · ${fmt(m.c.acres_2022)} ac</span>
        </div>`;
      }
    }).join('');
    resultsBox.querySelectorAll('.search-result').forEach(el => {
      el.addEventListener('click', () => {
        if (el.dataset.type === 'dealer') {
          const d = dealers.find(x => x.id === parseInt(el.dataset.id, 10));
          if (d) {
            map.setView([d.lat, d.lng], 11);
            // Open popup after a short delay so cluster has time to spiderfy
            setTimeout(() => {
              dealerMarkers[d.brand].zoomToShowLayer(
                dealerMarkers[d.brand].getLayers().find(m => m.dealerData && m.dealerData.id === d.id),
                () => {
                  const target = dealerMarkers[d.brand].getLayers().find(m => m.dealerData && m.dealerData.id === d.id);
                  if (target) target.openPopup();
                }
              );
            }, 100);
          }
        } else {
          const c = counties[el.dataset.fips];
          if (c) {
            // Find feature in geojson and zoom
            const f = countiesGeo.features.find(ft => ft.id === el.dataset.fips);
            if (f) {
              const layer = L.geoJSON(f);
              map.fitBounds(layer.getBounds(), { maxZoom: 9, padding: [50, 50] });
              showCountyInfo(c, el.dataset.fips);
            }
          }
        }
        resultsBox.innerHTML = '';
        searchInput.value = '';
      });
    });
  });

  // Mobile sidebar toggle
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
}

function showInfoPanel(title, body) {
  document.getElementById('info-title').textContent = title;
  document.getElementById('info-body').innerHTML = body;
  document.getElementById('info-panel').hidden = false;
}

function updateCounts() {
  const counts = { Reinke: 0, Valley: 0, Zimmatic: 0, 'T-L': 0 };
  for (const d of dealers) {
    if (counts[d.brand] !== undefined) counts[d.brand]++;
  }
  for (const b in counts) {
    // Use brandClass for the element id ('T-L' -> 'TL')
    const el = document.getElementById('count-' + brandClass(b));
    if (el) el.textContent = counts[b].toLocaleString();
  }
  const totalEl = document.getElementById('footer-count');
  if (totalEl) totalEl.textContent = dealers.length.toLocaleString();
}

// =============================================================
// Helpers
// =============================================================
function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}
function fmtShort(n) {
  if (n == null) return '—';
  const x = Number(n);
  if (x >= 1e9) return (x/1e9).toFixed(1) + 'B';
  if (x >= 1e6) return (x/1e6).toFixed(1) + 'M';
  if (x >= 1e3) return (x/1e3).toFixed(0) + 'K';
  return x.toLocaleString();
}
function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}




// =============================================================
// American Irrigation Pivot Sites (Supabase-backed)
// =============================================================
//
// Direct browser -> Supabase REST calls using the publishable key.
// No FastAPI server required — works on GitHub Pages, Perplexity,
// or any static host.
// =============================================================

const SUPABASE_URL = 'https://yzxahuanqzkymbbrqxhn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_cfFhFM8JtEY-pdU9dLxg3w_UtKeTuoX';

const SB_HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

let sitesSources = [];              // [{name, color, count}]
let sitesAll = [];                  // [{id, source, name, lat, lng, radius_m, notes}]
let sitesLayers = {};               // source name -> L.layerGroup
let visibleSources = new Set();     // source names currently checked

async function initSites() {
  try {
    await refreshSources();
    await loadSitesFromServer();
    renderAllSites();
    bindSitesUI();
  } catch (e) {
    console.error('Sites init failed', e);
    const el = document.getElementById('sources-loading');
    if (el) el.textContent = 'Sites backend unavailable. ' + (e.message || '');
  }
}

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbPost(path, body, extraHeaders = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Prefer': 'return=representation', ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`POST ${path} -> ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function sbDelete(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: SB_HEADERS,
  });
  if (!r.ok) throw new Error(`DELETE ${path} -> ${r.status}: ${await r.text()}`);
  return true;
}

async function refreshSources() {
  // Get sources + a per-source count via head-request trick
  const rows = await sbGet('sources?select=name,color&order=name');
  // Get per-source counts in one call using group_by via RPC not available on anon.
  // Simpler: fetch all sites (they're already cached in sitesAll if loaded).
  let counts = {};
  try {
    const siteRows = await sbGet('sites?select=source');
    for (const s of siteRows) counts[s.source] = (counts[s.source] || 0) + 1;
  } catch { /* ignore, counts stay 0 */ }
  sitesSources = rows.map(r => ({ ...r, count: counts[r.name] || 0 }));
  if (visibleSources.size === 0) {
    for (const s of sitesSources) visibleSources.add(s.name);
  }
  renderSourcesList();
  updateImportSourceSelect();
}

async function loadSitesFromServer() {
  sitesAll = await sbGet('sites?select=id,source,name,lat,lng,radius_m,notes&order=id');
}

function renderSourcesList() {
  const container = document.getElementById('sources-list');
  if (!container) return;
  if (!sitesSources.length) {
    container.innerHTML = '<p class="hint">No sources yet. Click + Add source.</p>';
    return;
  }
  container.innerHTML = sitesSources.map(s => {
    const checked = visibleSources.has(s.name) ? 'checked' : '';
    const safeName = escapeHtml(s.name);
    return `
      <label class="src-row" data-src="${safeName}">
        <input type="checkbox" ${checked} data-source-toggle="${safeName}">
        <span class="src-swatch" style="background:${s.color}"></span>
        <span class="src-name">${safeName}</span>
        <span class="src-count">${s.count.toLocaleString()}</span>
        <button class="src-del" data-src-del="${safeName}" title="Delete source (must be empty)">×</button>
      </label>`;
  }).join('');

  container.querySelectorAll('[data-source-toggle]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const src = e.target.dataset.sourceToggle;
      if (e.target.checked) visibleSources.add(src);
      else visibleSources.delete(src);
      renderSourceLayer(src);
    });
  });
  container.querySelectorAll('[data-src-del]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const src = btn.dataset.srcDel;
      const srcObj = sitesSources.find(s => s.name === src);
      if (srcObj && srcObj.count > 0) {
        showSitesStatus(`"${src}" has ${srcObj.count} sites; delete them first`, true);
        return;
      }
      if (!confirm(`Delete source "${src}"?`)) return;
      try {
        await sbDelete(`sources?name=eq.${encodeURIComponent(src)}`);
        visibleSources.delete(src);
        await refreshSources();
        renderAllSites();
        showSitesStatus(`Deleted source "${src}"`);
      } catch (err) {
        showSitesStatus('Delete failed: ' + err.message, true);
      }
    });
  });
}

function updateImportSourceSelect() {
  const sel = document.getElementById('import-source');
  if (!sel) return;
  sel.innerHTML = sitesSources.map(s =>
    `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`
  ).join('');
}

function renderAllSites() {
  for (const s in sitesLayers) map.removeLayer(sitesLayers[s]);
  sitesLayers = {};
  for (const src of sitesSources) sitesLayers[src.name] = L.layerGroup();

  for (const site of sitesAll) {
    const layer = sitesLayers[site.source];
    if (!layer) continue;
    const color = sourceColor(site.source);
    const marker = L.marker([site.lat, site.lng], {
      icon: L.divIcon({
        className: '',
        html: `<svg class="site-marker" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg"><polygon points="7,1 13,13 1,13" fill="${color}" stroke="white" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
        iconSize: [14, 14],
        iconAnchor: [7, 12],
      }),
    });
    marker.bindPopup(sitePopupHtml(site));
    layer.addLayer(marker);
  }

  for (const src of sitesSources) {
    if (visibleSources.has(src.name)) map.addLayer(sitesLayers[src.name]);
  }
}

function renderSourceLayer(sourceName) {
  const layer = sitesLayers[sourceName];
  if (!layer) return;
  if (visibleSources.has(sourceName)) map.addLayer(layer);
  else map.removeLayer(layer);
}

function sourceColor(name) {
  const s = sitesSources.find(x => x.name === name);
  return s ? s.color : '#666';
}

function sitePopupHtml(s) {
  const color = sourceColor(s.source);
  const title = s.name ? escapeHtml(s.name) : `Site #${s.id}`;
  const notes = s.notes ? `<div class="popup-row">${escapeHtml(s.notes)}</div>` : '';
  const radius = s.radius_m ? `<div class="popup-row"><span class="k">Radius</span>${Math.round(s.radius_m)} m</div>` : '';
  return `
    <div class="popup-title">${title}</div>
    <span class="popup-brand" style="background:${color}">${escapeHtml(s.source)}</span>
    <div class="popup-row"><span class="k">Lat/Lng</span>${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}</div>
    ${radius}
    ${notes}
    <div class="popup-row" style="margin-top:6px">
      <a href="#" data-delete-site="${s.id}" style="color:#A12C7B">Delete this site</a>
    </div>`;
}

function showSitesStatus(msg, isErr) {
  const el = document.getElementById('sites-status');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.toggle('ok', !isErr);
  clearTimeout(showSitesStatus._t);
  showSitesStatus._t = setTimeout(() => { el.textContent = ''; el.className = ''; }, 5000);
}

function bindSitesUI() {
  document.getElementById('btn-add-source').addEventListener('click', () => openModal('modal-add-source'));
  document.getElementById('btn-import-sites').addEventListener('click', () => {
    updateImportSourceSelect();
    openModal('modal-import');
  });
  document.querySelectorAll('[data-close]').forEach(b => {
    b.addEventListener('click', () => closeModal(b.dataset.close));
  });
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', (e) => { if (e.target === m) m.setAttribute('hidden', ''); });
  });

  // Add source
  document.getElementById('src-save').addEventListener('click', async () => {
    const name = document.getElementById('src-name').value.trim();
    const color = document.getElementById('src-color').value;
    const err = document.getElementById('src-err');
    err.hidden = true;
    if (!name) { err.textContent = 'Name required'; err.hidden = false; return; }
    try {
      await sbPost('sources', { name, color });
      closeModal('modal-add-source');
      document.getElementById('src-name').value = '';
      visibleSources.add(name);
      await refreshSources();
      renderAllSites();
      showSitesStatus(`Added source "${name}"`);
    } catch (e) {
      const msg = e.message.includes('23505') ? `Source "${name}" already exists` : e.message;
      err.textContent = msg; err.hidden = false;
    }
  });

  // Import — parse file client-side, bulk insert into Supabase
  document.getElementById('import-run').addEventListener('click', async () => {
    const source = document.getElementById('import-source').value;
    const fileInput = document.getElementById('import-file');
    const err = document.getElementById('import-err');
    err.hidden = true;
    if (!fileInput.files.length) { err.textContent = 'Choose a file'; err.hidden = false; return; }
    const btn = document.getElementById('import-run');
    btn.disabled = true; btn.textContent = 'Parsing…';
    try {
      const file = fileInput.files[0];
      const text = await file.text();
      let rows;
      const fname = file.name.toLowerCase();
      if (fname.endsWith('.kml') || fname.endsWith('.kmz')) {
        rows = parseKML(text);
      } else if (fname.endsWith('.geojson') || fname.endsWith('.json')) {
        rows = parseGeoJSON(text);
      } else {
        rows = parseCSV(text);
      }
      if (!rows.length) throw new Error('No valid rows found in file');
      const payload = rows.map(r => ({
        source,
        name: r.name || null,
        lat: Number(r.lat),
        lng: Number(r.lng),
        radius_m: r.radius_m != null && r.radius_m !== '' ? Number(r.radius_m) : null,
        notes: r.notes || null,
      })).filter(r =>
        Number.isFinite(r.lat) && Number.isFinite(r.lng) &&
        r.lat >= -90 && r.lat <= 90 && r.lng >= -180 && r.lng <= 180
      );
      if (!payload.length) throw new Error('No rows had valid lat/lng');
      btn.textContent = 'Uploading…';
      // Bulk insert (Supabase accepts an array as body)
      await sbPost('sites', payload);
      closeModal('modal-import');
      fileInput.value = '';
      await refreshSources();
      await loadSitesFromServer();
      renderAllSites();
      const skipped = rows.length - payload.length;
      showSitesStatus(`Imported ${payload.length} sites${skipped ? ` (${skipped} skipped)` : ''}`);
    } catch (e) {
      err.textContent = e.message || String(e); err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = 'Import';
    }
  });

  map.on('popupopen', (e) => {
    const el = e.popup.getElement();
    if (!el) return;
    const link = el.querySelector('[data-delete-site]');
    if (!link) return;
    link.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const id = parseInt(link.dataset.deleteSite, 10);
      if (!confirm('Delete this site?')) return;
      try {
        await sbDelete(`sites?id=eq.${id}`);
        map.closePopup();
        sitesAll = sitesAll.filter(s => s.id !== id);
        await refreshSources();
        renderAllSites();
        showSitesStatus('Site deleted');
      } catch (err) {
        showSitesStatus('Delete failed: ' + err.message, true);
      }
    });
  });
}

// -------- Client-side file parsers --------

function parseCSV(text) {
  // Simple CSV that handles quoted values with commas
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];
  const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const key = (candidates) => {
    for (let i = 0; i < headers.length; i++) if (candidates.includes(headers[i])) return i;
    return -1;
  };
  const latIdx  = key(['lat', 'latitude', 'y']);
  const lngIdx  = key(['lng', 'lon', 'long', 'longitude', 'x']);
  const nameIdx = key(['name', 'site', 'label', 'title', 'id']);
  const radIdx  = key(['radius_m', 'radius', 'r']);
  const notesIdx = key(['notes', 'note', 'description', 'desc']);
  if (latIdx < 0 || lngIdx < 0) {
    throw new Error('CSV must have lat/latitude and lng/longitude columns');
  }
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (!cols.length) continue;
    out.push({
      lat: cols[latIdx],
      lng: cols[lngIdx],
      name: nameIdx >= 0 ? cols[nameIdx] : null,
      radius_m: radIdx >= 0 ? cols[radIdx] : null,
      notes: notesIdx >= 0 ? cols[notesIdx] : null,
    });
  }
  return out;
}

function parseCSVLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseGeoJSON(text) {
  const gj = JSON.parse(text);
  const features = Array.isArray(gj) ? gj : (gj.features || []);
  const out = [];
  for (const f of features) {
    const geom = f.geometry || {};
    const props = f.properties || {};
    if (geom.type === 'Point' && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
      out.push({
        lng: geom.coordinates[0],
        lat: geom.coordinates[1],
        name: props.name || props.title || null,
        radius_m: props.radius_m || props.radius || null,
        notes: props.description || props.notes || null,
      });
    }
  }
  return out;
}

function parseKML(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  const placemarks = doc.getElementsByTagName('Placemark');
  const out = [];
  for (const pm of placemarks) {
    const nameEl = pm.getElementsByTagName('name')[0];
    const descEl = pm.getElementsByTagName('description')[0];
    const points = pm.getElementsByTagName('Point');
    for (const pt of points) {
      const coordEl = pt.getElementsByTagName('coordinates')[0];
      if (!coordEl || !coordEl.textContent) continue;
      const parts = coordEl.textContent.trim().split(',');
      if (parts.length < 2) continue;
      const lng = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      out.push({
        lat, lng,
        name: nameEl ? nameEl.textContent : null,
        notes: descEl ? descEl.textContent : null,
        radius_m: null,
      });
    }
  }
  return out;
}

function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.removeAttribute('hidden');
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.setAttribute('hidden', '');
}
