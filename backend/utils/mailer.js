import nodemailer from 'nodemailer';
import { logger } from './logger.js';

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  _transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

  return _transporter;
}

export async function sendContactReplyEmail(toEmail, toName, replyText, originalMessage) {
  const transporter = getTransporter();
  if (!transporter) {
    logger.error('mailer', { action: 'send_contact_reply', error: 'SMTP not configured' });
    return { success: false, reason: 'smtp_not_configured' };
  }

  const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER;

  const htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#6366f1;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:20px">ClearOrbit Support</h2>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:none">
        <p style="color:#334155;margin:0 0 8px">Hi ${toName || 'there'},</p>
        <p style="color:#334155;margin:0 0 16px">Thank you for reaching out. Here is our reply to your message:</p>
        <div style="background:#f1f5f9;border-left:4px solid #6366f1;padding:12px 16px;margin:0 0 16px;border-radius:0 4px 4px 0">
          <p style="color:#1e293b;margin:0;white-space:pre-wrap">${replyText}</p>
        </div>
        <p style="color:#94a3b8;font-size:13px;margin:16px 0 0;border-top:1px solid #e2e8f0;padding-top:12px">
          <strong>Your original message:</strong><br>
          <span style="color:#64748b">${(originalMessage || '').substring(0, 300)}</span>
        </p>
      </div>
      <div style="padding:12px 24px;text-align:center;color:#94a3b8;font-size:12px">
        &copy; ClearOrbit &mdash; This is an automated reply. Please do not reply to this email.
      </div>
    </div>`;

  try {
    await transporter.sendMail({
      from: fromAddress,
      to: toEmail,
      subject: 'Re: Your message to ClearOrbit Support',
      html: htmlBody,
    });
    logger.admin({ action: 'contact_reply_email_sent', to: toEmail });
    return { success: true };
  } catch (err) {
    logger.error('mailer', { action: 'send_contact_reply', error: err.message, to: toEmail });
    return { success: false, reason: 'send_failed', error: err.message };
  }
}

export function isSmtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}
