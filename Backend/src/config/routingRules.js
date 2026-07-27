/**
 * @fileoverview Data-driven routing rules for the document workflow engine.
 *
 * RULE PRECEDENCE STRATEGY: Highest-priority-wins
 * ─────────────────────────────────────────────────
 * All rules are evaluated against every document. Every rule that matches adds
 * its event to a results list. The engine then selects the match with the
 * HIGHEST numeric `priority` value.
 *
 * Why highest-priority-wins instead of first-match?
 * - Rule evaluation order in json-rules-engine is non-deterministic.
 * - First-match would be fragile: adding a new rule could silently change which
 *   rule wins for existing documents.
 * - Highest-priority is explicit — you declare importance directly.
 *
 * HOW TO ADD A NEW RULE:
 * 1. Add a new object to the `rules` array below.
 * 2. Set `priority` higher than existing rules if it should take precedence.
 * 3. Define `conditions` using json-rules-engine syntax (all/any nesting).
 * 4. Set `event.type` to 'route' and `event.params` with `chain` and `ruleName`.
 * 5. No code changes needed elsewhere — the routing engine picks up new rules automatically.
 *
 * CHAIN FORMAT:
 * Each entry in `chain` is a role string matching a User.role in the database.
 * The routing worker resolves each role to a real userId via approverResolver.
 *
 * @module config/routingRules
 */

const rules = [
  // ─── Rule 1: High-value invoices (amount > 10,000) ──────────────────────────
  // These require a 3-step chain: finance manager → general manager → admin
  // because large expenditures need multiple levels of oversight.
  {
    name: 'high-value-invoice',
    priority: 100,
    conditions: {
      all: [
        {
          fact: 'documentType',
          operator: 'equal',
          value: 'Invoice'
        },
        {
          fact: 'total_amount',
          operator: 'greaterThan',
          value: 10000
        }
      ]
    },
    event: {
      type: 'route',
      params: {
        ruleName: 'high-value-invoice',
        chain: ['financeManager', 'generalManager', 'admin']
      }
    }
  },

  // ─── Rule 2: Standard invoices (amount ≤ 10,000) ────────────────────────────
  // Single approval from finance manager is sufficient for smaller amounts.
  {
    name: 'standard-invoice',
    priority: 50,
    conditions: {
      all: [
        {
          fact: 'documentType',
          operator: 'equal',
          value: 'Invoice'
        },
        {
          fact: 'total_amount',
          operator: 'lessThanInclusive',
          value: 10000
        }
      ]
    },
    event: {
      type: 'route',
      params: {
        ruleName: 'standard-invoice',
        chain: ['financeManager']
      }
    }
  },

  // ─── Rule 3: Receipts ───────────────────────────────────────────────────────
  // Financial documents but lower risk — finance manager only.
  {
    name: 'receipt',
    priority: 45,
    conditions: {
      all: [
        {
          fact: 'documentType',
          operator: 'equal',
          value: 'Receipt'
        }
      ]
    },
    event: {
      type: 'route',
      params: {
        ruleName: 'receipt',
        chain: ['financeManager']
      }
    }
  },

  // ─── Rule 4: Contracts ──────────────────────────────────────────────────────
  // Legal documents need dual approval: HR manager reviews terms, then admin
  // provides final sign-off.
  {
    name: 'contract',
    priority: 80,
    conditions: {
      all: [
        {
          fact: 'documentType',
          operator: 'equal',
          value: 'Contract'
        }
      ]
    },
    event: {
      type: 'route',
      params: {
        ruleName: 'contract',
        chain: ['hrManager', 'admin']
      }
    }
  },

  // ─── Rule 5: HR documents (Resumes, Forms in HR department) ─────────────────
  {
    name: 'hr-document',
    priority: 60,
    conditions: {
      any: [
        {
          fact: 'documentType',
          operator: 'equal',
          value: 'Resume'
        },
        {
          all: [
            {
              fact: 'department',
              operator: 'equal',
              value: 'HR'
            },
            {
              fact: 'documentType',
              operator: 'in',
              value: ['Form', 'Letter', 'Memo']
            }
          ]
        }
      ]
    },
    event: {
      type: 'route',
      params: {
        ruleName: 'hr-document',
        chain: ['hrManager']
      }
    }
  },

  // ─── Rule 6: Audit documents ────────────────────────────────────────────────
  // Audit reports need the audit manager, then admin for compliance sign-off.
  {
    name: 'audit-document',
    priority: 70,
    conditions: {
      all: [
        {
          fact: 'department',
          operator: 'equal',
          value: 'Audit'
        }
      ]
    },
    event: {
      type: 'route',
      params: {
        ruleName: 'audit-document',
        chain: ['auditManager', 'admin']
      }
    }
  },

  // ─── Rule 7: Policy documents ──────────────────────────────────────────────
  // Company policies need general manager + admin sign-off.
  {
    name: 'policy-document',
    priority: 75,
    conditions: {
      all: [
        {
          fact: 'documentType',
          operator: 'equal',
          value: 'Policy'
        }
      ]
    },
    event: {
      type: 'route',
      params: {
        ruleName: 'policy-document',
        chain: ['generalManager', 'admin']
      }
    }
  },

  // ─── Rule 8: Proposals ─────────────────────────────────────────────────────
  // Business proposals go through general manager.
  {
    name: 'proposal',
    priority: 55,
    conditions: {
      all: [
        {
          fact: 'documentType',
          operator: 'equal',
          value: 'Proposal'
        }
      ]
    },
    event: {
      type: 'route',
      params: {
        ruleName: 'proposal',
        chain: ['generalManager']
      }
    }
  },

  // ─── DEFAULT RULE: Catch-all fallback ───────────────────────────────────────
  // This rule ALWAYS matches (condition is always true). Its low priority (1)
  // ensures it only wins when no specific rule fires.
  // A document must NEVER be left unrouted — this guarantees it.
  {
    name: 'default-fallback',
    priority: 1,
    conditions: {
      all: [
        {
          // Always-true condition: every document has a type (even if empty string)
          fact: 'documentType',
          operator: 'notEqual',
          value: '___IMPOSSIBLE_SENTINEL___'
        }
      ]
    },
    event: {
      type: 'route',
      params: {
        ruleName: 'default-fallback',
        chain: ['admin']
      }
    }
  }
];

module.exports = { rules };
