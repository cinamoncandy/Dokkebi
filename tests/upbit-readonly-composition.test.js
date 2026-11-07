const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const relay = fs.readFileSync(path.join(root, "services", "upbit-readonly", "server.js"), "utf8");
const mcpEnv = fs.readFileSync(path.join(root, "services", "nusa-mcp", ".env.example"), "utf8");
const relayUnit = fs.readFileSync(path.join(root, "deploy", "oracle", "nusa-upbit-readonly.service"), "utf8");
const mcpUnit = fs.readFileSync(path.join(root, "deploy", "oracle", "nusa-mcp.service"), "utf8");

test("Upbit relay uses a separate loopback port and MCP points to it", () => {
  assert.match(relay, /const DEFAULT_PORT = 3001;/);
  assert.match(relay, /server\.listen\(configuredPort, LOOPBACK_HOST/);
  assert.match(mcpEnv, /^NUSA_MCP_UPBIT_READONLY_ORIGIN=http:\/\/127\.0\.0\.1:3001$/m);
  assert.match(relayUnit, /WorkingDirectory=\/opt\/nusa\/current\/services\/upbit-readonly/);
  assert.match(relayUnit, /LogsDirectory=nusa/);
  assert.match(relayUnit, /ExecStart=\/usr\/bin\/node \/opt\/nusa\/current\/services\/upbit-readonly\/server\.js/);
  assert.match(relayUnit, /EnvironmentFile=\/etc\/nusa\/upbit-readonly\.env/);
  assert.match(mcpUnit, /Requires=nusa-upbit-readonly\.service/);
  assert.match(mcpUnit, /After=.*nusa-upbit-readonly\.service/);
});

test("production relay exposes only GET read-only routes", () => {
  assert.match(relay, /request\.method !== "GET"/);
  assert.doesNotMatch(relay, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i);
  assert.doesNotMatch(relay, /\/api\/(?:orders|withdraw|transfer|cancel|trade)/i);
});

test("relay source contains no credential literals", () => {
  assert.doesNotMatch(relay, /(?:UPBIT_ACCESS_KEY|UPBIT_SECRET_KEY|NUSA_API_TOKEN)\s*=\s*["'][^"']+["']/);
});
