"use strict";

// Compatibility tombstone for the retired process-local Check Run harness entry point.
// The current consumer obtains a dedicated OIDC token and calls the isolated Worker route.
console.error("ISOLATED_VERIFICATION_ENTRYPOINT_RETIRED_USE_OIDC_WORKER_CONSUMER");
process.exitCode = 1;
