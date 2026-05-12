/**
 * FarmAgent — verantwoordelijk voor:
 *   - Farm balancer (welke stad per eiland)
 *   - Opslagcheck voor claimen
 *   - claim_loads_multiple uitvoeren
 */
const logger = require("../utils/logger");

class FarmAgent {
  constructor({ api, config, stats }) {
    this.api      = api;
    this.config   = config;
    this.stats    = stats;
    this.eilanden = config.eilanden ?? {};
    this.opties   = config.opties   ?? {};
    this._nextReadyAt  = null;
    this._hadStorageSkip = false;
  }

  // ── Farm Balancer: kies primaire stad per eiland ─────────────
  _filterTownsPerEiland(towns) {
    const balancerAan = this.opties.balancer !== false;
    const drempel     = this.opties.balancer_drempel_pct ?? 80;

    const eilandMap = {};
    for (const town of towns) {
      const key = `${town.island_x}_${town.island_y}`;
      if (!eilandMap[key]) eilandMap[key] = [];
      eilandMap[key].push(town);
    }

    const fillPct = (t) => {
      const cap = t.storage_volume || 1;
      return [
        Math.round((t.wood  || 0) / cap * 100),
        Math.round((t.stone || 0) / cap * 100),
        Math.round((t.iron  || 0) / cap * 100),
      ];
    };
    const boven = (t) => fillPct(t).filter(p => p >= drempel).length;

    const gefilterd = [];
    for (const [key, eilandTowns] of Object.entries(eilandMap)) {
      const eilandConfig = this.eilanden[key];
      let primair = null;

      if (eilandConfig?.primaire_stad_id) {
        primair = eilandTowns.find(t => t.id === eilandConfig.primaire_stad_id);
        if (!primair) {
          logger.warn(`[Farm] Eiland ${key}: primaire stad ${eilandConfig.primaire_stad_id} niet gevonden`);
          primair = eilandTowns[0];
        }
      } else {
        primair = eilandTowns[0];
        if (eilandTowns.length > 1)
          logger.info(`[Farm] Eiland ${key}: geen config → default ${primair.name}`);
      }

      // Farm Balancer: wissel als ≥2 grondstoffen boven drempel
      if (balancerAan && eilandTowns.length > 1) {
        const primairBoven = boven(primair);
        if (primairBoven >= 2) {
          const maxFill = (t) => Math.max(...fillPct(t));
          const alternatieven = eilandTowns
            .filter(t => t.id !== primair.id)
            .sort((a, b) => boven(a) - boven(b) || maxFill(a) - maxFill(b));
          const best = alternatieven[0];
          if (best && (boven(best) < primairBoven || maxFill(best) < maxFill(primair))) {
            logger.info(`[Farm] 🔄 Farm Balancer ${key}: ${primair.name} (${fillPct(primair).join("/")}%) → ${best.name} (${fillPct(best).join("/")}%)`);
            gefilterd.push(best);
            continue;
          }
        }
      }

      gefilterd.push(primair);
    }
    return gefilterd;
  }

  // ── Eén farm ronde uitvoeren ──────────────────────────────
  async run(allTowns, intervalKey) {
    this._hadStorageSkip = false;
    const towns = this._filterTownsPerEiland(allTowns);
    return await this._farmAllTowns(towns, intervalKey);
  }

