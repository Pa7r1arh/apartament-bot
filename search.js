// search.js — РАБОТАЕТ НА RENDER.COM (puppeteer-core + /usr/bin/google-chrome)
require('dotenv').config();
const puppeteer = require('puppeteer-core');
const TelegramBot = require('node-telegram-bot-api');
const CronJob = require('cron').CronJob;
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = parseInt(process.env.CHAT_ID);

if (!BOT_TOKEN || !CHAT_ID) {
    console.error('ОШИБКА: Проверь BOT_TOKEN и CHAT_ID в переменных окружения');
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN);
const SEEN_FILE = path.join('/tmp', 'seen.txt');
let seenLinks = new Set();

if (fs.existsSync(SEEN_FILE)) {
    seenLinks = new Set(fs.readFileSync(SEEN_FILE, 'utf-8').split('\n').filter(Boolean));
}

const FILTERS = [
    { rooms: 1, price: 7000000, name: 'ОДНУШКА' },
    { rooms: 2, price: 9000000, name: 'ДВУШКА' },
    { rooms: 3, price: 12000000, name: 'ТРЁШКА' }
];

function saveSeen() {
    fs.writeFileSync(SEEN_FILE, Array.from(seenLinks).join('\n'), 'utf-8');
}

async function sendReport(message, photos = []) {
    try {
        if (photos.length > 0) {
            const media = photos.map(url => ({ type: 'photo', media: url }));
            await bot.sendMediaGroup(CHAT_ID, media);
        }
        await bot.sendMessage(CHAT_ID, message, { disable_web_page_preview: true });
        console.log('Отправлено в TG:', message.substring(0, 100) + '...');
    } catch (e) {
        console.error('TG Error:', e.message);
    }
}

async function parseCian(filter) {
    console.log(`Парсим Циан: ${filter.rooms}-комн, до ${filter.price}...`);
    const browser = await puppeteer.launch({
        executablePath: '/usr/bin/google-chrome',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    });
    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9' });

    const url = `https://spb.cian.ru/cat.php?deal_type=sale&engine_version=2&offer_type=flat&region=2&room${filter.rooms}=1&maxprice=${filter.price}&foot_min=20&only_foot=2`;

    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 40000 });
        await new Promise(r => setTimeout(r, 8000));

        const count = await page.evaluate(() => document.querySelectorAll('div[data-name="CardComponent"]').length);
        console.log(`Найдено карточек на Циан: ${count}`);

        if (count === 0) {
            await sendReport(`Отладка: Циан не показал объявления (возможно, блокировка)`);
            await browser.close();
            return [];
        }

        const results = await page.evaluate(() => {
            const cards = [];
            document.querySelectorAll('div[data-name="CardComponent"]').forEach(card => {
                const link = card.querySelector('a[href*="cian.ru/card"]')?.href;
                const title = card.querySelector('[data-mark="OfferTitle"]')?.innerText;
                const price = card.querySelector('[data-mark="MainPrice"]')?.innerText;
                const metro = card.querySelector('[data-mark="Geo"] span')?.innerText || '';
                const area = card.querySelector('[data-mark="OfferSummary"]')?.innerText.match(/[\d.]+ м²/)?.[0];
                const photo = card.querySelector('img')?.src;

                if (link && title && price && !title.includes('апартаменты')) {
                    cards.push({ link, title, price: price.replace('₽', '').trim(), metro, area: area || '', photo });
                }
            });
            return cards.slice(0, 5);
        });

        console.log(`Успешно спарсил Циан: ${results.length} объявлений`);
        await browser.close();
        return results;
    } catch (e) {
        console.error('Ошибка Циан:', e.message);
        await sendReport(`Ошибка Циан: ${e.message}`);
        await browser.close();
        return [];
    }
}

async function parseAvito(filter) {
    console.log(`Парсим Авито: ${filter.rooms}-комн, до ${filter.price}...`);
    const browser = await puppeteer.launch({
        executablePath: '/usr/bin/google-chrome',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process'
        ]
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    const url = `https://www.avito.ru/sankt-peterburg/kvartiry/prodam/vtorichka/${filter.rooms}_komnatnye-ASgBAgICAkSSA8YQ5geOUg?cd=1&foot=2&metro=20&price_max=${filter.price}`;

    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 40000 });
        await new Promise(r => setTimeout(r, 8000));

        const count = await page.evaluate(() => document.querySelectorAll('div[data-marker="item"]').length);
        console.log(`Найдено карточек на Авито: ${count}`);

        if (count === 0) {
            await sendReport(`Отладка: Авито не показал объявления`);
            await browser.close();
            return [];
        }

        const results = await page.evaluate(() => {
            const items = [];
            document.querySelectorAll('div[data-marker="item"]').forEach(el => {
                const link = el.querySelector('a[itemprop="url"]')?.href;
                const title = el.querySelector('h3')?.innerText;
                const price = el.querySelector('meta[itemprop="price"]')?.content;
                const metro = el.querySelector('div[data-marker="item-address"]')?.innerText;
                const photo = el.querySelector('img')?.src;

                if (link && title && price && !title.includes('апартаменты')) {
                    items.push({
                        link: 'https://www.avito.ru' + link,
                        title,
                        price: parseInt(price).toLocaleString() + ' ₽',
                        metro: metro?.match(/м\. .+/)?.[0] || '',
                        area: title.match(/[\d.]+ м²/)?.[0] || '',
                        photo
                    });
                }
            });
            return items.slice(0, 5);
        });

        console.log(`Успешно спарсил Авито: ${results.length} объявлений`);
        await browser.close();
        return results;
    } catch (e) {
        console.error('Ошибка Авито:', e.message);
        await sendReport(`Ошибка Авито: ${e.message}`);
        await browser.close();
        return [];
    }
}

async function runSearch() {
    console.log('Запуск поиска:', new Date().toLocaleString());
    const now = new Date().toLocaleString('ru-RU');
    let report = `НОВЫЕ КВАРТИРЫ | ${now}\n\n`;
    let foundAny = false;
    let photos = [];

    for (const filter of FILTERS) {
        const cianResults = await parseCian(filter);
        const avitoResults = await parseAvito(filter);
        const all = [...cianResults, ...avitoResults].filter(x => x.photo);

        const newOnes = all.filter(x => !seenLinks.has(x.link));
        if (newOnes.length === 0) continue;

        foundAny = true;
        const best = newOnes.sort((a, b) => {
            const priceA = parseInt(a.price.replace(/[^0-9]/g, ''));
            const priceB = parseInt(b.price.replace(/[^0-9]/g, ''));
            return priceA - priceB;
        }).slice(0, 3);

        report += `${filter.name} — до ${filter.price.toLocaleString()} ₽\n`;
        best.forEach((apt, i) => {
            seenLinks.add(apt.link);
            photos.push(apt.photo);
            report += `${i+1} ${apt.price} | ${apt.metro}\n`;
            report += ` ${apt.area}, ${apt.title.split(',')[1] || ''}\n`;
            report += ` ${apt.link}\n\n`;
        });
        report += '\n';
    }

    if (!foundAny) {
        report = `Новых подходящих квартир нет. Ищу дальше...`;
    }

    await sendReport(report.trim(), photos);
    saveSeen();
    console.log('Поиск завершён');
}

// === ЗАПУСК ===
console.log('Бот запущен. Первый поиск через 15 сек...');
setTimeout(runSearch, 15000);
new CronJob('0 9,19 * * *', runSearch, null, true, 'Europe/Moscow');
setInterval(() => {}, 1 << 30);
