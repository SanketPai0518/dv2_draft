/* =========================================================================
   Internet Adoption & Prosperity — app code
   (stable functionality, white legend labels, no overflow)
   ========================================================================= */

/* =================== PATHS =================== */
const IU_2021      = "data/internet_users_2021.csv";
const IU_OWID_LONG = "data/share-of-individuals-using-the-internet.csv";
const GDP_FILE     = "data/API_NY.GDP.PCAP.CD_DS2_en_csv_v2_24794.csv";
const GEOJSON      = "data/countries.geojson";
const WB_ELEC      = "data/API_EG.ELC.ACCS.ZS_DS2_en_csv_v2_568.csv";

/* =================== HELPERS =================== */
const stripBOMCRLF = t => {
  if (!t) return "";
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  return t.replace(/\r\n?/g, "\n");
};

const safeFetch = async url => {
  try { const r = await fetch(url); return r.ok ? await r.text() : null; }
  catch { return null; }
};

const safeFetchJSON = async url => {
  try { const r = await fetch(url); return r.ok ? await r.json() : null; }
  catch { return null; }
};

/** Latest record per code for a numeric field (strictly latest year). */
const latestByCode = (rows, field) => {
  const m = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r[field])) continue;
    const cur = m.get(r.code);
    if (!cur || r.year > cur.year) m.set(r.code, r);
  }
  return m;
};

/** Latest record at or before a target year with a valid field. */
const pickLatestAtOrBefore = (arr, code, field, yr) => {
  let best = null;
  for (const r of arr) {
    if (r.code !== code) continue;
    if (r.year <= yr && Number.isFinite(r[field])) {
      if (!best || r.year > best.year) best = r;
    }
  }
  return best;
};

/* =================== LOADERS =================== */
async function loadInternetUsersLong(){
  const txt = await safeFetch(IU_OWID_LONG);
  if (!txt) throw new Error(`Missing ${IU_OWID_LONG}`);

  const table = d3.csvParse(stripBOMCRLF(txt));
  const norm = s => (s||"").replace(/\u200B/g,"").replace(/[^\p{L}\p{N}]+/gu," ").trim().toLowerCase();
  const colByNorm = new Map(table.columns.map(c => [norm(c), c]));

  const codeCol = colByNorm.get("code") || colByNorm.get("country code");
  const yearCol = colByNorm.get("year");
  const nameCol = colByNorm.get("entity") || colByNorm.get("country") || colByNorm.get("country name");

  const candidates = [
    "share of individuals using the internet",
    "share-of-individuals-using-the-internet",
    "internet users (share of population)",
    "individuals using the internet % of population",
    "value"
  ];
  const valCol = candidates.map(c => colByNorm.get(norm(c))).find(Boolean);

  if (!(codeCol && yearCol && valCol)) {
    throw new Error("OWID schema mismatch (need Code, Year, Value).");
  }

  // Parse, coerce %, and normalise to 0–100 if needed.
  let rows = [];
  for (const rec of table){
    const code = (rec[codeCol]||"").trim().toUpperCase();
    const year = +rec[yearCol];
    const val  = +(String(rec[valCol]).replace(/%/g,"").trim());
    if (code && Number.isFinite(year) && Number.isFinite(val)){
      rows.push({ country: nameCol?rec[nameCol]:undefined, code, year, internet: val });
    }
  }
  if (!rows.length) throw new Error("No internet rows parsed.");

  const sample = rows.slice(0, Math.min(400, rows.length));
  const fracShare = sample.reduce((a,d)=> a + (d.internet>0 && d.internet<=1 ? 1:0), 0) / sample.length;
  if (fracShare > 0.6) rows = rows.map(d => ({ ...d, internet: d.internet*100 }));

  return rows;
}

