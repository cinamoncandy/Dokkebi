const fs = require("node:fs");

/** Prevent a per-dispatch capability from being copied into uploaded artifacts. */
function sanitizeAutopilotDispatch(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)
    || !event.client_payload || typeof event.client_payload !== "object" || Array.isArray(event.client_payload)) {
    throw new Error("AUTOPILOT_DISPATCH_EVENT_INVALID");
  }
  const payload = { ...event.client_payload };
  delete payload.causal_dispatch_capability;
  return { ...event, client_payload: payload };
}

if (require.main === module) {
  try {
    const [source, target] = process.argv.slice(2);
    if (!source || !target) throw new Error("AUTOPILOT_DISPATCH_PATH_REQUIRED");
    const event = JSON.parse(fs.readFileSync(source, "utf8"));
    fs.writeFileSync(target, `${JSON.stringify(sanitizeAutopilotDispatch(event), null, 2)}\n`, { mode: 0o600 });
  } catch {
    console.error("AUTOPILOT_DISPATCH_SANITIZATION_FAILED");
    process.exitCode = 1;
  }
}

module.exports = { sanitizeAutopilotDispatch };
