/**
 * ResourceBalancer — interne grondstofverdeling
 * Prioriteit: 🎯 Focus → 🎉 Stadsfeest → ⚖️ Balans
 *
 * Donor-vloeren per stad:
 *   Focus-stad:     min = drempel_pct * storage
 *   Academie-stad:  min = feestkosten per grondstof (behoudt eigen feestkapaciteit)
 *   Gewone stad:    geen vloer
 */
const logger = require("../utils/logger");

const FEEST_K   = { wood: 15000, stone: 18000, iron: 15000 };
const RESOURCES = ["wood", "stone", "iron"];
const RES_ICON  = { wood: "🪵", stone: "🪨", iron: "🪙" };

class ResourceBalancer {
  constructor({ api, config, stats }) {
    this.api    = api;
    this.config = config;
    this.stats  = stats;
  }

  get _cfg() { return this.config.resource_balancer ?? {}; }
  get _acadSteden() { return this.config.academie_steden ?? {}; }

  // Hoeveel een stad maximaal kan doneren van een grondstof
  _donorVloer(townId, res, storage) {
    let vloer = 0;
    // Focus-vloer
    const focusCfg = (this._cfg.focus?.dorpen ?? [])
      .find(d => String(d.town_id) === String(townId));
    if (focusCfg && (focusCfg.resources ?? RESOURCES).includes(res)) {
      vloer = Math.max(vloer, Math.floor(storage * (focusCfg.drempel_pct ?? 97) / 100));
    }
    // Academie-vloer (behoudt eigen feestkosten)
    const acadLevel = this._acadSteden[String(townId)] ?? 0;
    if (acadLevel >= 30 && storage >= Math.max(...Object.values(FEEST_K))) {
      vloer = Math.max(vloer, FEEST_K[res]);
    }
    return vloer;
  }

  _isFocusTown(townId, res) {
    const cfg = (this._cfg.focus?.dorpen ?? []).find(d => String(d.town_id) === String(townId));
    if (!cfg) return false;
    return !res || (cfg.resources ?? RESOURCES).includes(res);
  }

  async run() {
    if (!this._cfg.enabled) return false;

    let tradeData;
    try { tradeData = await this.api.getTradeOverview(); }
    catch(e) { logger.warn(`[Resource Balancer] Trade overview fout: ${e.message}`); return false; }
    if (!tradeData?.towns?.length) return false;

    const inTransit = _parseMovements(tradeData.movements ?? [], tradeData.towns);

    // Werkstaat met effectieve ruimte (minus in-transit)
    const state = {};
    for (const t of tradeData.towns) {
      const tr = inTransit[t.id] ?? { wood:0, stone:0, iron:0 };
      state[t.id] = {
        id: t.id, name: t.name, storage: t.storage, cap: t.cap ?? 0,
        wood: t.res.wood, stone: t.res.stone, iron: t.res.iron,
        roomWood:  Math.max(0, t.storage - t.res.wood  - tr.wood),
        roomStone: Math.max(0, t.storage - t.res.stone - tr.stone),
        roomIron:  Math.max(0, t.storage - t.res.iron  - tr.iron),
      };
    }

    // Logging
    const preview         = this._cfg.preview !== false;
    const surplusDrempel  = this._cfg.balans?.surplus_drempel ?? 85;
    logger.info(`[Resource Balancer] ${tradeData.towns.length} steden | surplus>${surplusDrempel}% | preview=${preview}`);
    for (const t of Object.values(state)) {
      const pW = pct(t.wood,t.storage), pS = pct(t.stone,t.storage), pI = pct(t.iron,t.storage);
      const f  = v => v >= surplusDrempel ? `${v}%⬆` : `${v}%`;
      const tr = inTransit[t.id];
      const markers = [
        this._isFocusTown(t.id) ? "🎯" : "",
        (this._acadSteden[String(t.id)] ?? 0) >= 30 ? "🎓" : "",
      ].filter(Boolean).join("");
      const tStr = tr ? ` [▶🪵${tr.wood}🪨${tr.stone}🪙${tr.iron}]` : "";
      logger.info(`[Resource Balancer]   ${t.name.padEnd(20)} 🪵${f(pW)} 🪨${f(pS)} 🪙${f(pI)} cap:${t.cap}${markers}${tStr}`);
    }

    // Transfers berekenen — volgorde: Focus → Stadsfeest → Balans
    const s = _deepCopy(state);
    const allTransfers = [];

    if (this._cfg.focus?.enabled) {
      allTransfers.push(...this._focusModus(s, inTransit));
    }
    if (this._cfg.stadsfeest?.enabled) {
      allTransfers.push(...this._stadsfeestModus(s, inTransit));
    }
    if (this._cfg.balans?.enabled !== false) {
      allTransfers.push(...this._balanceModus(s));
    }

    if (!allTransfers.length) {
      logger.info("[Resource Balancer] Geen transfers nodig");
      return false;
    }

    const trips = _combineIntoTrips(allTransfers);
    logger.info(`[Resource Balancer] ${trips.length} reis(zen) | ${allTransfers.length} transfers:`);
    for (const trip of trips) {
      const parts = RESOURCES.filter(r => trip[r] > 0)
        .map(r => `${trip[r].toLocaleString("nl-BE")} ${RES_ICON[r]}`).join(" + ");
      const modusLabel = trip.modus ? ` [${trip.modus}]` : "";
      logger.info(`[Resource Balancer]   ${trip.from.padEnd(20)} → ${trip.to.padEnd(20)} ${parts}${modusLabel}`);
    }

    if (!preview) await this.stats.updateStatus({ active_action: "trading" });
    await this._execute(trips, tradeData.activeTownId, preview);
    if (!preview) await this.stats.updateStatus({ active_action: "" });
    return true;
  }

