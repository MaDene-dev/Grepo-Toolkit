const logger = require("../utils/logger");

class GrepolisAPI {
  constructor(session) {
    this.session = session;
    this._towns  = null; // Cache voor steden + island coords
  }

  async getTowns() {
    if (this._towns?.length > 0) return this._towns;

    // Haal actief town ID op via toid cookie
    const cookies = await this.session.jar.getCookies(this.session.baseUrl);
    const toidCookie = cookies.find(c => c.key === "toid");
    if (!toidCookie) throw new Error("Geen toid cookie gevonden — sessie niet geldig.");

    const activeTownId = parseInt(toidCookie.value);
    logger.info(`[API] Actief town ID: ${activeTownId}`);

    // Gebruik action=index (zoals de browser) — geeft farm_town_list incl. island coords
    const data = await this.session.gameGet(
      "farm_town_overviews", activeTownId, "index",
      JSON.stringify({ town_id: activeTownId, nl_init: true })
    );

    logger.info(`[API] index response type: ${typeof data} | keys: ${data ? Object.keys(data).join(", ") : "null"}`);
    if (data?.farm_town_list !== undefined) {
      logger.info(`[API] farm_town_list lengte: ${data.farm_town_list.length}`);
    }
    if (data?.error) logger.warn(`[API] index error: ${JSON.stringify(data.error)}`);

    const farmList = data?.farm_town_list ?? [];
    if (farmList.length > 0) {
      // Extraheer island coords uit de eerste farm (alle farms zijn op hetzelfde eiland)
      const ix = farmList[0].island_x;
      const iy = farmList[0].island_y;
      logger.info(`[API] Island coords: x=${ix} y=${iy}`);

      this._towns = [{
        id:       activeTownId,
        name:     `Stad ${activeTownId}`,
        island_x: ix,
        island_y: iy,
      }];
      logger.info(`[API] Stad ${activeTownId} geconfigureerd (x=${ix}, y=${iy})`);
      return this._towns;
    }

    // Fallback: config/secret
    if (this.session.config.account.towns?.length > 0) {
      logger.info(`[API] Steden uit config gebruikt`);
      this._towns = this.session.config.account.towns;
      return this._towns;
    }

    throw new Error("Geen steden gevonden. Voeg towns toe aan het GREPO_ACCOUNT secret.");
  }

  // Reset towns cache bij sessie-herstel
  resetTowns() {
    this._towns = null;
  }

  async getFarmOverview(town) {
    const payload = JSON.stringify({
      island_x:             town.island_x,
      island_y:             town.island_y,
      current_town_id:      town.id,
      booty_researched:     "",
      diplomacy_researched: "",
      trade_office:         0,
      town_id:              town.id,
      nl_init:              false,
    });

    const data = await this.session.gameGet(
      "farm_town_overviews", town.id, "get_farm_towns_for_town", payload
    );

    if (typeof data === "string" && (data.includes("captcha") || data.includes("robot"))) {
      throw new Error("CAPTCHA gedetecteerd in response");
    }

    const now      = Math.floor(Date.now() / 1000);
    const farmList = data?.farm_town_list ?? [];
    const owned    = farmList.filter(v => v.rel === 1);
    const ready    = owned.filter(v => !v.loot || v.loot < now);

    if (owned.length === 0 && !data?.farm_town_list) {
      logger.warn(`[API] Lege response voor ${town.name} — mogelijk verlopen sessie`);
      throw new Error("SESSION_EXPIRED");
    }

    // Update island coords in cache als ze beschikbaar zijn in de response
    if (owned.length > 0 && this._towns) {
      const t = this._towns.find(t => t.id === town.id);
      if (t && owned[0].island_x) {
        t.island_x = owned[0].island_x;
        t.island_y = owned[0].island_y;
      }
    }

    const cooldowns = owned.filter(v => v.loot && v.loot > now).map(v => v.loot);
    const nextReady = cooldowns.length > 0 ? Math.min(...cooldowns) : null;

    if (nextReady) {
      const minsLeft = Math.ceil((nextReady - now) / 60);
      logger.info(`[API] ${owned.length} eigen dorpen, ${ready.length} klaar${ready.length === 0 ? ` (eerste klaar over ~${minsLeft} min)` : ""}`);
    } else {
      logger.info(`[API] ${owned.length} eigen dorpen, ${ready.length} klaar`);
    }

    return { owned, ready, nextReady };
  }

  async claimLoads(town, farmTownIds, timeOption = 300) {
    const payload = JSON.stringify({
      farm_town_ids:   farmTownIds,
      time_option:     timeOption,
      claim_factor:    "normal",
      current_town_id: town.id,
      town_id:         town.id,
      nl_init:         true,
    });

    const data = await this.session.gamePost(
      "farm_town_overviews", town.id, "claim_loads", payload
    );

    if (typeof data === "string" && (data.includes("captcha") || data.includes("robot"))) {
      throw new Error("CAPTCHA gedetecteerd in response");
    }

    if (data?.success) {
      const claimed = data.claimed_resources_per_resource_type ?? 0;
      const storage = data.resources ?? {};
      return {
        wood:  claimed, stone: claimed, iron: claimed,
        storageWood:  storage.wood  ?? 0,
        storageStone: storage.stone ?? 0,
        storageIron:  storage.iron  ?? 0,
        storageMax:   data.storage  ?? 0,
      };
    }

    if (data?.error) logger.warn(`[API] claim_loads fout: ${data.error}`);
    return null;
  }
}

module.exports = GrepolisAPI;
