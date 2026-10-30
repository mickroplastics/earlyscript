// Upstream suites test upstream behavior, so they run with every Earlyscript flag on.
// earlyscriptFlags.test.ts covers the defaults. Importing the flags module here would
// freeze it before these assignments, so the names are spelled out.
for (const name of [
  "EARLYSCRIPT_FLAG_TELEMETRY",
  "EARLYSCRIPT_FLAG_THIRD_PARTY_ANALYTICS",
  "EARLYSCRIPT_FLAG_UPDATE_CHECKS",
  "EARLYSCRIPT_FLAG_RELAY",
  "EARLYSCRIPT_FLAG_T3_CONNECT",
  "EARLYSCRIPT_FLAG_MOBILE_PAIRING",
  "EARLYSCRIPT_FLAG_MARKETING",
]) {
  process.env[name] ??= "1";
}