  // ── 🎯 Focus ──────────────────────────────────────────────
  _focusModus(s, inTransit) {
    const focusDorpen   = this._cfg.focus?.dorpen ?? [];
    const minTransfer   = this._cfg.balans?.min_transfer ?? 1000;
    const transfers     = [];

    for (const focus of focusDorpen) {
      const doel = s[focus.town_id];
      if (!doel) { logger.warn(`[Resource Balancer] 🎯 Focus dorp ${focus.town_id} niet gevonden`); continue; }

      const drempelPct = focus.drempel_pct ?? 97;
      const doelDrempel = Math.floor(doel.storage * drempelPct / 100);
      const resources   = focus.resources ?? RESOURCES;

      logger.info(`[Resource Balancer] 🎯 Focus: ${doel.name} (drempel ${drempelPct}%)`);

      for (const res of resources) {
        const roomKey  = _roomKey(res);
        const transit  = (inTransit[focus.town_id] ?? {})[res] ?? 0;
        const effectief = s[doel.id][res] + transit;
        const tekort   = doelDrempel - effectief;

        if (tekort <= 0) {
          logger.info(`[Resource Balancer]   ${RES_ICON[res]} ✓ ${effectief.toLocaleString("nl-BE")} / ${doelDrempel.toLocaleString("nl-BE")}`);
          continue;
        }
        logger.info(`[Resource Balancer]   ${RES_ICON[res]} tekort: ${tekort.toLocaleString("nl-BE")}`);

        let remaining = tekort;
        const donors = Object.values(s)
          .filter(t => t.id !== doel.id && t.cap >= minTransfer)
          .map(t => {
            const vloer   = this._donorVloer(t.id, res, t.storage);
            const maxSend = Math.max(0, t[res] - vloer);
            return { ...t, maxSend, vloer };
          })
          .filter(t => t.maxSend >= minTransfer)
          .sort((a, b) => pct(b[res], b.storage) - pct(a[res], a.storage));

        for (const donor of donors) {
          if (remaining <= 0) break;
          if (s[donor.id].cap < minTransfer) continue;

          const room   = s[doel.id][roomKey];
          const raw    = Math.min(donor.maxSend, s[donor.id].cap, room, remaining);
          let amount = Math.ceil(Math.max(0, raw) / 500) * 500;
          // Cap door werkelijke voorraad (ceiling mag niet boven wat donor heeft)
          if (amount > s[donor.id][res]) amount = Math.floor(s[donor.id][res] / 500) * 500;
          if (amount < minTransfer || amount > room) continue;

          logger.info(`[Resource Balancer]   ${RES_ICON[res]} ${donor.name}: max=${donor.maxSend} cap=${s[donor.id].cap} → ${amount}`);
          transfers.push({ fromId: donor.id, from: donor.name, toId: doel.id, to: doel.name, res, amount, modus: "focus" });
          s[donor.id][res] -= amount;
          s[donor.id].cap  -= amount;
          s[doel.id][res]  += amount;
          s[doel.id][roomKey] -= amount;
          remaining -= amount;
        }
        if (remaining > 0) logger.info(`[Resource Balancer]   ${RES_ICON[res]} Resterend: ${remaining.toLocaleString("nl-BE")}`);
      }
    }
    return transfers;
  }

