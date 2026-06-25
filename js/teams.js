// teams.js — Provided teams dataset + map pool.
// Each team: { id, name, tag, players[], logo }
// logo is intentionally empty; the UI renders a generated tag avatar.

export const MAP_POOL = [
  "Ancient",
  "Anubis",
  "Cache",
  "Dust II",
  "Inferno",
  "Mirage",
  "Nuke",
  "Vertigo",
  "Overpass",
  "Office",
  "Italy",
  "Train",
];

// Map display name -> local icon (CS2 map icons sourced from
// https://github.com/MurkyYT/cs2-map-icons, keyed by depot name).
const MAP_ICONS = {
  Ancient: "img/maps/de_ancient.png",
  Anubis: "img/maps/de_anubis.png",
  Cache: "img/maps/de_cache.png",
  "Dust II": "img/maps/de_dust2.png",
  Inferno: "img/maps/de_inferno.png",
  Mirage: "img/maps/de_mirage.png",
  Nuke: "img/maps/de_nuke.png",
  Overpass: "img/maps/de_overpass.png",
  Vertigo: "img/maps/de_vertigo.png",
  Office: "img/maps/cs_office.png",
  Italy: "img/maps/cs_italy.png",
  Train: "img/maps/de_train.png",
};

export function mapIcon(name) {
  return MAP_ICONS[name] || null;
}

const RAW_TEAMS = [
  { name: "Team Vitality", tag: "VITA", logo: "vita", players: ["apEX", "ZywOo", "ropz", "mezii", "flameZ"] },
  { name: "FURIA Esports", tag: "FUR", logo: "furi", players: ["yuurih", "FalleN", "KSCERATO", "YEKINDAR", "molodoy"] },
  { name: "Falcons", tag: "FAL", logo: "fal", players: ["NiKo", "TeSeS", "m0NESY", "karrigan", "kyousuke"] },
  { name: "MOUZ", tag: "MOUZ", logo: "mouz", players: ["jL", "torzsi", "Spinx", "xelex", "xertioN"] },
  { name: "FaZe", tag: "FAZE", logo: "faze", players: ["enkay J", "frozen", "Twistzz", "broky", "jcobbb"] },
  { name: "The MongolZ", tag: "MGLZ", logo: "mngz", players: ["bLitz", "Techno4K", "mzinho", "910", "cobrazera"] },
  { name: "Natus Vincere", tag: "NAVI", logo: "navi", players: ["Aleksib", "iM", "b1t", "w0nderful", "makazze"] },
  { name: "Spirit", tag: "SPR", logo: "spir", players: ["sh1ro", "magixx", "tN1R", "zont1x", "donk"] },
  { name: "G2 Esports", tag: "G2", logo: "g2", players: ["huNter-", "NertZ", "SunPayus", "HeavyGod", "MATYS"] },
  { name: "Aurora", tag: "AUR", logo: "aura", players: ["MAJ3R", "XANTARES", "woxic", "soulfly", "Wicadia"] },
  { name: "B8", tag: "B8", logo: "b8", players: ["s1zzi", "alex666", "npl", "kensizor", "esenthial"] },
  { name: "3DMAX", tag: "3DMX", logo: "3dm", players: ["misutaaa", "Maka", "Lucky", "Ex3rcice", "Graviti"] },
  { name: "paiN Gaming", tag: "PAIN", logo: "pain", players: ["vsm", "biguzera", "piriajr", "saffee", "snow"] },
  { name: "Astralis", tag: "AST", logo: "astr", players: ["HooXi", "phzy", "jabbi", "Staehr", "ryu"] },
  { name: "Team Liquid", tag: "LIQ", logo: "liq", players: ["NAF", "EliGE", "malbsMd", "siuhy", "ultimate"] },
  { name: "Legacy", tag: "LEG", logo: "lgcy", players: ["dumau", "latto", "n1ssim", "arT", "saadzin"] },
  { name: "PARIVISION", tag: "PARI", logo: "pari", players: ["Jame", "BELCHONOKK", "xiELO", "nota", "zweih"] },
  { name: "M80", tag: "M80", logo: "m80", players: ["slaxz-", "Swisher", "s1n", "JBa", "Lake"] },
  { name: "GamerLegion", tag: "GL", logo: "gl", players: ["Snax", "REZ", "Tauson", "PR", "hypex"] },
  { name: "Virtus.pro", tag: "VP", logo: "vp", players: ["FL1T", "Perfecto", "fame", "b1st", "tO0RO"] },
  { name: "Ninjas in Pyjamas", tag: "NIP", logo: "nip", players: ["Snappi", "sjuush", "stavn", "xKacpersky", "cairne"] },
  { name: "HEROIC", tag: "HER", logo: "hero", players: ["xfl0ud", "nilo", "susp", "Chr1zN", "yxngstxr"] },
  { name: "Lynn Vision", tag: "LV", logo: "lynn", players: ["Westmelon", "z4KR", "Starry", "EmiliaQAQ", "C4LLM3SU3"] },
  { name: "NRG", tag: "NRG", logo: "nrg", players: ["nitr0", "Sonic", "oSee", "br0", "Grim"] },
  { name: "BetBoom", tag: "BB", logo: "bb", players: ["Boombl4", "S1ren", "d1Ledez", "zorte", "Magnojez"] },
  { name: "9z", tag: "9Z", logo: "9z", players: ["exp", "Luchov", "Meyern", "HUASOPEEK", "Max"] },
  { name: "fnatic", tag: "FNC", logo: "fntc", players: ["KRIMZ", "Br4tkO", "fEAR", "jambo", "jackasmo"] },
  { name: "TYLOO", tag: "TYL", logo: "tyl", players: ["JamYoung", "Jee", "Mercury", "Moseyuh", "Zero"] },
  { name: "Fluxo", tag: "FLX", logo: "flux", players: ["Lucaozy", "zevy", "decenty", "kye", "exit"] },
  { name: "Monte", tag: "MTE", logo: "mont", players: ["Bymas", "afro", "Gizmy", "AZUWU", "Rainwaker"] },
  { name: "BESTIA", tag: "BES", logo: "bes", players: ["nacho", "cass1n", "buda", "tomaszin", "timo"] },
  { name: "BIG", tag: "BIG", logo: "big", players: ["tabseN", "JDC", "faveN", "blameF", "gr1ks"] },
];

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Team ids with a local logo asset (sourced from
// https://github.com/lootmarket/esport-team-logos). Teams without one fall
// back to the generated tag avatar in the UI.
const TEAM_LOGOS = new Set([
  "9z",
  "3dmax", "astralis", "aurora", "b8", "bestia", "betboom", "big", "falcons",
  "faze", "fluxo", "fnatic", "furia-esports", "g2-esports", "gamerlegion",
  "heroic", "legacy", "lynn-vision", "m80", "monte", "mouz", "natus-vincere",
  "ninjas-in-pyjamas", "nrg", "pain-gaming", "spirit", "team-liquid",
  "team-vitality", "the-mongolz", "tyloo", "virtus-pro",
]);

// Local logo path for a team id, or null when none is available.
export function teamLogo(id) {
  return TEAM_LOGOS.has(id) ? `img/teams/${id}.png` : null;
}

export const TEAMS = RAW_TEAMS.map((t) => ({
  id: slug(t.name),
  name: t.name,
  tag: t.tag,
  players: t.players,
  // CS2 in-game logo code (mp_teamlogo). The UI still renders a generated
  // tag avatar; this is kept for parity with the source console commands.
  logo: t.logo || "",
}));
