const logger = require("../utils/logger");

class GrepolisAPI {
  constructor(session) {
    this.session = session;
  }

  async getTowns() {
    // Probeer steden op te halen via de player_towns API
    const playerId = this.session.playerId || this.session.config.account.player_id;
    if (playerId) {
      const towns = await this._fetchTownsFromApi(playerId);
      if (towns.length > 0) return towns;
    }

    // Fallback: steden uit GREPO_ACCOUNT secret / config.json
    if (this.session.config.account.towns?.length > 0) {
      logger.info(`[API] ${this.session.config.account.towns.length} steden uit config geladen`);
      return this.session.config.account.towns;
    }

    throw new Error("Geen steden gevonden via API of config. Wacht op logs voor diagnose.");
  }

  async _fetchTownsFromApi(playerId) {
    const html = this.session.lastHtml ?? "";
    if (!html) return [];

    // Steden zitten in DM.loadData(...) call in de HTML
    // Zoek alle DM.loadData calls en log de eerste 500 chars
    const dmIdx = html.indexOf("DM.loadData(");
    if (dmIdx >= 0) {
      logger.info(`[API] DM.loadData snippet: ${html.substring(dmIdx, dmIdx + 500)}`);
      try {
        // Extraheer de JSON uit DM.loadData({...})
        const start = html.indexOf("{", dmIdx);
        let depth = 0, end = start;
        for (let i = start; i < Math.min(html.length, start + 500000); i++) {
          if (html[i] === "{") depth++;
          if (html[i] === "}") depth--;
          if (depth === 0) { end = i + 1; break; }
        }
        const jsonStr = html.substring(start, end);
        const data = JSON.parse(jsonStr);

        // Log de keys op het hoogste niveau
        logger.info(`[API] DM.loadData keys: ${Object.keys(data).join(", ")}`);

        // Probeer steden te vinden
        const townsObj = data.towns ?? data.player?.towns ?? null;
        if (townsObj) {
          const list = Array.isArray(townsObj)
            ? townsObj
            : Object.values(townsObj);
          if (list.length > 0) {
            logger.info(`[API] Eerste stad sample: ${JSON.stringify(list[0]).substring(0, 200)}`);
            const towns = list.map(t => ({
              id:       t.id,
              name:     t.name,
              island_x: t.island_x ?? t.x ?? 0,
              island_y: t.island_y ?? t.y ?? 0,
            }));
            logger.info(`[API] ${towns.length} steden gevonden: ${towns.map(t => t.name).join(", ")}`);
            return towns;
          }
        }

        logger.info(`[API] Geen towns gevonden in DM.loadData — log sample data voor diagnose`);
      } catch (err) {
        logger.warn(`[API] DM.loadData parse fout: ${err.message}`);
      }
    } else {
      logger.warn(`[API] DM.loadData niet gevonden in HTML (${html.length} bytes)`);
    }
    return [];
  }

  async _getTownIdFromCookie() {
    try {
      const cookies = await this.session.jar.getCookies(this.session.baseUrl);
      const toid = cookies.find(c => c.key === "toid");
      return toid ? parseInt(toid.value) : null;
    } catch (_) { return null; }
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
      nl_init:              true,
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

    // Lege response zonder farm_town_list = verlopen sessie
    if (owned.length === 0 && !data?.farm_town_list) {
      logger.warn(`[API] Lege response voor ${town.name} — mogelijk verlopen sessie`);
      throw new Error("SESSION_EXPIRED");
    }

    // Bereken wanneer het eerstvolgende dorp uit cooldown komt
    const cooldowns = owned
      .filter(v => v.loot && v.loot > now)
      .map(v => v.loot);
    const nextReady = cooldowns.length > 0 ? Math.min(...cooldowns) : null;

    if (nextReady) {
      const secsLeft = nextReady - now;
      const minsLeft = Math.ceil(secsLeft / 60);
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