  // ── 🎉 Stadsfeest ─────────────────────────────────────────
  _stadsfeestModus(s, inTransit) {
    const minTransfer = this._cfg.balans?.min_transfer ?? 1000;

    // Kandidaten: academie ≥ 30 EN opslag groot genoeg per resource
    const kandidaten = Object.values(s)
      .filter(t => {
        const acad = this._acadSteden[String(t.id)] ?? 0;
        if (acad < 30) return false;
        // Opslagcheck per resource
        return RESOURCES.every(r => t.storage >= FEEST_K[r]);
      })
      .sort((a, b) => {
        const needA = RESOURCES.reduce((sum, r) => sum + Math.max(0, FEEST_K[r] - a[r]), 0);
        const needB = RESOURCES.reduce((sum, r) => sum + Math.max(0, FEEST_K[r] - b[r]), 0);
        return needB - needA;
      });

    if (!kandidaten.length) {
      logger.info("[Resource Balancer] 🎉 Geen steden met academie ≥30 en voldoende opslag");
      return [];
    }

    const doel = kandidaten.find(t => RESOURCES.some(r => t[r] < FEEST_K[r]));
    if (!doel) {
      logger.info("[Resource Balancer] 🎉 Alle feest-steden hebben voldoende grondstoffen");
      return [];
    }

    const acadLevel = this._acadSteden[String(doel.id)] ?? 0;
    logger.info(`[Resource Balancer] 🎉 Stadsfeest doel: ${doel.name} (academie ${acadLevel})`);
    const transfers = [];

    for (const res of RESOURCES) {
      const roomKey  = _roomKey(res);
      const transit  = (inTransit[doel.id] ?? {})[res] ?? 0;
      const effectief = s[doel.id][res] + transit;
      const tekort   = Math.max(0, FEEST_K[res] - effectief);
      if (tekort < minTransfer) {
        logger.info(`[Resource Balancer]   ${RES_ICON[res]} ✓ ${effectief.toLocaleString("nl-BE")}/${FEEST_K[res].toLocaleString("nl-BE")} (${transit>0?"+"+transit.toLocaleString("nl-BE")+" onderweg":""})`);
        continue;
      }
      logger.info(`[Resource Balancer]   ${RES_ICON[res]} tekort: ${tekort.toLocaleString("nl-BE")}${transit>0?" ("+transit.toLocaleString("nl-BE")+" al onderweg)":""}`);

      let remaining = tekort;
      const donors = Object.values(s)
        .filter(t => t.id !== doel.id && t.cap >= minTransfer)
        .map(t => {
          const vloer   = this._donorVloer(t.id, res, t.storage);
          const maxSend = Math.max(0, t[res] - vloer);
          return { ...t, maxSend };
        })
        .filter(t => t.maxSend >= minTransfer)
        .sort((a, b) => pct(b[res], b.storage) - pct(a[res], a.storage));

      for (const donor of donors) {
        if (remaining <= 0) break;
        if (s[donor.id].cap < minTransfer) continue;

        const room   = s[doel.id][roomKey];
        const raw    = Math.min(donor.maxSend, s[donor.id].cap, room, remaining);
        let amount = Math.ceil(Math.max(0, raw) / 500) * 500;
          // Cap door werkelijke voorraad (ceiling mag niet boven wat donor heeft)
          if (amount > s[donor.id][res]) amount = Math.floor(s[donor.id][res] / 500) * 500;
        if (amount < minTransfer || amount > room) continue;

        logger.info(`[Resource Balancer]   ${RES_ICON[res]} Donor ${donor.name}: max=${donor.maxSend} → ${amount}`);
        transfers.push({ fromId: donor.id, from: donor.name, toId: doel.id, to: doel.name, res, amount, modus: "stadsfeest" });
        s[donor.id][res]  -= amount;
        s[donor.id].cap   -= amount;
        s[doel.id][res]   += amount;
        s[doel.id][roomKey] -= amount;
        remaining -= amount;
      }
      if (remaining <= 0) logger.info(`[Resource Balancer]   ${RES_ICON[res]} ✓ doel bereikt`);
    }
    return transfers;
  }

