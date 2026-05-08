// =============================================================
// Pivot Irrigation Dealer Map
// =============================================================

const BRAND_COLORS = {
  Reinke:   '#A84B2F',
  Valley:   '#20808D',
  Zimmatic: '#7A39BB',
};

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
const visibleBrands = new Set(['Reinke', 'Valley', 'Zimmatic']);
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
          `<div class="row"><span class="k"><span class="dealer-dot ${d.brand}"></span>${escapeHtml(d.name)}</span><span class="v">${dist.toFixed(0)} mi</span></div>`
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
        html: `<span class="dealer-marker ${d.brand}" title="${escapeHtml(d.name)}"></span>`,
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
    <span class="popup-brand ${d.brand}">${d.brand}</span>
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
  const counts = { Reinke: 0, Valley: 0, Zimmatic: 0 };
  for (const d of dealers) counts[d.brand]++;
  for (const b in counts) {
    const el = document.getElementById('count-' + b);
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
