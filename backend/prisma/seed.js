import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

function nowISO() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function futureDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().substring(0, 10);
}

function todayISO() {
  return new Date().toISOString().substring(0, 10);
}

async function main() {
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    console.log('Database already seeded, skipping...');
    return;
  }

  console.log('Seeding database...');

  const adminHash = await bcrypt.hash('W@$!@$!m1009388', 10);
  const userHash = await bcrypt.hash('password', 10);

  await prisma.user.create({
    data: {
      username: 'asimf24605121@gmail.com', passwordHash: adminHash,
      role: 'admin', isActive: 1, adminLevel: 'super_admin',
      name: 'Asim (Owner)', email: 'asimf24605121@gmail.com', createdAt: nowISO(),
    },
  });

  await prisma.user.create({
    data: {
      username: 'john_doe', passwordHash: userHash, role: 'user', isActive: 1,
      name: 'John Doe', email: 'john@example.com', phone: '+1234567890', createdAt: nowISO(),
    },
  });

  const testUserHash = await bcrypt.hash('password', 10);
  for (let i = 1; i <= 15; i++) {
    const num = String(i).padStart(2, '0');
    await prisma.user.create({
      data: {
        username: `testuser${num}`, passwordHash: testUserHash, role: 'user', isActive: 1,
        name: `Test User ${num}`, email: `testuser${num}@example.com`, createdAt: nowISO(),
      },
    });
  }

  const platformData = [
    { name: 'Netflix', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/0/08/Netflix_2015_logo.svg', bgColorHex: '#e50914', cookieDomain: '.netflix.com', loginUrl: 'https://www.netflix.com/' },
    { name: 'Spotify', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/2/26/Spotify_logo_with_text.svg', bgColorHex: '#1db954', cookieDomain: '.spotify.com', loginUrl: 'https://open.spotify.com/' },
    { name: 'Disney+', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/3/3e/Disney%2B_logo.svg', bgColorHex: '#0063e5', cookieDomain: '.disneyplus.com', loginUrl: 'https://www.disneyplus.com/' },
    { name: 'ChatGPT', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/0/04/ChatGPT_logo.svg', bgColorHex: '#10a37f', cookieDomain: '.openai.com', loginUrl: 'https://chat.openai.com/' },
    { name: 'Canva', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/0/08/Canva_icon_2021.svg', bgColorHex: '#7d2ae8', cookieDomain: '.canva.com', loginUrl: 'https://www.canva.com/' },
    { name: 'Udemy', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/e/e3/Udemy_logo.svg', bgColorHex: '#a435f0', cookieDomain: '.udemy.com', loginUrl: 'https://www.udemy.com/' },
    { name: 'Coursera', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/9/97/Coursera-Logo_600x600.svg', bgColorHex: '#0056d2', cookieDomain: '.coursera.org', loginUrl: 'https://www.coursera.org/' },
    { name: 'Skillshare', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/2/2e/Skillshare_logo.svg', bgColorHex: '#00ff84', cookieDomain: '.skillshare.com', loginUrl: 'https://www.skillshare.com/' },
    { name: 'Grammarly', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/a0/Grammarly_Logo.svg', bgColorHex: '#15c39a', cookieDomain: '.grammarly.com', loginUrl: 'https://app.grammarly.com/' },
  ];

  for (const p of platformData) {
    await prisma.platform.create({ data: { ...p, isActive: 1 } });
  }

  const cookieData = [
    { platformId: 1, data: 'NetflixId=sample_cookie_value_here; nfvdid=sample_device_id;' },
    { platformId: 2, data: 'sp_dc=sample_spotify_cookie_here; sp_key=sample_key;' },
    { platformId: 3, data: 'disney_token=sample_disney_cookie; dss_id=sample_dss;' },
    { platformId: 4, data: 'chatgpt_session=sample_chatgpt_cookie; cf_clearance=sample;' },
    { platformId: 5, data: 'canva_session=sample_canva_cookie; csrf=sample_token;' },
  ];

  for (const c of cookieData) {
    await prisma.cookieVault.create({
      data: {
        platformId: c.platformId,
        cookieString: Buffer.from(c.data).toString('base64'),
        expiresAt: futureDate(30) + ' 00:00:00',
        updatedAt: nowISO(),
        cookieCount: 2,
      },
    });
  }

  for (let pid = 1; pid <= 5; pid++) {
    await prisma.userSubscription.create({
      data: {
        userId: 2, platformId: pid,
        startDate: todayISO(), endDate: futureDate(30), isActive: 1,
      },
    });
  }

  const defaultPricing = [
    [1, 7, 'days', 1.79, 2.99, null, null],
    [1, 30, 'days', 4.79, 7.99, 9.99, 'Popular'],
    [1, 180, 'days', 20.99, 34.99, 39.99, null],
    [1, 365, 'days', 35.99, 59.99, 69.99, 'Best Value'],
    [2, 7, 'days', 1.19, 1.99, null, null],
    [2, 30, 'days', 2.99, 4.99, null, 'Popular'],
    [2, 180, 'days', 14.99, 24.99, 29.99, null],
    [2, 365, 'days', 26.99, 44.99, 54.99, 'Best Value'],
    [3, 7, 'days', 1.49, 2.49, null, null],
    [3, 30, 'days', 4.19, 6.99, null, null],
    [3, 180, 'days', 17.99, 29.99, 34.99, 'Popular'],
    [3, 365, 'days', 29.99, 49.99, 59.99, 'Best Value'],
    [4, 30, 'minutes', 0.99, 1.49, null, null],
    [4, 2, 'hours', 2.39, 3.99, null, null],
    [4, 7, 'days', 5.99, 9.99, null, 'Popular'],
    [4, 30, 'days', 15.99, 26.99, 29.99, null],
    [4, 365, 'days', 47.99, 79.99, 99.99, 'Best Value'],
    [5, 7, 'days', 1.19, 1.99, null, null],
    [5, 30, 'days', 3.59, 5.99, null, 'Popular'],
    [5, 180, 'days', 17.99, 29.99, 34.99, null],
    [5, 365, 'days', 29.99, 49.99, 59.99, 'Best Value'],
    [6, 2, 'hours', 0.79, 1.29, null, null],
    [6, 7, 'days', 1.49, 2.49, null, null],
    [6, 30, 'days', 3.99, 6.99, null, 'Popular'],
    [6, 180, 'days', 18.99, 31.99, 37.99, null],
    [6, 365, 'days', 32.99, 54.99, 64.99, 'Best Value'],
    [7, 7, 'days', 1.49, 2.49, null, null],
    [7, 30, 'days', 3.99, 6.99, null, 'Popular'],
    [7, 180, 'days', 18.99, 31.99, 37.99, null],
    [7, 365, 'days', 32.99, 54.99, 64.99, 'Best Value'],
    [8, 7, 'days', 1.19, 1.99, null, null],
    [8, 30, 'days', 2.99, 4.99, null, 'Popular'],
    [8, 180, 'days', 14.99, 24.99, null, null],
    [8, 365, 'days', 26.99, 44.99, 54.99, 'Best Value'],
    [9, 30, 'minutes', 0.69, 1.19, null, 'Limited Offer'],
    [9, 7, 'days', 1.79, 2.99, null, null],
    [9, 30, 'days', 4.79, 7.99, null, 'Popular'],
    [9, 180, 'days', 22.99, 37.99, 44.99, null],
    [9, 365, 'days', 39.99, 66.99, 79.99, 'Best Value'],
  ];

  function makeDurationKey(value, unit) {
    if (unit === 'days') {
      if (value === 7) return '1_week';
      if (value === 30) return '1_month';
      if (value === 180) return '6_months';
      if (value === 365) return '1_year';
    }
    return `${value}_${unit}`;
  }

  for (const [platformId, durationValue, durationUnit, sharedPrice, privatePrice, originalPrice, badge] of defaultPricing) {
    await prisma.pricingPlan.create({
      data: {
        platformId,
        durationKey: makeDurationKey(durationValue, durationUnit),
        durationValue,
        durationUnit,
        sharedPrice,
        privatePrice,
        originalPrice: originalPrice || null,
        badge: badge || null,
        isActive: 1,
      },
    });
  }

  for (let pid = 1; pid <= 9; pid++) {
    await prisma.whatsappConfig.create({
      data: { platformId: pid, sharedNumber: '1234567890', privateNumber: '1234567890' },
    });
  }

  const defaultSettings = [
    ['default_expiry_days', '30'],
    ['whatsapp_number', ''],
    ['whatsapp_message', 'Hi, I need help with my ClearOrbit account.'],
    ['reseller_cost_per_user', '100'],
    ['reseller_auto_approve', '0'],
  ];

  for (const [key, value] of defaultSettings) {
    await prisma.siteSetting.create({
      data: { settingKey: key, settingValue: value, updatedAt: nowISO() },
    });
  }

  console.log('Database seeded successfully!');
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