  // ── ⚖️ Balans ─────────────────────────────────────────────
  _balanceModus(s) {
    const surplusDrempel = this._cfg.balans?.surplus_drempel ?? 85;
    const minTransfer    = this._cfg.balans?.min_transfer ?? 1000;
    const transfers      = [];

    for (const res of RESOURCES) {
      const roomKey = _roomKey(res);

      // Donors: boven surplus_drempel, niet focus-steden (die worden apart behandeld)
      const donors = Object.values(s)
        .filter(t => !this._isFocusTown(t.id, res) && pct(t[res], t.storage) > surplusDrempel && t.cap > 0)
        .sort((a, b) => pct(b[res], b.storage) - pct(a[res], a.storage));

      if (!donors.length) continue;

      // Ontvangers: niet focus-steden, meeste ruimte eerst
      // Beperking: ontvanger mag na ontvangst niet boven surplus_drempel uitkomen
      const receivers = Object.values(s)
        .filter(t => {
          if (this._isFocusTown(t.id, res)) return false;
          const maxRecv = Math.floor(t.storage * surplusDrempel / 100) - s[t.id][res];
          return maxRecv >= minTransfer;
        })
        .sort((a, b) => pct(a[res], a.storage) - pct(b[res], b.storage));

      if (!receivers.length) {
        logger.info(`[Resource Balancer] ${RES_ICON[res]}: ${donors.length} surplus maar geen geschikte ontvangers`);
        continue;
      }
      logger.info(`[Resource Balancer] ${RES_ICON[res]}: ${donors.length} surplus (>${surplusDrempel}%), ${receivers.length} ontvangers`);

      for (const donor of donors) {
        if (s[donor.id].cap < minTransfer) break;

        // Ceil naar 500 (mag iets onder drempel zakken — bewust design)
        const sendable     = donor[res] - Math.floor(donor.storage * surplusDrempel / 100);
        const roundedSend  = Math.ceil(Math.max(0, sendable) / 500) * 500;
        if (roundedSend < minTransfer) continue;

        for (const recv of receivers) {
          if (s[donor.id].cap < minTransfer) break;
          if (donor.id === recv.id) continue;

          const maxRecv = Math.floor(recv.storage * surplusDrempel / 100) - s[recv.id][res];
          if (maxRecv < minTransfer) continue;

          const room   = Math.min(s[recv.id][roomKey], maxRecv);
          const raw    = Math.min(roundedSend, room, s[donor.id].cap);
          let amount = Math.ceil(Math.max(0, raw) / 500) * 500;
          // Cap door werkelijke voorraad (ceiling mag niet boven wat donor heeft)
          if (amount > s[donor.id][res]) amount = Math.floor(s[donor.id][res] / 500) * 500;
          if (amount < minTransfer || amount > s[recv.id].storage - s[recv.id][res]) continue;

          logger.info(`[Resource Balancer]   ${RES_ICON[res]} ${donor.name}→${recv.name}: sendable=${sendable} rounded=${roundedSend} room=${room} → ${amount}`);
          transfers.push({ fromId: donor.id, from: donor.name, toId: recv.id, to: recv.name, res, amount });
          s[donor.id][res]  -= amount;
          s[donor.id].cap   -= amount;
          s[recv.id][res]   += amount;
          s[recv.id][roomKey] -= amount;
          break;
        }
      }
    }
    return transfers;
  }

