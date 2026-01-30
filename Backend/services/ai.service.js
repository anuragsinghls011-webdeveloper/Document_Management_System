module.exports = {
  extractKeywords,
  generateSummary
};


function extractKeywords(text = "") {
  if (!text) return [];

  const stopWords = [
    "the", "is", "in", "and", "of", "to", "a", "for", "on", "with", "as", "by"
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
