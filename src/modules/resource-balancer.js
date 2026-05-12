/**
 * ResourceBalancer — verantwoordelijk voor interne grondstofverdeling:
 *   Modus 1 (Balans): surplus-steden → tekort-steden
 *   Modus 2 (Stadsfeest): grondstoffen samenbrengen voor stadsfeest
 *
 * Elke ronde: haalt trade_overview op → berekent transfers → voert uit of preview.
 */
const logger = require("../utils/logger");

const STADSFEEST_KOSTEN = { wood: 15000, stone: 18000, iron: 15000 };
const RESOURCES = ["wood", "stone", "iron"];

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
      if (!tradeData?.towns?.length) return;
    } catch (e) {
      logger.warn(`[Resource Balancer] Trade overview fout: ${e.message || e}`);
      return;
    }

    const transfers = [];
    const modus = this._cfg.modus ?? "balans";

    if (modus === "balans" || modus === "beide") {
      const t = this._balanceModus(tradeData);
      transfers.push(...t);
    }

    if (modus === "stadsfeest" || modus === "beide") {
      const t = await this._stadsfeestModus(tradeData);
      transfers.push(...t);
    }

    if (transfers.length === 0) {
      logger.info("[Resource Balancer] Geen transfers nodig");
      return;
    }

    await this._execute(transfers, tradeData);
  }

  // ── Modus 1: Surplus → Tekort ────────────────────────────
  _balanceModus(tradeData) {
    const cfg = this._cfg.balans ?? {};
    const surplusDrempel = cfg.surplus_drempel ?? 85;
    const tekortDrempel  = cfg.tekort_drempel  ?? 30;
    const minTransfer    = cfg.min_transfer    ?? 1000;
    const maxPerRonde    = cfg.max_transfers_per_ronde ?? 3;

    // Werk met een kopie van resources om meerdere transfers te kunnen simuleren
    const state = {};
    for (const t of tradeData.towns) {
      state[t.id] = {
        name: t.name, storage: t.storage,
        wood:  t.res.wood,  stone: t.res.stone,  iron: t.res.iron,
        cap:   t.cap,
      };
    }

    const transfers = [];

    for (const res of RESOURCES) {
      if (transfers.length >= maxPerRonde) break;

      // Sorteer: surplus hoog → laag
      const surpluses = Object.values(state)
        .filter(t => t.storage > 0 && (t[res] / t.storage * 100) >= surplusDrempel && t.cap > 0)
        .sort((a, b) => (b[res] / b.storage) - (a[res] / a.storage));

      // Sorteer: tekort laag → hoog
      const tekorten = Object.values(state)
        .filter(t => t.storage > 0 && (t[res] / t.storage * 100) <= tekortDrempel)
        .sort((a, b) => (a[res] / a.storage) - (b[res] / b.storage));

      for (const surplus of surpluses) {
        if (transfers.length >= maxPerRonde) break;
        for (const tekort of tekorten) {
          if (surplus.id === tekort.id) continue;
          if (surplus.cap <= 0) break;

          const overschot = Math.floor(surplus[res] - surplus.storage * surplusDrempel / 100);
          const ruimte    = Math.floor(surplus.storage * tekortDrempel / 100 - tekort[res] + tekort.storage * (100 - tekortDrempel) / 100);
          const amount    = Math.floor(Math.min(overschot, ruimte, surplus.cap) / 100) * 100;

          if (amount >= minTransfer) {
            transfers.push({ from: surplus.name, fromId: surplus.id, to: tekort.name, toId: tekort.id, res, amount });
            // Update state voor volgende iteraties
            surplus[res] -= amount;
            surplus.cap  -= amount;
            tekort[res]  += amount;
            if (transfers.length >= maxPerRonde) break;
          }
        }
      }
    }

    return transfers;
  }

  // ── Modus 2: Stadsfeest ──────────────────────────────────
  _stadsfeestModus(tradeData) {
    const cfg = this._cfg.stadsfeest ?? {};
    if (!cfg.enabled || !cfg.doel_stad_id) return [];

    const aantal     = cfg.aantal ?? 1;
    const minTransfer = this._cfg.balans?.min_transfer ?? 1000;
    const maxPerRonde = this._cfg.balans?.max_transfers_per_ronde ?? 3;

    const state = {};
    for (const t of tradeData.towns) {
      state[t.id] = {
        name: t.name, storage: t.storage,
        wood: t.res.wood, stone: t.res.stone, iron: t.res.iron,
        cap: t.cap,
      };
    }

    const doel = state[cfg.doel_stad_id];
    if (!doel) {
      logger.warn(`[Resource Balancer] Stadsfeest: doel-stad ${cfg.doel_stad_id} niet gevonden`);
      return [];
    }

    const transfers = [];

    for (const res of RESOURCES) {
      if (transfers.length >= maxPerRonde) break;
      const benodigd = STADSFEEST_KOSTEN[res] * aantal;
      let tekort = Math.max(0, benodigd - doel[res]);
      if (tekort < minTransfer) continue;

      // Donors: steden met meeste surplus, gesorteerd
      const donors = Object.values(state)
        .filter(t => t.id !== cfg.doel_stad_id && t.cap > 0 && t[res] > minTransfer)
        .sort((a, b) => (b[res] / b.storage) - (a[res] / a.storage));

      for (const donor of donors) {
        if (tekort <= 0 || transfers.length >= maxPerRonde) break;
        if (donor.cap <= 0) continue;

        const ruimte = doel.storage - doel[res];
        const amount = Math.floor(Math.min(donor[res] * 0.5, donor.cap, ruimte, tekort) / 100) * 100;

        if (amount >= minTransfer) {
          transfers.push({ from: donor.name, fromId: donor.id, to: doel.name, toId: doel.id, res, amount, modus: "stadsfeest" });
          donor[res] -= amount;
          donor.cap  -= amount;
          doel[res]  += amount;
          tekort     -= amount;
        }
      }

      if (tekort <= 0)
        logger.info(`[Resource Balancer] 🎉 Stadsfeest ${res}: doel bereikt`);
    }

    return transfers;
  }

  // ── Uitvoering ───────────────────────────────────────────
  async _execute(transfers, tradeData) {
    const preview = this._cfg.preview !== false; // default preview aan
    const activeTownId = tradeData.towns[0]?.id;
    const results = [];

    for (const tr of transfers) {
      const payload = { [tr.res]: tr.amount };
      const modeLabel = tr.modus === "stadsfeest" ? "🎉" : "🔄";
      const logLine = `${modeLabel} ${tr.from} → ${tr.to}: ${tr.amount.toLocaleString("nl-BE")} ${tr.res === "wood" ? "🪵" : tr.res === "stone" ? "🪨" : "🪙"}`;

      if (preview) {
        logger.info(`[Resource Balancer] PREVIEW ${logLine}`);
        results.push({ ...tr, status: "preview" });
      } else {
        try {
          const res = await this.api.tradeBetweenTowns(
            activeTownId, tr.fromId, tr.toId,
            tr.res === "wood"  ? tr.amount : 0,
            tr.res === "stone" ? tr.amount : 0,
            tr.res === "iron"  ? tr.amount : 0,
          );
          if (res?.success) {
            logger.info(`[Resource Balancer] ✓ ${logLine}`);
            results.push({ ...tr, status: "ok", arrival: res.arrival });
          } else {
            logger.warn(`[Resource Balancer] Mislukt: ${logLine}`);
            results.push({ ...tr, status: "failed" });
          }
        } catch (e) {
          logger.warn(`[Resource Balancer] Fout: ${e.message || e}`);
          results.push({ ...tr, status: "error", error: e.message });
        }
        // Korte pauze tussen transfers
        await new Promise(r => setTimeout(r, 800 + Math.random() * 400));
      }
    }

    // Sla transfer-log op in GAS
    try {
      await this.stats.saveTradeLog({
        timestamp: new Date().toISOString(),
        preview,
        transfers: results,
      });
    } catch (e) {
      logger.warn(`[Resource Balancer] Trade log opslaan mislukt: ${e.message}`);
    }
  }
}

module.exports = ResourceBalancer;
