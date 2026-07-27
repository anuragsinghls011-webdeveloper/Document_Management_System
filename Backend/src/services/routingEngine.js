/**
 * @fileoverview Rules engine wrapper for document routing decisions.
 *
 * This module is the brain of the routing system. It evaluates a document
 * against the data-driven rules defined in `config/routingRules.js` and
 * returns the appropriate approval chain.
 *
 * DESIGN DECISIONS:
 * ─────────────────
 * 1. PURE FUNCTION: `determineRoute` is a pure function (no DB writes, no
 *    side effects). This makes it fully testable without mocking MongoDB.
 *
 * 2. MISSING-FIELD SAFETY: Before evaluation, all expected facts are
 *    defaulted to safe values. A document missing `total_amount` because
 *    extraction failed won't crash the engine — it gets a default of 0,
 *    which routes it to the standard (lower-threshold) path.
 *
 * 3. HIGHEST-PRIORITY-WINS: The engine evaluates ALL rules, collects all
 *    matches, then selects the one with the highest priority. See
 *    `config/routingRules.js` for the rationale.
 *
 * @module services/routingEngine
 */

const { Engine } = require('json-rules-engine');
const { rules } = require('../config/routingRules');

/**
 * Safe defaults for facts the rules might reference.
 * If a field is missing/null/undefined in extractedData, the engine
 * uses these defaults instead of throwing.
 *
 * Add new defaults here when you add rules that reference new fields.
 */
const FACT_DEFAULTS = {
  documentType: 'Other',
  department: 'General',
  total_amount: 0,
  vendor_name: '',
  sender_domain: '',
  confidence: 0
};

/**
 * Build the facts object from a document, applying safe defaults for
 * any missing or null fields.
 *
 * The function reads from both top-level document fields (where the
 * existing AI pipeline writes) and from `extractedData` (where the
 * new extraction step may write). `extractedData` fields take precedence
 * if both exist, because they represent the more structured extraction.
 *
 * @param {Object} doc - The document (plain object or Mongoose doc)
 * @returns {Object} A flat facts object safe for rule evaluation
 */
function buildFacts(doc) {
  // Start with safe defaults
  const facts = { ...FACT_DEFAULTS };

  // Layer 1: top-level fields from the existing AI pipeline
  if (doc.documentType) facts.documentType = doc.documentType;
  if (doc.department) facts.department = doc.department;
  if (doc.confidence != null) facts.confidence = doc.confidence;

  // Layer 2: extractedData overrides (if the new extraction step populated it)
  if (doc.extractedData && typeof doc.extractedData === 'object') {
    for (const [key, value] of Object.entries(doc.extractedData)) {
      if (value != null && value !== '') {
        facts[key] = value;
      }
    }
  }

  // Ensure numeric fields are actually numbers (extraction might return strings)
  if (typeof facts.total_amount === 'string') {
    facts.total_amount = parseFloat(facts.total_amount) || 0;
  }
  if (typeof facts.confidence === 'string') {
    facts.confidence = parseFloat(facts.confidence) || 0;
  }

  return facts;
}

/**
 * Determine the routing path for a document.
 *
 * Evaluates the document against all configured routing rules and returns
 * the approval chain from the highest-priority matching rule.
 *
 * This function is PURE — it does not modify the document or touch the DB.
 * It is safe to call multiple times with the same input and will always
 * return the same result (deterministic/idempotent).
 *
 * @param {Object} doc - The document object (plain or Mongoose document).
 *   Expected fields: `documentType`, `department`, `extractedData`, `confidence`
 * @returns {Promise<{chain: string[], ruleName: string, priority: number}>}
 *   The routing decision: an ordered list of approver roles, the rule name
 *   that matched, and its priority.
 *
 * @example
 * const result = await determineRoute({
 *   documentType: 'Invoice',
 *   department: 'Finance',
 *   extractedData: { total_amount: 25000, vendor_name: 'Acme Corp' }
 * });
 * // result = { chain: ['financeManager', 'generalManager', 'admin'],
 * //            ruleName: 'high-value-invoice', priority: 100 }
 */
async function determineRoute(doc) {
  const engine = new Engine([], { allowUndefinedFacts: true });

  // Register all rules from config
  for (const rule of rules) {
    engine.addRule({
      name: rule.name,
      priority: rule.priority,
      conditions: rule.conditions,
      event: rule.event
    });
  }

  const facts = buildFacts(doc);

  // Run the engine — it returns all events from rules that matched
  const { events } = await engine.run(facts);

  if (!events || events.length === 0) {
    // This should never happen because the default rule always matches,
    // but defend against misconfiguration.
    console.error('[RoutingEngine] No rules matched — this indicates a misconfigured default rule');
    return {
      chain: ['admin'],
      ruleName: 'emergency-fallback',
      priority: 0
    };
  }

  // HIGHEST-PRIORITY-WINS: sort events by priority descending and take the first.
  // json-rules-engine returns events sorted by priority already, but we
  // sort explicitly to be defensive against library version changes.
  //
  // The priority is stored in event.params — but json-rules-engine also
  // attaches the rule priority to the almanac. Since we control the event
  // params, we look up the original rule's priority by matching the ruleName.
  const eventsWithPriority = events.map(event => {
    const originalRule = rules.find(r => r.name === event.params.ruleName);
    return {
      ...event.params,
      priority: originalRule ? originalRule.priority : 0
    };
  });

  eventsWithPriority.sort((a, b) => b.priority - a.priority);

  const winner = eventsWithPriority[0];

  return {
    chain: winner.chain,
    ruleName: winner.ruleName,
    priority: winner.priority
  };
}

module.exports = {
  determineRoute,
  // Exported for testing
  buildFacts,
  FACT_DEFAULTS
};