async function loadWBIndicatorCSV(path, fieldName){
  const txt = await safeFetch(path);
  if (!txt) return null;

  const lines = stripBOMCRLF(txt).split("\n");
  let headerIdx = 0;
  for (let i=0;i<Math.min(20,lines.length);i++){
    if (/^"?Country Name"?,/.test(lines[i])){ headerIdx = i; break; }
  }
  const norm = lines.slice(headerIdx).map(l=>l.replace(/\t|;/g, ",")).join("\n");
  const table = d3.csvParse(norm);

  const codeCol = table.columns.find(c=>c.trim().toLowerCase()==="country code");
  const nameCol = table.columns.find(c=>c.trim().toLowerCase()==="country name");

  const out=[];
  for(const row of table){
    const code=(row[codeCol]||"").trim().toUpperCase();
    for(const k of Object.keys(row)){
      const m=k.match(/^(\d{4})(?:\s*\[YR\1\])?$/);
      if(!m) continue;
      const v = row[k]==="" ? NaN : +row[k];
      if(Number.isFinite(v)) out.push({ code, year:+m[1], [fieldName]:v, country: row[nameCol] });
    }
  }
  return out.length?out:null;
}

/* ===== Quick Compare (Country A vs B): Internet %, GDP pc, Gap (Elec − Internet) ===== */
async function renderQuickCompare(){
  const elA = document.getElementById('qcA');
  const elB = document.getElementById('qcB');
  const out = document.getElementById('qcOut');
  if(!(elA && elB && out)) return;

  const [iu, gdp, elec] = await Promise.all([
    loadInternetUsersLong(),
    loadWBIndicatorCSV(GDP_FILE, "gdp"),
    loadWBIndicatorCSV(WB_ELEC, "elec")
  ]);

  const latestIU   = latestByCode(iu, "internet");
  const latestGDP  = latestByCode(gdp||[], "gdp");
  const latestElec = latestByCode(elec||[], "elec");

  const countries = [...latestIU.values()]
    .map(d => ({ code:d.code, name:d.country||d.code }))
    .sort((a,b)=>a.name.localeCompare(b.name));

  const opts = countries.map(c => `<option value="${c.code}">${c.name}</option>`).join("");
  elA.innerHTML = opts; elB.innerHTML = opts;

  if (countries.length) {
    elA.value = countries[0].code;
    elB.value = countries[Math.min(1, countries.length-1)].code;
  }

  const fmtPct = v => Number.isFinite(v) ? `${v.toFixed(1)}%` : "—";
  const fmtUSD = v => Number.isFinite(v) ? v.toLocaleString(undefined,{maximumFractionDigits:0}) : "—";
  const fmtGap = v => Number.isFinite(v) ? (v>0?`+${v.toFixed(1)}`:v.toFixed(1)) : "—";

  function rowFor(code){
    const iuR = latestIU.get(code);
    const gdpR = latestGDP.get(code);
    const elR  = latestElec.get(code);
    const internet = iuR?.internet;
    const gdpPc    = gdpR?.gdp;
    const gap      = (Number.isFinite(elR?.elec) && Number.isFinite(internet)) ? (elR.elec - internet) : NaN;
    return { internet, gdpPc, gap };
  }

  function draw(){
    const a = rowFor(elA.value);
    const b = rowFor(elB.value);
    out.querySelector('tbody').innerHTML = `
      <tr><td>A</td><td>${fmtPct(a.internet)}</td><td>${fmtUSD(a.gdpPc)}</td><td>${fmtGap(a.gap)}</td></tr>
      <tr><td>B</td><td>${fmtPct(b.internet)}</td><td>${fmtUSD(b.gdpPc)}</td><td>${fmtGap(b.gap)}</td></tr>
    `;
  }

  elA.addEventListener('change', draw);
  elB.addEventListener('change', draw);
  draw();
}

/* ================= MAP SPECS ================= */
const OCEAN_BLUE = "#0c2b48";
const GRAT       = "#2a4056";
const LAND_BASE  = "#0e1b2a";
const BORDER     = "#ffffff30";

const mapBaseLayers = [
  { data: { sphere: true }, mark: { type: "geoshape", fill: OCEAN_BLUE } },
  { data: { graticule: { step: [30,30] } }, mark: { type: "geoshape", stroke: GRAT, strokeWidth: 0.6, filled: false } },
  { data: { url: GEOJSON, format: { type: "json", property: "features" } }, mark: { type: "geoshape", fill: LAND_BASE },
    encoding: { shape: { field: "geometry", type: "geojson" } } }
];

