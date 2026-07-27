/**
 * @fileoverview Unit tests for the routing engine (determineRoute + buildFacts).
 *
 * Tests the PURE logic of rule evaluation without MongoDB or Redis.
 * Covers: rule precedence, missing-field fallback, multiple-match resolution,
 * default-rule catch-all, and fact-building edge cases.
 */

const { determineRoute, buildFacts, FACT_DEFAULTS } = require('../services/routingEngine');

describe('buildFacts', () => {
  test('applies defaults for completely empty document', () => {
    const facts = buildFacts({});
    expect(facts.documentType).toBe('Other');
    expect(facts.department).toBe('General');
    expect(facts.total_amount).toBe(0);
    expect(facts.vendor_name).toBe('');
    expect(facts.confidence).toBe(0);
  });

  test('reads top-level fields from existing AI pipeline', () => {
    const facts = buildFacts({
      documentType: 'Invoice',
      department: 'Finance',
      confidence: 0.95
    });
    expect(facts.documentType).toBe('Invoice');
    expect(facts.department).toBe('Finance');
    expect(facts.confidence).toBe(0.95);
  });

  test('extractedData overrides top-level fields', () => {
    const facts = buildFacts({
      documentType: 'Other',
      extractedData: {
        documentType: 'Invoice',
        total_amount: 5000
      }
    });
    // extractedData should win
    expect(facts.documentType).toBe('Invoice');
    expect(facts.total_amount).toBe(5000);
  });

  test('ignores null/empty values in extractedData', () => {
    const facts = buildFacts({
      documentType: 'Invoice',
      extractedData: {
        total_amount: null,
        vendor_name: ''
      }
    });
    // Should keep defaults for null/empty
    expect(facts.total_amount).toBe(0);
    expect(facts.vendor_name).toBe('');
  });

  test('coerces string total_amount to number', () => {
    const facts = buildFacts({
      extractedData: { total_amount: '15000.50' }
    });
    expect(facts.total_amount).toBe(15000.50);
  });

  test('coerces invalid string total_amount to 0', () => {
    const facts = buildFacts({
      extractedData: { total_amount: 'not-a-number' }
    });
    expect(facts.total_amount).toBe(0);
  });
});

describe('determineRoute', () => {
  test('high-value invoice (>10000) matches high-value-invoice rule', async () => {
    const result = await determineRoute({
      documentType: 'Invoice',
      extractedData: { total_amount: 25000 }
    });
    expect(result.ruleName).toBe('high-value-invoice');
    expect(result.priority).toBe(100);
    expect(result.chain).toEqual(['financeManager', 'generalManager', 'admin']);
  });

  test('standard invoice (≤10000) matches standard-invoice rule', async () => {
    const result = await determineRoute({
      documentType: 'Invoice',
      extractedData: { total_amount: 5000 }
    });
    expect(result.ruleName).toBe('standard-invoice');
    expect(result.priority).toBe(50);
    expect(result.chain).toEqual(['financeManager']);
  });

  test('invoice with exactly 10000 matches standard-invoice (lessThanInclusive)', async () => {
    const result = await determineRoute({
      documentType: 'Invoice',
      extractedData: { total_amount: 10000 }
    });
    expect(result.ruleName).toBe('standard-invoice');
    expect(result.chain).toEqual(['financeManager']);
  });

  test('contract matches contract rule with dual approval chain', async () => {
    const result = await determineRoute({
      documentType: 'Contract',
      department: 'Legal'
    });
    expect(result.ruleName).toBe('contract');
    expect(result.chain).toEqual(['hrManager', 'admin']);
  });

  test('resume matches hr-document rule', async () => {
    const result = await determineRoute({
      documentType: 'Resume',
      department: 'HR'
    });
    expect(result.ruleName).toBe('hr-document');
    expect(result.chain).toEqual(['hrManager']);
  });

  test('audit department document matches audit-document rule', async () => {
    const result = await determineRoute({
      documentType: 'Report',
      department: 'Audit'
    });
    expect(result.ruleName).toBe('audit-document');
    expect(result.chain).toEqual(['auditManager', 'admin']);
  });

  test('policy document matches policy-document rule', async () => {
    const result = await determineRoute({
      documentType: 'Policy',
      department: 'General'
    });
    expect(result.ruleName).toBe('policy-document');
    expect(result.chain).toEqual(['generalManager', 'admin']);
  });

  // ── PRECEDENCE TESTS ──────────────────────────────────────────────────────

  test('highest-priority rule wins when multiple rules match', async () => {
    // An invoice in the Audit department could match both audit-document (70)
    // and standard-invoice (50). High-value invoice (100) should win if amount > 10000.
    const result = await determineRoute({
      documentType: 'Invoice',
      department: 'Audit',
      extractedData: { total_amount: 50000 }
    });
    // high-value-invoice has priority 100, audit-document has 70
    expect(result.ruleName).toBe('high-value-invoice');
    expect(result.priority).toBe(100);
  });

  // ── DEFAULT/FALLBACK TESTS ────────────────────────────────────────────────

  test('unknown document type falls through to default-fallback', async () => {
    const result = await determineRoute({
      documentType: 'Spreadsheet', // No specific rule for Spreadsheet
      department: 'Marketing'       // No specific rule for Marketing dept
    });
    expect(result.ruleName).toBe('default-fallback');
    expect(result.priority).toBe(1);
    expect(result.chain).toEqual(['admin']);
  });

  test('completely empty document falls to default-fallback', async () => {
    const result = await determineRoute({});
    expect(result.ruleName).toBe('default-fallback');
    expect(result.chain).toEqual(['admin']);
  });

  // ── MISSING-FIELD EDGE CASES ──────────────────────────────────────────────

  test('invoice with missing total_amount gets default 0 (standard-invoice)', async () => {
    // With no total_amount, default is 0 which is ≤ 10000
    const result = await determineRoute({
      documentType: 'Invoice'
      // no extractedData.total_amount
    });
    expect(result.ruleName).toBe('standard-invoice');
    expect(result.chain).toEqual(['financeManager']);
  });

  test('document with null extractedData does not crash', async () => {
    const result = await determineRoute({
      documentType: 'Contract',
      extractedData: null
    });
    expect(result.ruleName).toBe('contract');
    expect(result.chain).toEqual(['hrManager', 'admin']);
  });

  // ── DETERMINISM/IDEMPOTENCY ───────────────────────────────────────────────

  test('same input always produces same output (deterministic)', async () => {
    const doc = {
      documentType: 'Invoice',
      extractedData: { total_amount: 15000 }
    };

    const result1 = await determineRoute(doc);
    const result2 = await determineRoute(doc);
    const result3 = await determineRoute(doc);

    expect(result1).toEqual(result2);
    expect(result2).toEqual(result3);
  });
});
