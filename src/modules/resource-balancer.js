/**
 * ResourceBalancer — interne grondstofverdeling tussen eigen steden.
 * Draait NA FarmAgent zodat post-farm pieken worden meegenomen.
 *
 * Limieten:
 *   - cap per donor-stad (beschikbare handelaren)
 *   - surplus boven drempel (nooit meer sturen dan overschot)
 *   - vrije ruimte bij ontvanger (minus al onderweg zijnde grondstoffen)
 *   - min_transfer (minimumbedrag om triviale transfers te vermijden)
 */
const logger = require("../utils/logger");

const STADSFEEST_KOSTEN = { wood: 15000, stone: 18000, iron: 15000 };
const RESOURCES = ["wood", "stone", "iron"];
const RES_ICON  = { wood: "🪵", stone: "🪨", iron: "🪙" };

class ResourceBalancer {
  constructor({ api, config, stats }) {
    this.api    = api;
    this.config = config;
    this.stats  = stats;
  }

  get _cfg() { return this.config.resource_balancer ?? {}; }

  async run() {
    if (!this._cfg.enabled) return;

    let tradeData;
    try {
      tradeData = await this.api.getTradeOverview();
    } catch (e) {
      logger.warn(`[Resource Balancer] Trade overview ophalen mislukt: ${e.message || e}`);
      return;
    }

    if (!tradeData?.towns?.length) {
      logger.warn("[Resource Balancer] Geen stadsdata ontvangen");
      return;
    }

    // ── Onderweg zijnde grondstoffen per doel-stad ─────────
    const inTransit = _parseMovements(tradeData.movements ?? [], tradeData.towns);

    // ── Werkstaat: beschikbare ruimte = opslag - huidig - onderweg ──
    const state = {};
    for (const t of tradeData.towns) {
      const tr = inTransit[t.id] ?? { wood: 0, stone: 0, iron: 0 };
      state[t.id] = {
        id: t.id, name: t.name, storage: t.storage, cap: t.cap ?? 0,
        wood: t.res.wood, stone: t.res.stone, iron: t.res.iron,
        roomWood:  Math.max(0, t.storage - t.res.wood  - tr.wood),
        roomStone: Math.max(0, t.storage - t.res.stone - tr.stone),
        roomIron:  Math.max(0, t.storage - t.res.iron  - tr.iron),
      };
    }

    // ── Log huidige situatie ───────────────────────────────
    const surplusDrempel = this._cfg.balans?.surplus_drempel ?? 85;
    const tekortDrempel  = this._cfg.balans?.tekort_drempel  ?? 70;
    const preview        = this._cfg.preview !== false;
    logger.info(`[Resource Balancer] ${tradeData.towns.length} steden | surplus>${surplusDrempel}% tekort<${tekortDrempel}% | preview=${preview}`);

    for (const t of Object.values(state)) {
      const pW = pct(t.wood, t.storage), pS = pct(t.stone, t.storage), pI = pct(t.iron, t.storage);
      const f = (v, d) => v >= surplusDrempel ? `${v}%⬆` : v <= tekortDrempel ? `${v}%⬇` : `${v}%`;
      const tr = inTransit[t.id];
      const tStr = tr ? ` [▶ 🪵${tr.wood} 🪨${tr.stone} 🪙${tr.iron}]` : "";
      logger.info(`[Resource Balancer]   ${t.name.padEnd(20)} 🪵${f(pW)} 🪨${f(pS)} 🪙${f(pI)} cap:${t.cap}${tStr}`);
    }

    // ── Transfers berekenen ────────────────────────────────
    const modus = this._cfg.modus ?? "balans";
    let transfers = [];

    if (modus === "balans"    || modus === "beide") transfers.push(...this._balanceModus(state));
    if (modus === "stadsfeest"|| modus === "beide") transfers.push(...this._stadsfeestModus(state));

    if (transfers.length === 0) {
      logger.info("[Resource Balancer] Geen transfers nodig");
      return;
    }

    // ── Combineer transfers (zelfde from→to) in één reis ──
    const trips = _combineIntoTrips(transfers);
    logger.info(`[Resource Balancer] ${trips.length} reis(zen) | ${transfers.length} grondstoftransfers:`);
    for (const trip of trips) {
      const parts = RESOURCES.filter(r => trip[r] > 0)
        .map(r => `${trip[r].toLocaleString("nl-BE")} ${RES_ICON[r]}`).join(" + ");
      logger.info(`[Resource Balancer]   ${trip.from.padEnd(20)} → ${trip.to.padEnd(20)} ${parts}`);
    }

    await this._execute(trips, tradeData.activeTownId, preview);
  }