const mapOutline = {
  data: { url: GEOJSON, format: { type: "json", property: "features" } },
  mark: { type: "geoshape", filled: false, stroke: BORDER, strokeWidth: 0.5 },
  encoding: { shape: { field: "geometry", type: "geojson" } }
};

// ISO3 extraction once
const isoTransforms = [
  { calculate:
    "upper((isValid(datum.properties['ISO3166-1-Alpha-3']) ? datum.properties['ISO3166-1-Alpha-3'] : (isValid(datum.properties.ISO_A3) ? datum.properties.ISO_A3 : (isValid(datum.properties.ADM0_A3) ? datum.properties.ADM0_A3 : datum.properties.SOV_A3))))",
    as: "iso_raw" },
  { calculate: "replace(datum.iso_raw, ' ', '')", as: "iso3" }
];

/* ---- Map: Internet users 2021 (legend ticks + white labels) ---- */
const map2021 = {
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  width: "container", height: 560, background: null, padding: 0,
  autosize: { type: "fit", contains: "padding" },
  projection: { type: "equalEarth" },
  params: [{ name: "minPct", value: 0, bind: { input: "range", min: 0, max: 100, step: 5, name: "Show countries with ≥ " } }],
  layer: [
    ...mapBaseLayers,
    {
      data: { url: GEOJSON, format: { type: "json", property: "features" } },
      transform: [
        ...isoTransforms,
        { lookup: "iso3", from: { data: { url: IU_2021 }, key: "Code", fields: ["Entity","Value"] } },
        { calculate: "isValid(datum.Value) && datum.Value >= minPct ? 1 : 0", as: "meets" }
      ],
      layer: [
        { transform: [ { filter: "datum.meets == 0" } ],
          mark: { type: "geoshape", fill: "#1b2a3b" },
          encoding: { shape: { field: "geometry", type: "geojson" } } },
        { transform: [ { filter: "datum.meets == 1" } ],
          mark: { type: "geoshape" },
          encoding: {
            shape: { field: "geometry", type: "geojson" },
            color: {
              field: "Value", type: "quantitative", title: "Internet users (%), 2021",
              scale: { scheme: "blues", domain: [0,100] },
              legend: { values: [0,20,40,60,80,100] } // numeric tick labels
            },
            tooltip: [
              { field: "Entity", title: "Country" },
              { field: "iso3",   title: "ISO3" },
              { field: "Value",  title: "% online", format: ".1f" }
            ]
          } }
      ]
    },
    mapOutline
  ],
  config: {
    view: { stroke: null },
    axis: { labelColor:"#dbeafe", titleColor:"#dbeafe", gridColor:"#223a52", domainColor:"#375a7f", tickColor:"#375a7f" },
    legend: { labelColor:"#fff", titleColor:"#fff" } // ensure white legend text
  }
};

/* ---- Map: Electricity − Internet gap (diverging, more ticks, + sign; no +0) ---- */
function gapMapSpec(values){
  const maxAbs = Math.max(...values.map(d => Math.abs(d.gap)), 40);
  const dom = [-maxAbs, 0, maxAbs];
  return {
    $schema:"https://vega.github.io/schema/vega-lite/v5.json",
    width:"container", height:560, background:null, padding:0, autosize:{ type:"fit", contains:"padding" },
    projection:{type:"equalEarth"},
    layer:[
      ...mapBaseLayers,
      {
        data:{ url:GEOJSON, format:{type:"json", property:"features"} },
        transform:[ ...isoTransforms, { lookup:"iso3", from:{ data:{ values }, key:"code", fields:["gap","country"] } } ],
        mark:{type:"geoshape"},
        encoding:{
          shape:{field:"geometry",type:"geojson"},
          color:{
            field:"gap", type:"quantitative", title:"Electricity − Internet (pp)",
            scale:{ domainMid:0, scheme:"redblue", domain:dom },
            legend:{
              values:[-maxAbs, -Math.round(maxAbs/2), 0, Math.round(maxAbs/2), maxAbs],
              labelExpr: "datum.value === 0 ? '0' : (datum.value > 0 ? '+' + datum.value : datum.value)" // no +0
            }
          },
          tooltip:[ {field:"country",title:"Country"}, {field:"iso3",title:"ISO3"}, {field:"gap",title:"Gap (pp)",format:".1f"} ]
        }
      },
      mapOutline
    ],
    config:{
      view:{stroke:null},
      axis:{labelColor:"#dbeafe", titleColor:"#dbeafe", gridColor:"#223a52", domainColor:"#375a7f", tickColor:"#375a7f"},
      legend:{ labelColor:"#fff", titleColor:"#fff" } // white legend text
    }
  }
}