  // ── Uitvoering ────────────────────────────────────────────
  async _execute(trips, activeTownId, preview) {
    const results = [];
    for (let i = 0; i < trips.length; i++) {
      const trip  = trips[i];
      const parts = RESOURCES.filter(r => trip[r] > 0)
        .map(r => `${trip[r].toLocaleString("nl-BE")} ${RES_ICON[r]}`).join(" + ");
      const label = trip.modus ? `[${trip.modus}] ` : "";

      if (preview) {
        logger.info(`[Resource Balancer] PREVIEW ${label}${trip.from} → ${trip.to}: ${parts}`);
        results.push({ ...trip, status: "preview" });
      } else {
        try {
          const res = await this.api.tradeBetweenTowns(
            activeTownId, trip.fromId, trip.toId,
            trip.wood || 0, trip.stone || 0, trip.iron || 0
          );
          const arrStr = res.arrival
            ? new Date(res.arrival * 1000).toLocaleTimeString("nl-BE", { hour:"2-digit", minute:"2-digit" })
            : "?";
          logger.info(`[Resource Balancer] ✓ ${label}${trip.from} → ${trip.to}: ${parts} | aankomst ${arrStr}`);
          results.push({ ...trip, status: "ok", arrival: res.arrival });
        } catch(e) {
          logger.warn(`[Resource Balancer] ✗ ${trip.from} → ${trip.to}: ${e.message}`);
          results.push({ ...trip, status: "error", error: e.message });
        }
        if (i < trips.length - 1) {
          const delay = _tradeDelay();
          logger.info(`[Resource Balancer] Pauze ${(delay/1000).toFixed(1)}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    try {
      await this.stats.saveTradeLog({ timestamp: new Date().toISOString(), preview, transfers: results });
    } catch(e) {
      logger.warn(`[Resource Balancer] Trade log fout: ${e.message}`);
    }
  }
}

// ── Hulpfuncties ──────────────────────────────────────────
function pct(val, storage) { return storage > 0 ? Math.round((val||0) / storage * 100) : 0; }
function _roomKey(res) { return "room" + res.charAt(0).toUpperCase() + res.slice(1); }
function _deepCopy(state) { const c={}; for (const [id,t] of Object.entries(state)) c[id]={...t}; return c; }
function _tradeDelay() { return Math.random() < 0.10 ? 20000 + Math.random()*20000 : 5000 + Math.random()*5000; }

function _parseMovements(movements, towns) {
  const inTransit = {};
  for (const mov of movements) {
    const toLink = mov.to?.link ?? "";
    const match  = toLink.match(/href="#([A-Za-z0-9+/=]+)"/);
    if (!match) continue;
    let destId = null;
    try { const d = JSON.parse(Buffer.from(match[1], "base64").toString("utf8")); destId = d.id ?? null; } catch(_) {}
    if (!destId) continue;
    if (!inTransit[destId]) inTransit[destId] = { wood:0, stone:0, iron:0 };
    inTransit[destId].wood  += mov.res?.wood  || 0;
    inTransit[destId].stone += mov.res?.stone || 0;
    inTransit[destId].iron  += mov.res?.iron  || 0;
  }
  for (const [id, r] of Object.entries(inTransit)) {
    const naam = towns.find(t => t.id == id)?.name ?? id;
    logger.info(`[Resource Balancer] Onderweg naar ${naam}: 🪵${r.wood} 🪨${r.stone} 🪙${r.iron}`);
  }
  return inTransit;
}

function _combineIntoTrips(transfers) {
  const trips = {};
  for (const tr of transfers) {
    const key = `${tr.fromId}_${tr.toId}`;
    if (!trips[key]) trips[key] = { fromId: tr.fromId, from: tr.from, toId: tr.toId, to: tr.to, wood:0, stone:0, iron:0, modus: tr.modus };
    trips[key][tr.res] += tr.amount;
    // Behoud hoogste prioriteit modus
    if (tr.modus === "focus" || (!trips[key].modus && tr.modus)) trips[key].modus = tr.modus;
  }
  return Object.values(trips);
}

module.exports = ResourceBalancer;