  // ── Alle dorpen farmen ────────────────────────────────────
  async _farmAllTowns(towns, intervalKey) {
    const townResults    = [];
    let earliestCooldown = null;

    for (let i = 0; i < towns.length; i++) {
      const town = towns[i];
      try {
        const { owned, ready, nextReady } = await this.api.getFarmOverview(town);
        townResults.push({ town, owned, ready });
        if (nextReady && isFinite(nextReady))
          earliestCooldown = earliestCooldown ? Math.min(earliestCooldown, nextReady) : nextReady;
        if (i < towns.length - 1) await this._sleep(400 + Math.random() * 400);
      } catch (err) {
        if (err.message === "SESSION_EXPIRED") throw err;
        const emsg = err.message || err.code || (err.response?.status) || String(err);
        logger.warn(`[Farm] ${town.name} overview fout: ${emsg}`);
      }
    }

    const townsWithReady = townResults.filter(r => r.ready.length > 0);
    if (townsWithReady.length === 0) {
      if (earliestCooldown && isFinite(earliestCooldown)) this._nextReadyAt = earliestCooldown;
      logger.info("[Farm] Geen dorpen klaar");
      return { wood:0, stone:0, iron:0, farms:0, townSnapshots:[] };
    }

    // Opslagcheck — haal verse stadsdata op voor claimen
    const townsData = await this.api.getTowns();
    const drempel   = this.opties.opslag_drempel_pct ?? 95;

    for (const tr of townsWithReady) {
      const td = townsData.find(t => t.id === tr.town.id);
      if (!td?.storage_volume) continue;
      const cap = td.storage_volume;
      const pW  = Math.round((td.wood  ?? 0) / cap * 100);
      const pS  = Math.round((td.stone ?? 0) / cap * 100);
      const pI  = Math.round((td.iron  ?? 0) / cap * 100);
      const wW  = pW >= 90 ? "⚠️" : pW >= 80 ? "!" : "";
      const wS  = pS >= 90 ? "⚠️" : pS >= 80 ? "!" : "";
      const wI  = pI >= 90 ? "⚠️" : pI >= 80 ? "!" : "";
      const gain = this.api.estimateGain(tr.town, tr.ready.length, intervalKey);
      const overflows = [
        (td.wood  ?? 0) + gain > cap * drempel / 100,
        (td.stone ?? 0) + gain > cap * drempel / 100,
        (td.iron  ?? 0) + gain > cap * drempel / 100,
      ].filter(Boolean).length;

      if (overflows >= 2) {
        logger.info(`[Farm] ${tr.town.name} SKIP — opslag 🪵${pW}%${wW} 🪨${pS}%${wS} 🪙${pI}%${wI} (te vol)`);
        tr.skip = true;
        this._hadStorageSkip = true;
      }
    }

    const townsToFarm = townsWithReady.filter(r => !r.skip);
    if (townsToFarm.length === 0) return { wood:0, stone:0, iron:0, farms:0, townSnapshots:[] };

    await this._sleep(400 + Math.random() * 800);

    const allFarmTowns = townsToFarm.map(r => r.town);
    let totalFarms = townsToFarm.reduce((s, r) => s + r.ready.length, 0);
    if (Math.random() < (this.opties.dorp_overslaan_kans ?? 0.02))
      totalFarms = Math.max(0, totalFarms - 1);

    try {
      const result = await this.api.claimLoads(allFarmTowns, [], intervalKey);
      if (!result) {
        logger.warn("[Farm] Claim geen resultaat");
        return { wood:0, stone:0, iron:0, farms:0, townSnapshots:[] };
      }

      const townsNa = this.api._townsNaData ?? [];
      const townSnapshots = [];

      for (const { town, ready } of townsToFarm) {
        const tdVoor = townsData.find(t => t.id === town.id);
        const tdNa   = townsNa.find(t => t.id === town.id);
        if (!tdVoor || !tdNa || !tdNa.storage_volume) continue;

        const cap = tdNa.storage_volume;
        const pNW = Math.round((tdNa.wood  ?? 0) / cap * 100);
        const pNS = Math.round((tdNa.stone ?? 0) / cap * 100);
        const pNI = Math.round((tdNa.iron  ?? 0) / cap * 100);
        logger.info(`[Farm] ${town.name}: 🪵${pNW}% 🪨${pNS}% 🪙${pNI}%`);
        townSnapshots.push({
          town_id: town.id, town_name: town.name,
          wood: tdNa.wood, stone: tdNa.stone, silver: tdNa.iron,
          storage_max: cap, pct_wood: pNW, pct_stone: pNS, pct_silver: pNI,
        });
      }

      return {
        wood: result.wood, stone: result.stone, iron: result.iron, farms: totalFarms,
        townSnapshots,
      };
    } catch (err) {
      if (err.message === "SESSION_EXPIRED") throw err;
      const cerr = err.message || err.code || (err.response?.status) || String(err);
      logger.warn(`[Farm] Claim fout: ${cerr}`);
      return { wood:0, stone:0, iron:0, farms:0, townSnapshots:[] };
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = FarmAgent;