/* ================ DENSITY SPEC ================ */
function densitySpec(pcts){
  const values = pcts.map(v => ({ pct:v }));
  return {
    $schema:"https://vega.github.io/schema/vega-lite/v5.json",
    width:"container", height:420, background:null, autosize:{ type:"fit", contains:"padding" },
    data:{ values },
    transform:[ { density:"pct", extent:[0,100], steps:200, as:["pct","density"] } ],
    layer:[
      { mark:{ type:"area", opacity:0.18, color:"#60a5fa" },
        encoding:{
          x:{ field:"pct", type:"quantitative", title:"Internet users (% of population)", scale:{domain:[0,100]},
              axis:{grid:true, tickCount:11, labelColor:"#dbeafe", titleColor:"#dbeafe", gridColor:"#223a52", domainColor:"#375a7f", tickColor:"#375a7f"} },
          y:{ field:"density", type:"quantitative", title:"Density",
              axis:{grid:true, labelColor:"#dbeafe", titleColor:"#dbeafe", gridColor:"#223a52", domainColor:"#375a7f", tickColor:"#375a7f"} }
        } },
      { mark:{ type:"line", color:"#93c5fd", size:3 },
        encoding:{ x:{ field:"pct", type:"quantitative" }, y:{ field:"density", type:"quantitative" } }
      }
    ],
    config:{view:{stroke:null}}
  };
}

/* ================ PROSPERITY SPEC ================ */
function prosperitySpec(rows, isLog){
  return {
    $schema:"https://vega.github.io/schema/vega-lite/v5.json",
    width:"container", height:520, background:null, autosize:{ type:"fit", contains:"padding" },
    data:{ values: rows },
    transform:[ { calculate: "log(datum.gdp)", as: "gdp_log" } ],
    layer:[
      { mark:{ type:"point", filled:true, opacity:0.45, size:55, color:"#93c5fd" },
        encoding:{
          x: isLog
            ? { field:"gdp", type:"quantitative", title:"GDP per capita (US$)", scale:{ type:"log" } }
            : { field:"gdp", type:"quantitative", title:"GDP per capita (US$)", scale:{ nice:true } },
          y: { field:"internet", type:"quantitative", title:"Internet users (% of population)", scale:{domain:[0,100]} },
          tooltip:[
            {field:"country", title:"Country"},
            {field:"gdp", title:"GDP pc (US$)", format: ",.0f"},
            {field:"internet", title:"Internet (%)", format: ".1f"}
          ]
        }
      },
      { transform: isLog
          ? [{ loess:"internet", on:"gdp_log", bandwidth:0.5 }, { calculate:"exp(datum.gdp_log)", as:"gdp_fit" }]
          : [{ loess:"internet", on:"gdp", bandwidth:0.5 }, { calculate:"datum.gdp", as:"gdp_fit" }],
        mark:{ type:"line", color:"#22d3ee", size:3 },
        encoding:{
          x: isLog
            ? { field:"gdp_fit", type:"quantitative", scale:{ type:"log" }, title:"GDP per capita (US$)" }
            : { field:"gdp_fit", type:"quantitative", title:"GDP per capita (US$)" },
          y: { field:"internet", type:"quantitative" }
        }
      }
    ],
    config:{
      view:{ stroke:null },
      axis:{ labelColor:"#dbeafe", titleColor:"#dbeafe", gridColor:"#223a52", domainColor:"#375a7f", tickColor:"#375a7f" }
    }
  };
}

