const Tesseract = require("tesseract.js");
const path = require("path");
const fs = require("fs");
const pdfParse = require("pdf-parse");

function isTextLikeFile(ext) {
  return [".txt", ".md", ".html", ".htm", ".csv", ".json", ".xml", ".log"].includes(ext);
}

function normalizePlainText(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = async function extractText(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === ".pdf") {
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(dataBuffer);
      return pdfData.text || "";
    }

    if (isTextLikeFile(ext)) {
      const text = await fs.promises.readFile(filePath, "utf8");
      return normalizePlainText(text);
    }

    const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff"];
    if (imageExts.includes(ext)) {
      const result = await Tesseract.recognize(
        filePath,
        "eng",
        {
          logger: m => {} // Silence verbose OCR logs to avoid clutter
        }
      );
      return result.data.text || "";
    }

    // Unsupported binary format (e.g. .docx, .doc, .xlsx)
    return `[Binary file content cannot be fully extracted for OCR. File type: ${ext}]`;

  } catch (err) {
    console.error("OCR SERVICE ERROR ", err.message);
    return ""; 
  }
};
