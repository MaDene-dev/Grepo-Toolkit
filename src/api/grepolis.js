const logger = require("../utils/logger");

// Tijdsopties per interval, afhankelijk van booty-onderzoek
const TIME_OPTIONS = {
  A: { booty: 600,   base: 300  },
  B: { booty: 2400,  base: 1200 },
  C: { booty: 10800, base: 5400 },
  D: { booty: 28800, base: 14400 },
};

class GrepolisAPI {
  constructor(session) {
    this.session = session;
    this._towns  = null; // Cache: [{id, name, island_x, island_y, booty_researched}]
  }

  // ── Steden ophalen ─────────────────────────────────────────
  async getTowns() {
    if (this._towns?.length > 0) return this._towns;

    // Haal actief town ID op via toid cookie
    const cookies = await this.session.jar.getCookies(this.session.baseUrl);
    const toidCookie = cookies.find(c => c.key === "toid");
    if (!toidCookie) throw new Error("Geen toid cookie — sessie niet geldig.");
    const activeTownId = parseInt(toidCookie.value);

    // action=index geeft towns array terug met alle steden + island coords + booty_researched
    const data = await this.session.gameGet(
      "farm_town_overviews", activeTownId, "index",
      JSON.stringify({ town_id: activeTownId, nl_init: true })
    );

    if (Array.isArray(data?.towns) && data.towns.length > 0) {
      this._towns = data.towns.map(t => ({
        id:               t.id,
        name:             t.name,
        island_x:         t.island_x,
        island_y:         t.island_y,
        booty_researched: t.booty_researched ?? false,
      }));
      logger.info(`[API] ${this._towns.length} steden: ${this._towns.map(t=>`${t.name}(${t.booty_researched?"booty":"basis"})`).join(", ")}`);
      return this._towns;
    }

    // Fallback: config/secret
    if (this.session.config.account.towns?.length > 0) {
      this._towns = this.session.config.account.towns;
      logger.info(`[API] ${this._towns.length} steden uit config`);
      return this._towns;
    }

    throw new Error("Geen steden gevonden.");
  }

  resetTowns() { this._towns = null; }

  // ── Farm overview per stad (bewezen werkende aanpak) ────────
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
      logger.info(`[API] ${town.name}: ${owned.length} dorpen, ${ready.length} klaar (eerste klaar over ~${minsLeft} min)`);
    } else {
      logger.info(`[API] ${town.name}: ${owned.length} dorpen, ${ready.length} klaar`);
    }

    return { owned, ready, nextReady };
  }

  // ── Grondstoffen claimen voor alle steden tegelijk ─────────
  async claimLoads(towns, farmTownIds, intervalKey) {
    const townIds = towns.map(t => t.id);
    const activeTown = towns[0];

    // Bepaal time_option per town type
    const opts = TIME_OPTIONS[intervalKey] ?? TIME_OPTIONS.A;

    // Gebruik claim_loads_multiple als er meerdere steden zijn
    if (townIds.length > 1) {
      const hasBooty = towns.some(t => t.booty_researched);
      const hasBase  = towns.some(t => !t.booty_researched);

      const payload = JSON.stringify({
        towns:              townIds,
        time_option_booty:  hasBooty ? opts.booty : opts.base,
        time_option_base:   opts.base,
        claim_factor:       "normal",
        town_d:             activeTown.id,
        nl_init:            true,
      });

      const data = await this.session.gamePost(
        "farm_town_overviews", activeTown.id, "claim_loads_multiple", payload
      );

      if (typeof data === "string" && (data.includes("captcha") || data.includes("robot"))) {
        throw new Error("CAPTCHA gedetecteerd");
      }

      if (data?.success) {
        const claimed = data.claimed_resources_per_resource_type ?? 0;
        const storage = data.resources ?? {};
        return {
          wood: claimed, stone: claimed, iron: claimed,
          storageWood:  storage.wood  ?? 0,
          storageStone: storage.stone ?? 0,
          storageIron:  storage.iron  ?? 0,
          storageMax:   data.storage  ?? 0,
        };
      }
      if (data?.error) logger.warn(`[API] claim_loads_multiple fout: ${data.error}`);
      return null;
    }

    // Single town: gebruik originele claim_loads
    const timeOption = activeTown.booty_researched ? opts.booty : opts.base;
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
        wood: claimed, stone: claimed, iron: claimed,
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