/* ============ PROSPERITY BY CONTINENT SPEC (means) ============ */
function continentSpec(points, isLog){
  return {
    $schema:"https://vega.github.io/schema/vega-lite/v5.json",
    width:"container", height:520, background:null, autosize:{ type:"fit", contains:"padding" },
    data:{ values: points },
    layer:[
      {
        mark:{ type:"point", filled:true, opacity:0.9 },
        encoding:{
          x: isLog
            ? { field:"gdp_mean", type:"quantitative", scale:{type:"log"}, title:"GDP per capita (US$) — mean" }
            : { field:"gdp_mean", type:"quantitative", title:"GDP per capita (US$) — mean" },
          y: { field:"internet_mean", type:"quantitative", title:"Internet users (% of population) — mean", scale:{domain:[0,100]} },
          size:{ field:"n", type:"quantitative", title:"Countries", scale:{range:[80,900]} },
          color:{ field:"continent", type:"nominal", title:"Continent", legend:{orient:"right"} },
          tooltip:[
            {field:"continent", title:"Continent"},
            {field:"n", title:"Countries"},
            {field:"internet_mean", title:"Internet (%) — mean", format:".1f"},
            {field:"gdp_mean", title:"GDP pc — mean (US$)", format:",.0f"}
          ]
        }
      },
      { mark:{ type:"text", dy:-10, fontWeight:"600", color:"#cfe5ff" },
        encoding:{ x:{field:"gdp_mean"}, y:{field:"internet_mean"}, text:{field:"continent"} }
      }
    ],
    config:{ view:{stroke:null}, axis:{labelColor:"#dbeafe", titleColor:"#dbeafe", gridColor:"#223a52", domainColor:"#375a7f", tickColor:"#375a7f"} }
  };
}

