/**
 * @fileoverview Pluggable approver resolution service.
 *
 * Converts an abstract role name (e.g. 'financeManager') into a concrete
 * userId by looking up the User collection.
 *
 * STRATEGY PATTERN:
 * The default implementation uses a simple "first user with matching role"
 * lookup. To swap in a smarter strategy (round-robin, least-busy, workload-
 * balanced), call `setStrategy(fn)` with a function that has the same
 * signature: `async (role) => userId`.
 *
 * Example — round-robin strategy:
 * ```js
 * const { setStrategy } = require('./approverResolver');
 * const roundRobinCounter = {};
 *
 * setStrategy(async (role) => {
 *   const users = await User.find({ role }).lean();
 *   if (!users.length) return null;
 *   roundRobinCounter[role] = ((roundRobinCounter[role] || 0) + 1) % users.length;
 *   return users[roundRobinCounter[role]]._id.toString();
 * });
 * ```
 *
 * @module services/approverResolver
 */

const User = require('../../models/user.model');

/**
 * Current resolver strategy. Replaced via `setStrategy()`.
 * @type {(role: string) => Promise<string|null>}
 */
let currentStrategy = defaultFixedMappingStrategy;

/**
 * Default fixed-mapping strategy.
 * Finds the first user in MongoDB whose `role` field matches the requested role.
 * Falls back to the first admin user if no match is found.
 *
 * @param {string} role - The role to resolve (e.g. 'financeManager', 'admin')
 * @returns {Promise<string|null>} The userId string, or null if no user exists at all
 */
async function defaultFixedMappingStrategy(role) {
  // Try exact role match first
  const user = await User.findOne({ role }).select('_id').lean();
  if (user) {
    return user._id.toString();
  }

  // Fallback: if no user with the requested role exists, fall back to admin.
  // This prevents a broken chain if a role hasn't been assigned to any user yet.
  console.warn(`[ApproverResolver] No user found with role "${role}", falling back to admin`);
  const adminUser = await User.findOne({ role: 'admin' }).select('_id').lean();
  if (adminUser) {
    return adminUser._id.toString();
  }

  // No users at all — this is a misconfiguration
  console.error('[ApproverResolver] CRITICAL: No admin user found in the system');
  return null;
}

/**
 * Resolve an abstract role to a concrete userId.
 *
 * @param {string} role - The role to resolve (must match a User.role value)
 * @returns {Promise<string|null>} The userId of the resolved approver
 * @throws {Error} If the strategy function itself throws
 */
async function resolveApprover(role) {
  if (!role || typeof role !== 'string') {
    console.error('[ApproverResolver] Invalid role provided:', role);
    return null;
  }

  return currentStrategy(role);
}

/**
 * Replace the current resolver strategy at runtime.
 * The new strategy must be an async function with signature:
 *   async (role: string) => string | null
 *
 * @param {(role: string) => Promise<string|null>} strategyFn - The new strategy
 * @throws {Error} If strategyFn is not a function
 */
function setStrategy(strategyFn) {
  if (typeof strategyFn !== 'function') {
    throw new Error('setStrategy requires a function argument');
  }
  console.log('[ApproverResolver] Strategy updated');
  currentStrategy = strategyFn;
}

/**
 * Reset to the default fixed-mapping strategy.
 * Useful for testing.
 */
function resetStrategy() {
  currentStrategy = defaultFixedMappingStrategy;
}

module.exports = {
  resolveApprover,
  setStrategy,
  resetStrategy,
  // Exported for testing only — not part of the public API
  _defaultStrategy: defaultFixedMappingStrategy
};