  // ── Modus 1: Balans — alle matches, enkel cap als grens ──
  _balanceModus(state) {
    const cfg            = this._cfg.balans ?? {};
    const surplusDrempel = cfg.surplus_drempel ?? 85;
    const tekortDrempel  = cfg.tekort_drempel  ?? 70;
    const minTransfer    = cfg.min_transfer    ?? 1000;
    const transfers      = [];

    // Werkkopie zodat meerdere donors/ontvangers correct worden gesimuleerd
    const s = _deepCopy(state);

    for (const res of RESOURCES) {
      const roomKey = _roomKey(res);

      // Sorteer donors: meest vol eerst
      const donors = Object.values(s)
        .filter(t => t.storage > 0 && pct(t[res], t.storage) >= surplusDrempel && t.cap > 0)
        .sort((a, b) => pct(b[res], b.storage) - pct(a[res], a.storage));

      // Sorteer ontvangers: minst vol eerst (meeste nood)
      const recvs = Object.values(s)
        .filter(t => t.storage > 0 && pct(t[res], t.storage) <= tekortDrempel)
        .sort((a, b) => pct(a[res], a.storage) - pct(b[res], b.storage));

      if (!donors.length || !recvs.length) {
        if (donors.length) logger.info(`[Resource Balancer] ${RES_ICON[res]}: ${donors.length} surplus maar geen tekort`);
        continue;
      }
      logger.info(`[Resource Balancer] ${RES_ICON[res]}: ${donors.length} surplus, ${recvs.length} tekort`);

      // Elke donor matched met elke ontvanger totdat cap of surplus op is
      for (const donor of donors) {
        for (const recv of recvs) {
          if (donor.id === recv.id) continue;
          if (donor.cap < minTransfer) break; // cap van donor op
          if (s[recv.id][roomKey] < minTransfer) continue; // ontvanger vol

          const sendable = donor[res] - Math.floor(donor.storage * surplusDrempel / 100);
          const room     = s[recv.id][roomKey];
          const amount   = Math.floor(Math.min(sendable, room, donor.cap) / 500) * 500;

          logger.info(`[Resource Balancer]   ${RES_ICON[res]} ${donor.name}→${recv.name}: ` +
            `sendable=${sendable} room=${room} cap=${donor.cap} → ${amount}`);

          if (amount >= minTransfer) {
            transfers.push({ fromId: donor.id, from: donor.name, toId: recv.id, to: recv.name, res, amount });
            donor[res]         -= amount;
            donor.cap          -= amount;
            s[recv.id][res]    += amount;
            s[recv.id][roomKey]-= amount;
          }
        }
      }
    }

    return transfers;
  }

  // ── Modus 2: Stadsfeest ──────────────────────────────────
  _stadsfeestModus(state) {
    const cfg = this._cfg.stadsfeest ?? {};
    if (!cfg.enabled || !cfg.doel_stad_id) return [];

    const aantal      = cfg.aantal ?? 1;
    const minTransfer = this._cfg.balans?.min_transfer ?? 1000;
    const s           = _deepCopy(state);
    const doel        = s[cfg.doel_stad_id];

    if (!doel) {
      logger.warn(`[Resource Balancer] Stadsfeest: doel-stad ${cfg.doel_stad_id} niet gevonden`);
      return [];
    }
    logger.info(`[Resource Balancer] 🎉 Stadsfeest | doel: ${doel.name} | ${aantal}x`);

    const transfers = [];

    for (const res of RESOURCES) {
      const roomKey  = _roomKey(res);
      const benodigd = STADSFEEST_KOSTEN[res] * aantal;
      let   tekort   = Math.max(0, benodigd - doel[res]);
      logger.info(`[Resource Balancer]   ${RES_ICON[res]}: benodigd=${benodigd} aanwezig=${doel[res]} tekort=${tekort}`);
      if (tekort < minTransfer) continue;

      const donors = Object.values(s)
        .filter(t => t.id !== doel.id && t.cap > 0 && t[res] > minTransfer)
        .sort((a, b) => pct(b[res], b.storage) - pct(a[res], a.storage));

      for (const donor of donors) {
        if (tekort < minTransfer || donor.cap < minTransfer) break;
        const room   = doel[roomKey];
        const amount = Math.floor(Math.min(donor[res] * 0.5, donor.cap, room, tekort) / 500) * 500;
        if (amount >= minTransfer) {
          transfers.push({ fromId: donor.id, from: donor.name, toId: doel.id, to: doel.name, res, amount, modus: "stadsfeest" });
          donor[res]    -= amount;
          donor.cap     -= amount;
          doel[res]     += amount;
          doel[roomKey] -= amount;
          tekort        -= amount;
        }
      }
      if (tekort <= 0) logger.info(`[Resource Balancer]   ✓ ${res} doel bereikt`);
    }

    return transfers;
  }

