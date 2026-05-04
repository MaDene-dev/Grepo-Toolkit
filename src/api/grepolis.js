const logger = require("../utils/logger");

class GrepolisAPI {
  constructor(session, config) {
    this.session    = session;
    this.config     = config || session.config || {};
    this._towns     = null;
    this._loadsData = null;
  }

  async getTowns() {
    if (this._towns?.length > 0) return this._towns;

    const cookies = await this.session.jar.getCookies(this.session.baseUrl);
    const toidCookie = cookies.find(c => c.key === "toid");
    if (!toidCookie) throw new Error("Geen toid cookie — sessie niet geldig.");
    const activeTownId = parseInt(toidCookie.value);

    const data = await this.session.gameGet(
      "farm_town_overviews", activeTownId, "index",
      JSON.stringify({ town_id: activeTownId, nl_init: true })
    );

    // Bewaar loads_data voor nauwkeurige opbrengst-schatting
    if (data?.loads_data) this._loadsData = data.loads_data;

    if (Array.isArray(data?.towns) && data.towns.length > 0) {
      this._towns = data.towns.map(t => ({
        id:               t.id,
        name:             t.name,
        island_x:         t.island_x,
        island_y:         t.island_y,
        booty_researched: t.booty_researched ?? false,
        wood:             t.wood ?? 0,
        stone:            t.stone ?? 0,
        iron:             t.iron ?? 0,
        storage_volume:   t.storage_volume ?? 0,
      }));
      logger.info(`[API] ${this._towns.length} steden: ${this._towns.map(t => `${t.name}(${t.booty_researched ? "booty" : "basis"})`).join(", ")}`);
      return this._towns;
    }

    if (this.config.account.towns?.length > 0) {
      this._towns = this.config.account.towns;
      logger.info(`[API] ${this._towns.length} steden uit config`);
      return this._towns;
    }

    throw new Error("Geen steden gevonden.");
  }

  resetTowns() {
    this._towns     = null;
    this._loadsData = null;
  }

  // Schat opbrengst op basis van loads_data (nauwkeurig) of ruwe formule (fallback)
  estimateGain(town, readyCount, intervalKey) {
    const config  = this.config;
    const iv      = config.intervals?.[intervalKey];
    const timeOpt = town.booty_researched
      ? (iv?.time_option_booty ?? 600)
      : (iv?.time_option_base  ?? 300);

    if (this._loadsData?.[timeOpt]) {
      const resources = this._loadsData[timeOpt].resources;
      if (Array.isArray(resources) && resources.length > 0) {
        // Gemiddelde van alle resource-niveaus × aantal klare dorpen
        const avg = resources.reduce((a, b) => a + b, 0) / resources.length;
        return avg * readyCount;
      }
    }
    // Ruwe fallback
    return town.booty_researched
      ? timeOpt / 600 * 255 * readyCount
      : timeOpt / 300 * 80  * readyCount;
  }

  async getFarmOverview(town) {
    const payload = JSON.stringify({
      island_x:             town.island_x ?? 0,
      island_y:             town.island_y ?? 0,
      current_town_id:      town.id,
      booty_researched:     town.booty_researched ? "1" : "",
      diplomacy_researched: "",
      trade_office:         0,
      town_id:              town.id,
      nl_init:              false,
    });

    const data = await this.session.gameGet(
      "farm_town_overviews", town.id, "get_farm_towns_for_town", payload
    );

    if (typeof data === "string" && (data.includes("captcha") || data.includes("robot"))) {
      throw new Error("CAPTCHA gedetecteerd");
    }

    const now      = Math.floor(Date.now() / 1000);
    const farmList = data?.farm_town_list ?? [];
    const owned    = farmList.filter(v => v.rel === 1);
    const ready    = owned.filter(v => !v.loot || v.loot < now);

    if (owned.length === 0 && !data?.farm_town_list) {
      logger.warn(`[API] Lege response voor ${town.name} — mogelijk verlopen sessie`);
      throw new Error("SESSION_EXPIRED");
    }

    const cooldowns = owned.filter(v => v.loot && v.loot > now).map(v => v.loot);
    const nextReady = cooldowns.length > 0 ? Math.min(...cooldowns) : null;

    if (nextReady && ready.length === 0) {
      const minsLeft = Math.ceil((nextReady - now) / 60);
      logger.info(`[API] ${town.name}: ${owned.length} dorpen, 0 klaar (eerste klaar over ~${minsLeft} min)`);
    } else {
      logger.info(`[API] ${town.name}: ${owned.length} dorpen, ${ready.length} klaar`);
    }

    return { owned, ready, nextReady };
  }

