const Tesseract = require("tesseract.js");
const path = require("path");

module.exports = async function extractText(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();

    
    if (ext === ".pdf") {
      return "";
    }

    const result = await Tesseract.recognize(
      filePath,
      "eng",
      {
        logger: m => console.log("OCR:", m.status)
      }
    );

    return result.data.text || "";

  } catch (err) {
    console.error("OCR SERVICE ERROR ", err.message);
    return ""; 
  }
};
