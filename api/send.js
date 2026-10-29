require('dotenv').config();
const { Telegraf } = require('telegraf');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const DEFAULT_CHAT_ID = (process.env.TARGET_CHAT_ID || '').trim();
const DEFAULT_TOPIC_ID = (process.env.TARGET_TOPIC_ID || '').trim();

const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

function escapeHTML(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatSectionMessage({ headline, productName, productCode, sectionText, emoji }) {
  const safeHeadline = escapeHTML(headline.trim().toUpperCase());
  const safeProductName = escapeHTML(productName.trim());
  const safeProductCode = escapeHTML(productCode.trim());
  const safeSection = escapeHTML(sectionText.trim());
  const cleanEmoji = escapeHTML((emoji || '📌').trim());

  return [
    `<b>${cleanEmoji} ${safeHeadline} ${cleanEmoji}</b>`,
    ``,
    `📦 <b>Product Name:</b> <code>${safeProductName}</code>`,
    `🔖 <b>Product Code:</b> <code>${safeProductCode}</code>`,
    ``,
    `<pre>${safeSection}</pre>`,
  ].join('\n');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const {
      action,
      password,
      headline,
      productName,
      productCode,
      bodyText,
      delimiter = process.env.SECTION_DELIMITER || '---',
      emoji = process.env.HEADLINE_EMOJI || '📌',
      customChatId,
      customTopicId,
    } = req.body || {};

    // ১. Vercel-এ ADMIN_PASSWORD সেট করা আছে কি না চেক করা
    if (!ADMIN_PASSWORD) {
      return res.status(500).json({
        ok: false,
        error: 'Vercel-এ ADMIN_PASSWORD খুঁজে পাওয়া যায়নি! Environment Variables-এ ADMIN_PASSWORD যোগ করে প্রজেক্টটি Redeploy করুন।',
      });
    }

    const incomingPassword = String(password || '').trim();

    // ২. পাসওয়ার্ড যাচাই (স্পেস বাদ দিয়ে)
    if (incomingPassword !== ADMIN_PASSWORD) {
      return res.status(401).json({
        ok: false,
        error: 'পাসওয়ার্ড ভুল হয়েছে! আপনার Vercel-এর ADMIN_PASSWORD-এর সাথে মিলছে না।',
      });
    }

    // ৩. যদি শুধু লগইন চেক করার রিকোয়েস্ট হয়, তবে এখানেই সাকসেস রিটার্ন করবে
    if (action === 'verify') {
      return res.status(200).json({
        ok: true,
        message: 'Login Successful!',
      });
    }

    // ৪. মেসেজ পাঠানোর মূল কাজ
    if (!bot) {
      return res.status(500).json({
        ok: false,
        error: 'Vercel-এ BOT_TOKEN সেট করা নেই!',
      });
    }

    if (!headline || !productName || !productCode || !bodyText) {
      return res.status(400).json({
        ok: false,
        error: 'সবগুলো ঘর (Headline, Product Name, Code, Body) পূরণ করা আবশ্যক।',
      });
    }

    const targetChatId = (customChatId || DEFAULT_CHAT_ID || '').trim();
    const targetTopicId = (customTopicId || DEFAULT_TOPIC_ID || '').trim();

    if (!targetChatId) {
      return res.status(400).json({
        ok: false,
        error: 'Target Chat ID পাওয়া যায়নি। Vercel-এ TARGET_CHAT_ID দিন অথবা ওয়েবসাইটের Advanced অপশনে লিখুন।',
      });
    }

    const sections = bodyText
      .replace(/\r\n/g, '\n')
      .split(delimiter)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (sections.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Body-তে কোনো টেক্সট পাওয়া যায়নি।',
      });
    }

    let sentCount = 0;
    for (const sectionText of sections) {
      const htmlMessage = formatSectionMessage({
        headline,
        productName,
        productCode,
        sectionText,
        emoji,
      });

      const sendOptions = {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };

      if (targetTopicId && !isNaN(Number(targetTopicId))) {
        sendOptions.message_thread_id = Number(targetTopicId);
      }

      await bot.telegram.sendMessage(targetChatId, htmlMessage, sendOptions);
      sentCount++;

      if (sentCount < sections.length) {
        await sleep(350);
      }
    }

    return res.status(200).json({
      ok: true,
      sentCount,
      message: `সফলভাবে ${sentCount}টি মেসেজ টেলিগ্রাম টপিকে পাঠানো হয়েছে!`,
    });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      ok: false,
      error: error.response?.description || error.message || 'টেলিগ্রামে মেসেজ পাঠাতে সমস্যা হয়েছে।',
    });
  }
};
