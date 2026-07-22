const { GoogleGenAI } = require("@google/genai");

// ─── Department ↔ Role Mapping ───────────────────────────────────────────────
const DEPARTMENT_ROLE_MAP = {
  "Finance": "financeManager",
  "HR": "hrManager",
  "Human Resources": "hrManager",
  "Audit": "auditManager",
  "Legal": "generalManager",
  "IT": "generalManager",
  "Marketing": "generalManager",
  "Operations": "generalManager",
  "Sales": "generalManager",
  "General": "admin"
};

function getRoleForDepartment(department) {
  return DEPARTMENT_ROLE_MAP[department] || "admin";
}

// ─── Gemini AI Analysis ──────────────────────────────────────────────────────
async function analyzeDocument(text) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || !text || text.trim().length < 10) {
    console.log("AI Analysis: skipping (no API key or insufficient text)");
    return fallbackAnalysis(text);
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const prompt = `You are a document classification AI for an enterprise document management system.
Analyze the following document text and return a JSON object with exactly these fields:

1. "documentType": The type of document (exactly one of: "Invoice", "Contract", "Resume", "Report", "Memo", "Letter", "Policy", "Receipt", "Proposal", "Manual", "Spreadsheet", "Presentation", "Certificate", "Form", "Other")
2. "department": The most relevant department (exactly one of: "Finance", "HR", "Legal", "IT", "Marketing", "Operations", "Sales", "Audit", "General")
3. "summary": A concise 2-3 sentence summary of the document's main content and purpose. Be specific about names, dates, amounts if present.
4. "keywords": An array of 5-10 relevant keywords extracted from the document.
5. "confidence": A number between 0 and 1 representing your confidence in the classification.

Return ONLY valid JSON, no markdown, no code fences, no explanation.

--- DOCUMENT TEXT ---
${text.substring(0, 8000)}
--- END ---`;

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt
    });

    const responseText = response.text.trim();

    // Strip markdown code fences if present
    const cleanJson = responseText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const result = JSON.parse(cleanJson);

    // Validate and sanitize the result
    const validTypes = ["Invoice", "Contract", "Resume", "Report", "Memo", "Letter", "Policy", "Receipt", "Proposal", "Manual", "Spreadsheet", "Presentation", "Certificate", "Form", "Other"];
    const validDepts = ["Finance", "HR", "Legal", "IT", "Marketing", "Operations", "Sales", "Audit", "General"];

    return {
      documentType: validTypes.includes(result.documentType) ? result.documentType : "Other",
      department: validDepts.includes(result.department) ? result.department : "General",
      summary: typeof result.summary === "string" ? result.summary.substring(0, 1000) : "",
      keywords: Array.isArray(result.keywords) ? result.keywords.slice(0, 10).map(String) : [],
      confidence: typeof result.confidence === "number" ? Math.min(1, Math.max(0, result.confidence)) : 0.5
    };

  } catch (err) {
    console.error("AI Analysis Error:", err.message);
    return fallbackAnalysis(text);
  }
}

// ─── Fallback (keyword-based) ────────────────────────────────────────────────
function fallbackAnalysis(text) {
  const keywords = extractKeywords(text);
  const summary = generateSummary(text);

  // Simple keyword-based department detection
  const lowerText = (text || "").toLowerCase();

  let department = "General";
  let documentType = "Other";

  if (/invoice|payment|tax|budget|expense|revenue|billing|receipt|financial/.test(lowerText)) {
    department = "Finance";
    documentType = lowerText.includes("invoice") ? "Invoice" : "Receipt";
  } else if (/resume|cv|hiring|employee|salary|leave|attendance|onboard|recruit/.test(lowerText)) {
    department = "HR";
    documentType = lowerText.includes("resume") || lowerText.includes("cv") ? "Resume" : "Form";
  } else if (/contract|agreement|legal|clause|terms|compliance|liability|nda/.test(lowerText)) {
    department = "Legal";
    documentType = "Contract";
  } else if (/audit|compliance|inspection|review|assessment/.test(lowerText)) {
    department = "Audit";
    documentType = "Report";
  } else if (/marketing|campaign|brand|adverti|social media|seo|content/.test(lowerText)) {
    department = "Marketing";
    documentType = "Report";
  } else if (/server|software|database|api|deploy|code|network|security/.test(lowerText)) {
    department = "IT";
    documentType = "Manual";
  }

  return {
    documentType,
    department,
    summary: summary || "No summary available.",
    keywords,
    confidence: 0.3
  };
}

// ─── Legacy functions (kept for backward compatibility) ──────────────────────
function extractKeywords(text = "") {
  if (!text) return [];

  const stopWords = [
    "the", "is", "in", "and", "of", "to", "a", "for", "on", "with", "as", "by",
    "this", "that", "are", "was", "were", "been", "being", "have", "has", "had",
    "will", "would", "could", "should", "may", "might", "can", "shall", "not",
    "but", "from", "they", "them", "their", "what", "which", "who", "whom",
    "its", "you", "your", "our", "his", "her", "all", "each", "every", "both",
    "few", "more", "most", "other", "some", "such", "than", "too", "very"
  ];

  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .split(" ")
    .filter(w => w.length > 3 && !stopWords.includes(w));

  return [...new Set(words)].slice(0, 10);
}

function generateSummary(text = "") {
  if (!text) return "";
  return text.split(".").slice(0, 3).join(".") + "...";
}

module.exports = {
  analyzeDocument,
  extractKeywords,
  generateSummary,
  getRoleForDepartment,
  DEPARTMENT_ROLE_MAP
};