  // ── Uitvoering met anti-detectie delays ──────────────────
  async _execute(trips, activeTownId, preview) {
    const results = [];

    for (let i = 0; i < trips.length; i++) {
      const trip  = trips[i];
      const parts = RESOURCES.filter(r => trip[r] > 0)
        .map(r => `${trip[r].toLocaleString("nl-BE")} ${RES_ICON[r]}`).join(" + ");
      const label = trip.modus === "stadsfeest" ? "🎉" : "🔄";

      if (preview) {
        logger.info(`[Resource Balancer] PREVIEW ${label} ${trip.from} → ${trip.to}: ${parts}`);
        results.push({ ...trip, status: "preview" });
      } else {
        try {
          const res = await this.api.tradeBetweenTowns(
            activeTownId, trip.fromId, trip.toId,
            trip.wood || 0, trip.stone || 0, trip.iron || 0
          );
          const arrStr = res.arrival
            ? new Date(res.arrival * 1000).toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" })
            : "?";
          logger.info(`[Resource Balancer] ✓ ${label} ${trip.from} → ${trip.to}: ${parts} | aankomst ${arrStr}`);
          results.push({ ...trip, status: "ok", arrival: res.arrival });
        } catch (e) {
          logger.warn(`[Resource Balancer] ✗ ${trip.from} → ${trip.to}: ${e.message || e}`);
          results.push({ ...trip, status: "error", error: e.message });
        }

        if (i < trips.length - 1) {
          const delay = _tradeDelay();
          logger.info(`[Resource Balancer] Pauze ${(delay / 1000).toFixed(1)}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    try {
      await this.stats.saveTradeLog({ timestamp: new Date().toISOString(), preview, transfers: results });
    } catch (e) {
      logger.warn(`[Resource Balancer] Trade log opslaan mislukt: ${e.message}`);
    }
  }
}

// ── Hulpfuncties ──────────────────────────────────────────

function pct(val, storage) {
  return storage > 0 ? Math.round((val || 0) / storage * 100) : 0;
}

function _roomKey(res) {
  return "room" + res.charAt(0).toUpperCase() + res.slice(1);
}

function _deepCopy(state) {
  const copy = {};
  for (const [id, t] of Object.entries(state)) copy[id] = { ...t };
  return copy;
}

function _tradeDelay() {
  if (Math.random() < 0.10) return 20000 + Math.random() * 20000; // 20–40s
  return 5000 + Math.random() * 5000; // 5–10s
}

function _parseMovements(movements, towns) {
  const inTransit = {};
  for (const mov of movements) {
    const toLink = mov.to?.link ?? "";
    const match  = toLink.match(/href="#([A-Za-z0-9+/=]+)"/);
    if (!match) continue;
    let destId = null;
    try {
      const decoded = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
      destId = decoded.id ?? null;
    } catch (_) {}
    if (!destId) continue;
    if (!inTransit[destId]) inTransit[destId] = { wood: 0, stone: 0, iron: 0 };
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
    if (!trips[key]) {
      trips[key] = { fromId: tr.fromId, from: tr.from, toId: tr.toId, to: tr.to,
                     wood: 0, stone: 0, iron: 0, modus: tr.modus };
    }
    trips[key][tr.res] += tr.amount;
  }
  return Object.values(trips);
}

module.exports = ResourceBalancer;
