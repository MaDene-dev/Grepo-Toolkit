const Session     = require("./auth/session");
const GrepolisAPI = require("./api/grepolis");
const Mailer      = require("./utils/mailer");
const logger      = require("./utils/logger");
const config      = require("../config.json");

if (process.env.GREPO_EMAIL)    config.account.username = process.env.GREPO_EMAIL;
if (process.env.GREPO_PASSWORD) config.account.password = process.env.GREPO_PASSWORD;
if (process.env.SMTP_TO)        config.email.to         = process.env.SMTP_TO;

if (process.env.GREPO_ACCOUNT) {
  try {
    const account = JSON.parse(process.env.GREPO_ACCOUNT);
    if (account.world)     config.account.world     = account.world;
    if (account.player_id) config.account.player_id = account.player_id;
    if (account.towns)     config.account.towns     = account.towns;
  } catch (e) {}
}

async function run() {
  logger.info("=== Dagelijks Rapport ===");

  const mailer  = new Mailer(config);
  const session = new Session(config);

  try {
    await session.login();
  } catch (err) {
    logger.error(`Login mislukt: ${err.message}`);
    await mailer.send(
      "⚠️ Dagrapport mislukt — login fout",
      `Tijdstip: ${new Date().toLocaleString("nl-BE")}\n\nDe bot kon niet inloggen voor het dagrapport.\nWaarschijnlijk zijn de cookies verlopen.\n\nExporteer nieuwe cookies via Cookie-Editor en update het GREPO_COOKIES secret.`
    );
    process.exit(0);
  }

  const api   = new GrepolisAPI(session);
  const towns = await api.getTowns();
  const now   = new Date().toLocaleString("nl-BE", { timeZone: "Europe/Brussels" });
  // Correcte dag berekening met Intl.DateTimeFormat
  const nlDate = new Intl.DateTimeFormat("nl-BE", {
    timeZone: "Europe/Brussels",
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  }).format(new Date());

  // Haal overzicht op per stad — naam wordt opgehaald uit de game
  const townLines = [];
  for (const town of towns) {
    try {
      const { owned, ready } = await api.getFarmOverview(town);
      // Gebruik naam uit config of de town zelf
      const naam = town.name || `Stad ${town.id}`;
      townLines.push(
        `  🏛️  ${naam} — ${owned.length} dorpen (${ready.length} klaar om te farmen)`
      );
    } catch (_) {
      townLines.push(`  🏛️  Stad ${town.id} — kon niet ophalen`);
    }
  }

  const text = [
    `📅 DAGELIJKS RAPPORT — ${nlDate}`,
    ``,
    `Tijdstip: ${now}`,
    `Wereld:   ${config.account.world.toUpperCase()}`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🏙️  STEDEN`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ...townLines,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `ℹ️  STATUS`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `  Bot draait normaal ✅`,
    `  Actieve blokken: ${config.dagschema.blokken.filter(b => b.actief).map(b => `${b.van}–${b.tot}`).join(" | ")}`,
    `  Blokken: ${config.dagschema.blokken.map(b => `${b.van}–${b.tot} → ${b.interval} (${config.intervals[b.interval]?.label})`).join(" | ")}`,
    ``,
    `Goedenavond! 🌙`,
  ].join("\n");

  await mailer.send(`📅 Dagrapport ${nlDate}`, text);
  logger.info("Dagrapport verstuurd.");
  process.exit(0);
}

run().catch(err => {
  logger.error(`Onverwachte fout: ${err.message}`);
  process.exit(1);
});
