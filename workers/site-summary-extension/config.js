// DropX Site Summary Monitor — shared config
// Edit this file to change settings.

const CONFIG = {
  // Report Bot worker endpoint + token — fill in config.local.js (not committed)
  WA_URL:   "https://dropx-report-bot.onrender.com",
  WA_TOKEN: "",   // set in config.local.js

  // TESTING: send ALL alerts to Dark Store Testing group.
  // Set to "" and fill STATION_GROUPS to go live.
  TESTING_GROUP: "",  // set in config.local.js

  // Per-station live war room JIDs — used when TESTING_GROUP is empty.
  STATION_GROUPS: {
    TTB3: "120363424079156767@g.us",
    TTG9: "120363427914569852@g.us",
    TCC3: "120363424408130632@g.us",
    TCD4: "120363407865525845@g.us",
    TTA5: "120363425009535873@g.us",
    TZC4: "120363411844052790@g.us",
    TFB7: "120363432925308998@g.us",
  },

  // storeId → station code (from HAR analysis)
  STORE_MAP: {
    "0ceba0d1-f003-43da-a231-8019e2aae710": "TTB3",
    "2a432cd6-032a-478e-9b63-bfc3965c5216": "TTG9",
    "2fa73ae0-c4c0-47cc-8609-dfe5c615e894": "TCC3",
    "16d2cf5c-1f72-4ce6-890b-18829eda7e98": "TCD4",
    "1435639d-7f28-478b-820b-619def7c267e": "TTA5",
    "46487da1-13b1-4c90-9c63-1f27572b966a": "TZC4",
    "f70fa43d-bcc3-4efd-8475-ef800adee1b1": "TFB7",
  },

  // Ordered list — extension cycles through these tabs in order
  STATIONS: ["TTB3", "TTG9", "TCC3", "TCD4", "TTA5", "TZC4", "TFB7"],

  // Alert threshold
  ACCEPTANCE_THRESHOLD_S: 15,

  // How long to wait (ms) after switching station before reading data
  SWITCH_WAIT_MS: 6000,

  // Extra wait for slow-loading stations
  SWITCH_WAIT_OVERRIDES: {
    TFB7: 8000,
    TTG9: 8000,
    TCD4: 8000,
  },

  // Don't re-alert the same station within this window (minutes)
  COOLDOWN_MINUTES: 5,

  // How often to run a full cycle of all stations (seconds)
  CYCLE_INTERVAL_S: 60,
};
