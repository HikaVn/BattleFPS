// Shared gameplay definitions (weapons, heals, loot) used by both the
// server (authoritative damage / inventory) and the client (rendering / UI).
// Loaded as an ES module in the browser and via dynamic import on the server.

export const MAX_HP = 100;
export const MAX_SHIELD = 100;

// Weapons. damage is per-pellet; shotguns fire several pellets per shot.
export const WEAPONS = {
  pistol: {
    id: 'pistol', name: 'ピストル', ammoType: 'light',
    damage: 20, head: 1.8, pellets: 1, mag: 12, fireInterval: 240, reload: 1100, range: 120, spread: 0.004, color: 0xbfc4cc,
  },
  rifle: {
    id: 'rifle', name: 'アサルトライフル', ammoType: 'light',
    damage: 15, head: 1.7, pellets: 1, mag: 30, fireInterval: 110, reload: 1700, range: 200, spread: 0.012, color: 0x4d7cff,
  },
  shotgun: {
    id: 'shotgun', name: 'ショットガン', ammoType: 'shell',
    damage: 11, head: 1.4, pellets: 9, mag: 6, fireInterval: 720, reload: 2200, range: 45, spread: 0.06, color: 0xff8c1a,
  },
  sniper: {
    id: 'sniper', name: 'スナイパー', ammoType: 'heavy',
    damage: 65, head: 2.0, pellets: 1, mag: 4, fireInterval: 1300, reload: 2600, range: 400, spread: 0.0, color: 0x2ec98a,
  },
};

export const AMMO_TYPES = ['light', 'shell', 'heavy'];
export const MAX_AMMO = { light: 180, shell: 64, heavy: 40 };

// Healing / shield consumables. `time` is the channel time in ms.
export const HEALS = {
  syringe:  { id: 'syringe',  name: '注射器',         kind: 'hp',     amount: 25,  time: 3000, max: 8, color: 0x39d353 },
  medkit:   { id: 'medkit',   name: 'メドキット',     kind: 'hp',     amount: 100, time: 6000, max: 3, color: 0x26a641 },
  cell:     { id: 'cell',     name: 'シールドセル',   kind: 'shield', amount: 25,  time: 3000, max: 8, color: 0x4dc3ff },
  battery:  { id: 'battery',  name: 'シールドバッテリー', kind: 'shield', amount: 100, time: 4500, max: 3, color: 0x1f9fff },
};

// Loot kinds that can appear on the ground.
// type: 'weapon' | 'ammo' | 'heal' | 'shield'
export function lootCatalogue() {
  return [
    { type: 'weapon', key: 'rifle' },
    { type: 'weapon', key: 'shotgun' },
    { type: 'weapon', key: 'sniper' },
    { type: 'ammo', key: 'light', amount: 60 },
    { type: 'ammo', key: 'shell', amount: 16 },
    { type: 'ammo', key: 'heavy', amount: 12 },
    { type: 'heal', key: 'syringe' },
    { type: 'heal', key: 'medkit' },
    { type: 'shield', key: 'cell' },
    { type: 'shield', key: 'battery' },
    { type: 'armor', key: 'armor', amount: 50 }, // body shield pickup: raises shield by 50 instantly (caps at MAX_SHIELD)
  ];
}

// Image filename for a given loot item, looked up under public/assets/items/.
// These are the files described in ITEM_IMAGE_PROMPTS.md. When a PNG is present
// the client renders it as a billboard sprite; otherwise it falls back to a
// procedural mesh, so the game works with or without generated art.
export function lootImage(type, key) {
  const map = {
    'weapon/pistol': 'weapon_pistol.png',
    'weapon/rifle': 'weapon_rifle.png',
    'weapon/shotgun': 'weapon_shotgun.png',
    'weapon/sniper': 'weapon_sniper.png',
    'ammo/light': 'ammo_light.png',
    'ammo/shell': 'ammo_shell.png',
    'ammo/heavy': 'ammo_heavy.png',
    'heal/syringe': 'heal_syringe.png',
    'heal/medkit': 'heal_medkit.png',
    'shield/cell': 'shield_cell.png',
    'shield/battery': 'shield_battery.png',
    'armor/armor': 'armor_body.png',
  };
  const file = map[`${type}/${key}`];
  return file ? `assets/items/${file}` : null;
}