/* ================ RENDERERS ================ */
async function renderTop10(iu){
  const latest = [...latestByCode(iu, "internet").values()];
  const yr = Math.max(...latest.map(d=>d.year));
  document.getElementById('top10Year').textContent = yr;

  const top = latest.filter(d=>d.year===yr).sort((a,b)=>b.internet-a.internet).slice(0,10);
  const rows = top.map((d,i)=>`
    <tr><td>${i+1}</td><td>${d.country||d.code}</td><td style="text-align:right">${d.internet.toFixed(1)}%</td></tr>
  `).join("");

  document.getElementById('top10Table').innerHTML = `
    <table style="width:100%; border-collapse:collapse; font-size:14px">
      <thead>
        <tr style="color:#9fbbe8"><th style="text-align:left">#</th><th style="text-align:left">Country</th><th style="text-align:right">Internet (%)</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function renderMaps(){
  vegaEmbed("#visMap2021", map2021, {actions:false});

  // Build gap = electricity - internet (latest with both)
  const [iu, elec] = await Promise.all([ loadInternetUsersLong(), loadWBIndicatorCSV(WB_ELEC, "elec") ]);
  const latestIU   = latestByCode(iu, "internet");
  const latestElec = latestByCode(elec, "elec");

  const gapVals = [];
  for(const [code, u] of latestIU){
    const e = latestElec.get(code);
    if(e && Number.isFinite(e.elec) && Number.isFinite(u.internet)){
      gapVals.push({ code, country: u.country || e.country || code, gap: e.elec - u.internet });
    }
  }
  await vegaEmbed("#visGap", gapMapSpec(gapVals), {actions:false});

  renderTop10(iu);
}

async function renderDensity(){
  const msg = document.getElementById('denMsg');
  const yearSel = document.getElementById('denYear');
  try{
    const iu = await loadInternetUsersLong();
    const years = [...new Set(iu.map(d=>d.year))].sort((a,b)=>b-a);
    yearSel.innerHTML = years.map(y=>`<option value="${y}">${y}</option>`).join("");

    const draw = async () => {
      const yr = +yearSel.value || years[0];
      const byCodeYr = new Map();

      for(const r of iu){
        if (r.year===yr && Number.isFinite(r.internet)) byCodeYr.set(r.code, r.internet);
      }
      // If too sparse, backfill with latest ≤ yr for each country
      if(byCodeYr.size < 20){
        const best = new Map();
        for(const r of iu){
          if (r.year<=yr && Number.isFinite(r.internet)) {
            const cur=best.get(r.code);
            if(!cur || r.year>cur.year) best.set(r.code, r);
          }
        }
        byCodeYr.clear();
        for(const [code,rec] of best) byCodeYr.set(code, rec.internet);
      }

      const pcts = [...byCodeYr.values()];
      msg.textContent = `Countries: ${pcts.length}. Kernel density across adoption levels in ${yr}.`;
      await vegaEmbed("#visDensity", densitySpec(pcts), {actions:false});
    };

    yearSel.addEventListener('change', draw);
    await draw();
  }catch(e){
    console.error(e);
    msg.innerHTML = `<div class="warn">Density error: ${e.message.replace(/</g,"&lt;")}</div>`;
  }
}

async function renderProsperity(){
  const msg = document.getElementById('prosMsg');
  const yearSel = document.getElementById('prosYear');
  const logChk  = document.getElementById('prosLog');

  try{
    const [iu, gdp] = await Promise.all([ loadInternetUsersLong(), loadWBIndicatorCSV(GDP_FILE, "gdp") ]);
    const years = [...new Set(iu.map(d=>d.year))].sort((a,b)=>b-a);
    yearSel.innerHTML = years.map(y=>`<option value="${y}">${y}</option>`).join("");

    const draw = async ()=>{
      const yr = +yearSel.value || years[0];
      const rows=[];
      for(const code of new Set(iu.map(d=>d.code))){
        const iuRec  = pickLatestAtOrBefore(iu,  code, "internet", yr);
        const gdpRec = pickLatestAtOrBefore(gdp||[], code, "gdp",      yr);
        if(iuRec && gdpRec && gdpRec.gdp>0){
          rows.push({ country: iuRec.country || gdpRec.country || code, code, internet: iuRec.internet, gdp: gdpRec.gdp, year: Math.min(iuRec.year, gdpRec.year) });
        }
      }
      rows.sort((a,b)=> (a.country||"").localeCompare(b.country||""));
      msg.textContent = `Countries: ${rows.length}. Year ≈ ${yr} (latest ≤ year for each series).`;
      await vegaEmbed("#visProsperity", prosperitySpec(rows, logChk.checked), { actions:false });
    };

    yearSel.addEventListener('change', draw);
    logChk.addEventListener('change', draw);
    await draw();
  }catch(e){
    console.error(e);
    msg.innerHTML = `<div class="warn">Prosperity viz error: ${e.message.replace(/</g,"&lt;")}</div>`;
  }
}

async function renderProsperityByContinent(){
  const msg = document.getElementById('contMsg');
  const yearSel = document.getElementById('contYear');
  const logChk  = document.getElementById('contLog');

  try{
    const [iu, gdp, contMap] = await Promise.all([
      loadInternetUsersLong(),
      loadWBIndicatorCSV(GDP_FILE, "gdp"),
      buildContinentMap()
    ]);

    const years = [...new Set(iu.map(d=>d.year))].sort((a,b)=>b-a);
    yearSel.innerHTML = years.map(y=>`<option value="${y}">${y}</option>`).join("");

    const draw = async ()=>{
      const yr = +yearSel.value || years[0];
      const rows=[];
      for(const code of new Set(iu.map(d=>d.code))){
        const iuRec  = pickLatestAtOrBefore(iu,  code, "internet", yr);
        const gdpRec = pickLatestAtOrBefore(gdp||[], code, "gdp",      yr);
        const cont   = contMap.get(code);
        if(iuRec && gdpRec && gdpRec.gdp>0 && cont){
          rows.push({ continent: cont, code, internet: iuRec.internet, gdp: gdpRec.gdp });
        }
      }

      // Aggregate means per continent
      const byCont = new Map();
      for(const r of rows){
        let g = byCont.get(r.continent);
        if(!g) g={continent:r.continent, n:0, internet_sum:0, gdp_sum:0};
        g.n++; g.internet_sum+=r.internet; g.gdp_sum+=r.gdp;
        byCont.set(r.continent, g);
      }
      const points = [...byCont.values()].map(g => ({
        continent: g.continent,
        n: g.n,
        internet_mean: g.internet_sum / g.n,
        gdp_mean: g.gdp_sum / g.n
      }));

      msg.textContent = `Continents: ${points.length}. Countries included: ${rows.length}. Year ≈ ${yr} (latest ≤ year per series).`;
      await vegaEmbed("#visContinent", continentSpec(points, logChk.checked), {actions:false});
    };

    yearSel.addEventListener('change', draw);
    logChk.addEventListener('change', draw);
    await draw();
  }catch(e){
    console.error(e);
    msg.innerHTML = `<div class="warn">Continent viz error: ${e.message.replace(/</g,"&lt;")}</div>`;
  }
}

/* ==== Continent map (GeoJSON first, robust fallback) ==== */
async function buildContinentMap(){
  const fallback = {
    // AFRICA
    DZA:"Africa", EGY:"Africa", MAR:"Africa", TUN:"Africa", LBY:"Africa",
    BFA:"Africa", BEN:"Africa", BWA:"Africa", BDI:"Africa", CMR:"Africa",
    CPV:"Africa", CAF:"Africa", TCD:"Africa", COM:"Africa", COD:"Africa",
    COG:"Africa", CIV:"Africa", DJI:"Africa", ERI:"Africa", ETH:"Africa",
    GNQ:"Africa", GAB:"Africa", GMB:"Africa", GHA:"Africa", GIN:"Africa",
    GNB:"Africa", KEN:"Africa", LSO:"Africa", LBR:"Africa", MDG:"Africa",
    MLI:"Africa", MRT:"Africa", MUS:"Africa", MOZ:"Africa", NAM:"Africa",
    NER:"Africa", NGA:"Africa", RWA:"Africa", STP:"Africa", SEN:"Africa",
    SYC:"Africa", SLE:"Africa", ZAF:"Africa", SSD:"Africa", SDN:"Africa",
    SWZ:"Africa", TGO:"Africa", UGA:"Africa", TZA:"Africa", ZMB:"Africa",
    ZWE:"Africa", SOM:"Africa",
    // AMERICAS
    USA:"Americas", CAN:"Americas", MEX:"Americas", GTM:"Americas", BLZ:"Americas",
    SLV:"Americas", HND:"Americas", NIC:"Americas", CRI:"Americas", PAN:"Americas",
    CUB:"Americas", DOM:"Americas", HTI:"Americas", JAM:"Americas", TTO:"Americas",
    BRB:"Americas", BHS:"Americas", ATG:"Americas", GRD:"Americas", DMA:"Americas",
    KNA:"Americas", VCT:"Americas", LCA:"Americas", GUY:"Americas", SUR:"Americas",
    VEN:"Americas", COL:"Americas", PER:"Americas", ECU:"Americas", BOL:"Americas",
    CHL:"Americas", ARG:"Americas", PRY:"Americas", URY:"Americas", BRA:"Americas",
    // ASIA
    CHN:"Asia", IND:"Asia", JPN:"Asia", KOR:"Asia", PRK:"Asia", MNG:"Asia",
    AFG:"Asia", PAK:"Asia", BGD:"Asia", NPL:"Asia", LKA:"Asia", MDV:"Asia",
    BTN:"Asia", IRN:"Asia", IRQ:"Asia", ISR:"Asia", PSE:"Asia", JOR:"Asia",
    SAU:"Asia", ARE:"Asia", QAT:"Asia", KWT:"Asia", BHR:"Asia", OMN:"Asia", YEM:"Asia",
    TUR:"Asia", AZE:"Asia", ARM:"Asia", GEO:"Asia", KAZ:"Asia", KGZ:"Asia",
    TJK:"Asia", TKM:"Asia", UZB:"Asia", RUS:"Europe", // keep Russia in Europe for viz clarity
    IDN:"Asia", MYS:"Asia", SGP:"Asia", THA:"Asia", VNM:"Asia", LAO:"Asia",
    KHM:"Asia", MMR:"Asia", PHL:"Asia", BRN:"Asia", TLS:"Asia",
    // EUROPE
    ALB:"Europe", AND:"Europe", AUT:"Europe", BLR:"Europe", BEL:"Europe", BIH:"Europe",
    BGR:"Europe", HRV:"Europe", CZE:"Europe", DNK:"Europe", EST:"Europe", FIN:"Europe",
    FRA:"Europe", DEU:"Europe", GRC:"Europe", HUN:"Europe", ISL:"Europe", IRL:"Europe",
    ITA:"Europe", LVA:"Europe", LIE:"Europe", LTU:"Europe", LUX:"Europe", MLT:"Europe",
    MDA:"Europe", MCO:"Europe", MNE:"Europe", NLD:"Europe", MKD:"Europe", NOR:"Europe",
    POL:"Europe", PRT:"Europe", ROU:"Europe", SMR:"Europe", SRB:"Europe", SVK:"Europe",
    SVN:"Europe", ESP:"Europe", SWE:"Europe", CHE:"Europe", UKR:"Europe", GBR:"Europe",
    VAT:"Europe", GIB:"Europe", IMN:"Europe", FRO:"Europe",
    // OCEANIA
    AUS:"Oceania", NZL:"Oceania", PNG:"Oceania", SLB:"Oceania", VUT:"Oceania",
    FJI:"Oceania", TON:"Oceania", WSM:"Oceania", KIR:"Oceania", TUV:"Oceania",
    NRU:"Oceania", PLW:"Oceania", MHL:"Oceania", COK:"Oceania", NIU:"Oceania",
    NCL:"Oceania", PYF:"Oceania", NFK:"Oceania", GUM:"Oceania",
    // OTHER / TERRITORIES
    HKG:"Asia", MAC:"Asia", TWN:"Asia", XKX:"Europe", GRL:"Americas",
    REU:"Africa", MYT:"Africa", ATF:"Africa", SHN:"Africa", ESH:"Africa"
  };

  const map = new Map();
  try{
    const gj = await safeFetchJSON(GEOJSON);
    if (gj && Array.isArray(gj.features)) {
      for (const f of gj.features) {
        const p = f.properties || {};
        const iso = (p['ISO3166-1-Alpha-3'] || p.ISO_A3 || p.ADM0_A3 || p.SOV_A3 || "").toString().trim().toUpperCase();
        let cont = p.CONTINENT || p.continent || p.CONTINENT_OCE || p.region_un || p.subregion || null;
        cont = cont ? String(cont).trim() : null;
        if (iso && cont) map.set(iso, cont);
      }
    }
  }catch(e){ /* ignore, use fallback below */ }

  for (const [iso, cont] of Object.entries(fallback)) if (!map.has(iso)) map.set(iso, cont);
  return map;
}

/* ==== Fun-fact mini map (fits container) ==== */
function cablesMiniSpec(){
  const routes = [
    { geo:{ type:"LineString", coordinates:[[-74.0,40.7], [-0.1,51.5]] } },
    { geo:{ type:"LineString", coordinates:[[-9.1,38.7], [-38.5,-3.7]] } },
    { geo:{ type:"LineString", coordinates:[[72.88,19.07], [103.8,1.35]] } },
    { geo:{ type:"LineString", coordinates:[[139.7,35.7], [-118.25,34.05]] } },
    { geo:{ type:"LineString", coordinates:[[151.21,-33.87], [174.78,-36.85]] } }
  ];
  return {
    $schema:"https://vega.github.io/schema/vega-lite/v5.json",
    width:"container", height:180, background:null, padding:0, autosize:{ type:"fit", contains:"padding" },
    projection:{ type:"equalEarth" },
    layer:[
      { data:{ sphere:true }, mark:{ type:"geoshape", fill:OCEAN_BLUE } },
      { data:{ url:GEOJSON, format:{ type:"json", property:"features" } },
        mark:{ type:"geoshape", fill:LAND_BASE, stroke:BORDER, strokeWidth:0.25 },
        encoding:{ shape:{ field:"geometry", type:"geojson" } } },
      { data:{ values: routes },
        mark:{ type:"geoshape", filled:false, stroke:"#f59e0b", strokeWidth:1.5, opacity:0.9 },
        encoding:{ shape:{ field:"geo", type:"geojson" } } }
    ],
    config:{ view:{ stroke:null } }
  };
}

/* ==== Boot ==== */
(async function(){
  await renderMaps();
  await renderProsperity();
  await renderProsperityByContinent();
  await renderDensity();

  const mini = document.getElementById("visCables");
  if (mini) vegaEmbed("#visCables", cablesMiniSpec(), { actions:false });

  // If Quick Compare panel exists, render it.
  if (document.getElementById('qcA')) renderQuickCompare();
})();
