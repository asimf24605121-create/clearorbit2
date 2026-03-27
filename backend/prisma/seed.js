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
    [1, '1_week', 1.79, 2.99], [1, '1_month', 4.79, 7.99], [1, '6_months', 20.99, 34.99], [1, '1_year', 35.99, 59.99],
    [2, '1_week', 1.19, 1.99], [2, '1_month', 2.99, 4.99], [2, '6_months', 14.99, 24.99], [2, '1_year', 26.99, 44.99],
    [3, '1_week', 1.49, 2.49], [3, '1_month', 4.19, 6.99], [3, '6_months', 17.99, 29.99], [3, '1_year', 29.99, 49.99],
    [4, '1_week', 2.39, 3.99], [4, '1_month', 5.99, 9.99], [4, '6_months', 26.99, 44.99], [4, '1_year', 47.99, 79.99],
    [5, '1_week', 1.19, 1.99], [5, '1_month', 3.59, 5.99], [5, '6_months', 17.99, 29.99], [5, '1_year', 29.99, 49.99],
    [6, '1_week', 1.49, 2.49], [6, '1_month', 3.99, 6.99], [6, '6_months', 18.99, 31.99], [6, '1_year', 32.99, 54.99],
    [7, '1_week', 1.49, 2.49], [7, '1_month', 3.99, 6.99], [7, '6_months', 18.99, 31.99], [7, '1_year', 32.99, 54.99],
    [8, '1_week', 1.19, 1.99], [8, '1_month', 2.99, 4.99], [8, '6_months', 14.99, 24.99], [8, '1_year', 26.99, 44.99],
    [9, '1_week', 1.79, 2.99], [9, '1_month', 4.79, 7.99], [9, '6_months', 22.99, 37.99], [9, '1_year', 39.99, 66.99],
  ];

  for (const [platformId, durationKey, sharedPrice, privatePrice] of defaultPricing) {
    await prisma.pricingPlan.create({
      data: { platformId, durationKey, sharedPrice, privatePrice },
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
