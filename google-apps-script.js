/**
 * Google Apps Script - Deploy as Web App
 *
 * SETUP:
 * 1. Open your Apps Script project at script.google.com
 * 2. Replace ALL code in Code.gs with this entire file
 * 3. Click Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy
 * 4. When prompted, authorize email permissions (Review Permissions > Allow)
 */

var SHEET_NAME = 'Sheet1';
var FROM_NAME  = 'Invisible AI';
var SUBJECT    = 'Welcome to Invisible AI - You are on the List!';

function doPost(e) {
  try {
    if (!e || !e.parameter) {
      Logger.log('No event data received. If testing manually, use the website form instead.');
      return ContentService
        .createTextOutput(JSON.stringify({ result: 'error', message: 'No form data received' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // The website sends URL-encoded form data, so use e.parameter
    var email = (e.parameter.email || '').trim();
    var timestamp = e.parameter.timestamp || new Date().toISOString();

    Logger.log('Received email: ' + email);
    Logger.log('Timestamp: ' + timestamp);

    if (!email || email.indexOf('@') === -1) {
      Logger.log('Invalid email, aborting.');
      return ContentService
        .createTextOutput(JSON.stringify({ result: 'error', message: 'Invalid email' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 1) Save to Google Sheet
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    sheet.appendRow([email, timestamp]);
    Logger.log('Saved to sheet.');

    // 2) Send confirmation email
    sendConfirmationEmail(email);
    Logger.log('Email sent to ' + email);

    return ContentService
      .createTextOutput(JSON.stringify({ result: 'success' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('doPost error: ' + err.toString());
    return ContentService
      .createTextOutput(JSON.stringify({ result: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function sendConfirmationEmail(recipientEmail) {
  var htmlBody = '<div style="font-family: Segoe UI, Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0A0C12; color: #E0E0E6; padding: 40px; border-radius: 12px;">'
    + '<div style="text-align: center; margin-bottom: 32px;">'
    + '<span style="color: #00F2FF; font-size: 28px;">&#9670;</span> '
    + '<span style="font-size: 20px; font-weight: 700; letter-spacing: 0.08em; color: #E0E0E6;">'
    + 'INVISIBLE<span style="color: #00F2FF;">AI</span></span>'
    + '</div>'
    + '<h1 style="color: #00F2FF; font-size: 24px; text-align: center; margin-bottom: 16px;">'
    + 'You are on the Early Access List</h1>'
    + '<p style="font-size: 16px; line-height: 1.6; color: #E0E0E6; text-align: center; margin-bottom: 24px;">'
    + 'Thanks for signing up! You will be among the first to get access when we launch.</p>'
    + '<div style="background: #0d1a1f; border: 1px solid #1a3a3f; border-radius: 8px; padding: 20px; margin-bottom: 24px;">'
    + '<p style="font-size: 14px; color: #8A8A9A; margin: 0 0 8px 0;">What to expect:</p>'
    + '<ul style="color: #E0E0E6; font-size: 14px; line-height: 1.8; padding-left: 20px; margin: 0;">'
    + '<li>Priority access before public launch</li>'
    + '<li>Launch date announcement</li>'
    + '<li>Exclusive early-bird pricing</li>'
    + '</ul></div>'
    + '<p style="font-size: 13px; color: #555568; text-align: center; margin-top: 32px;">'
    + '&copy; 2026 Invisible AI. All rights reserved.<br>Built for those who operate in the margins.</p>'
    + '</div>';

  MailApp.sendEmail({
    to: recipientEmail,
    subject: SUBJECT,
    htmlBody: htmlBody,
    name: FROM_NAME
  });
}

function doGet(e) {
  return ContentService
    .createTextOutput('Invisible AI endpoint is live.')
    .setMimeType(ContentService.MimeType.TEXT);
}