  async claimLoads(towns, farmTownIds, intervalKey) {
    const activeTown = towns[0];
    const iv         = this.config.intervals?.[intervalKey];

    // Gebruik claim_loads_multiple voor meerdere steden (één API call, zoals de UI)
    if (towns.length > 1) {
      const payload = JSON.stringify({
        towns:             towns.map(t => t.id), // eigen stad-IDs, niet farm-dorp IDs
        time_option_booty: iv?.time_option_booty ?? 600,
        time_option_base:  iv?.time_option_base  ?? 300,
        claim_factor:      "normal",
        town_d:            activeTown.id,
        nl_init:           true,
      });

      const data = await this.session.gamePost(
        "farm_town_overviews", activeTown.id, "claim_loads_multiple", payload
      );

      if (typeof data === "string" && (data.includes("captcha") || data.includes("robot"))) {
        throw new Error("CAPTCHA gedetecteerd");
      }

      logger.info(`[API] claim_loads_multiple response keys: ${data ? Object.keys(data).join(", ") : "null"}`);
      if (data && !data.success) logger.info(`[API] Volledige response: ${JSON.stringify(data).substring(0, 300)}`);

      if (data?.success) {
        // Kan een object zijn {wood: X, stone: Y, iron: Z} of een enkel getal
        let wood = 0, stone = 0, iron = 0;
        const cr = data.claimed_resources;
        const crType = data.claimed_resources_per_resource_type;

        if (cr && typeof cr === "object") {
          wood  = cr.wood  ?? cr[1] ?? 0;
          stone = cr.stone ?? cr[2] ?? 0;
          iron  = cr.iron  ?? cr[3] ?? 0;
        } else if (crType !== undefined) {
          wood = stone = iron = crType;
        }

        // Log de ruwe response voor diagnose
        logger.info(`[API] Claim response: claimed=${JSON.stringify(cr ?? crType).substring(0,100)}`);

        const storage = data.resources ?? {};
        return {
          wood, stone, iron,
          storageWood:  storage.wood  ?? 0,
          storageStone: storage.stone ?? 0,
          storageIron:  storage.iron  ?? 0,
          storageMax:   data.storage  ?? 0,
        };
      }
      if (data?.error) logger.warn(`[API] claim_loads_multiple fout: ${data.error}`);
      return null;
    }

    // Enkele stad: gebruik claim_loads
    const timeOption = activeTown.booty_researched
      ? (iv?.time_option_booty ?? 600)
      : (iv?.time_option_base  ?? 300);

    const payload = JSON.stringify({
      farm_town_ids:   farmTownIds,
      time_option:     timeOption,
      claim_factor:    "normal",
      current_town_id: activeTown.id,
      town_id:         activeTown.id,
      nl_init:         true,
    });

    const data = await this.session.gamePost(
      "farm_town_overviews", activeTown.id, "claim_loads", payload
    );

    if (typeof data === "string" && (data.includes("captcha") || data.includes("robot"))) {
      throw new Error("CAPTCHA gedetecteerd");
    }

    if (data?.success) {
      const claimed = data.claimed_resources_per_resource_type ?? 0;
      const storage = data.resources ?? {};
      return {
        wood:         claimed,
        stone:        claimed,
        iron:         claimed,
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
