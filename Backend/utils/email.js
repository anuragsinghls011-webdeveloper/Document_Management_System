const nodemailer = require("nodemailer");

// Create a transporter using ethereal for local development if no SMTP credentials are provided
const createTransporter = async () => {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT || 587,
      secure: process.env.SMTP_PORT == 465, // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  // Fallback to Ethereal Email for testing
  console.log("No SMTP credentials found in .env. Creating Ethereal test account...");
  const testAccount = await nodemailer.createTestAccount();
  console.log(`Ethereal Test Account generated: ${testAccount.user}`);

  return nodemailer.createTransport({
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
  });
};

const sendEmail = async ({ to, subject, html }) => {
  try {
    const transporter = await createTransporter();

    const info = await transporter.sendMail({
      from: '"DocuFlow System" <noreply@docuflow.test>',
      to,
      subject,
      html,
    });

    console.log(`Message sent: ${info.messageId}`);
    
    // Preview URL will only be available if using ethereal
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`\n=============================================`);
      console.log(`✉️  EMAIL PREVIEW URL: ${previewUrl}`);
      console.log(`=============================================\n`);
    }

    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("Error sending email:", error);
    return { success: false, error };
  }
};

module.exports = { sendEmail };
