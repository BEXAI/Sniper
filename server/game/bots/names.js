// Bot identity pool + difficulty presets. Names are RESERVED — humans cannot
// register or hello with them (enforced in identity.validateName).

export const BOT_NAMES = [
  'Vex', 'Moss', 'Talon', 'Kestrel', 'Juniper', 'Krait', 'Sable', 'Havoc',
  'Mirage', 'Drift', 'Onyx', 'Juno', 'Rook', 'Cinder', 'Wraith', 'Fen',
  'Larkspur', 'Grit', 'Halcyon', 'Nadir', 'Quill', 'Ember', 'Sorrel', 'Pike',
];

// Aim/behavior presets per difficulty tier.
export const BOT_TIERS = {
  easy: {
    reactionMs: 600, reactionJitterMs: 150,
    sigma0Deg: 3.5, tauSettleS: 1.2, fireThreshDeg: 0.9, errFloorDeg: 0.5,
    headshotPref: 0.30, turnRateDegS: 240,
  },
  medium: {
    reactionMs: 400, reactionJitterMs: 100,
    sigma0Deg: 2.2, tauSettleS: 0.8, fireThreshDeg: 0.6, errFloorDeg: 0.25,
    headshotPref: 0.55, turnRateDegS: 330,
  },
  hard: {
    reactionMs: 260, reactionJitterMs: 60,
    sigma0Deg: 1.4, tauSettleS: 0.55, fireThreshDeg: 0.45, errFloorDeg: 0.1,
    headshotPref: 0.75, turnRateDegS: 420,
  },
};

// Default room fill: 2 easy, 2 medium, 1 hard, 1 random.
export const DEFAULT_FILL = ['easy', 'easy', 'medium', 'medium', 'hard', 'random'];

// Plausible rank chevrons for bots (index into RANKS: Marksman..Veteran).
export const BOT_RANKS = { easy: 1, medium: 2, hard: 3 };
