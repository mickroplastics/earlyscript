// Upstream suites test upstream behavior, so they run with every Earlyscript flag on.
// earlyscriptFlags.test.ts covers the defaults. Importing the flags module here would
// freeze it before these assignments, so the names are spelled out.
for (const name of [
  "EARLYSCRIPT_FLAG_TELEMETRY",
  "EARLYSCRIPT_FLAG_THIRD_PARTY_ANALYTICS",
  "EARLYSCRIPT_FLAG_UPDATE_CHECKS",
  "EARLYSCRIPT_FLAG_RELAY",
  "EARLYSCRIPT_FLAG_T3_CONNECT",
  "EARLYSCRIPT_FLAG_MARKETING",
  "EARLYSCRIPT_FLAG_TERMINAL",
  "EARLYSCRIPT_FLAG_CHANGE_REQUESTS",
  "EARLYSCRIPT_FLAG_SOURCE_CONTROL_HOSTS",
  "EARLYSCRIPT_FLAG_REMOTE_ACCESS",
]) {
  process.env[name] ??= "1";
}
