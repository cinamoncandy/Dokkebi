"use strict";
/**
 * The ONE status enum for AIPOS work orders (WO-OPS-20261030-AIPOS-STATUS-ARCHIVE-TRUTH).
 *
 * New and changed work orders use exactly these values. The ~60 historical spellings already in
 * `.aipos/work-orders/` are frozen in `.aipos/work-order-status-baseline.json`, which may only shrink.
 */

const STATUS_ENUM = Object.freeze(["READY_FOR_REVIEW", "IN_PROGRESS", "BLOCKED", "COMPLETED", "SUPERSEDED", "ABANDONED"]);

// Historical spellings that unambiguously mean "finished". Anything else (COMPLETED_FAIL, CLOSED,
// PARTIAL, ...) is not treated as closed here, so an uncertain order is never archived.
const CLOSED_SPELLINGS = Object.freeze(["COMPLETED", "completed", "COMPLETE", "MERGED", "VERIFIED"]);

// Statuses that mean "someone is working on it or it is stuck": listed individually in CURRENT_TRUTH.md.
const ACTIVE_STATUSES = Object.freeze(["IN_PROGRESS", "in_progress", "BLOCKED"]);

function isClosedSpelling(status) {
  return CLOSED_SPELLINGS.includes(status);
}

module.exports = { STATUS_ENUM, CLOSED_SPELLINGS, ACTIVE_STATUSES, isClosedSpelling };
