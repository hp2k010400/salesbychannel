const { getStore } = require('@netlify/blobs');

const STORE_DOMAIN = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const CHANNEL_MAP = {
  'web': 'Website',
  'pos': 'Point of Sale (POS)',
  'tapcart': 'App',
  'iphone': 'App',
  'android': 'App',
  'shop_app': 'App',
  'ebay': 'Marketplace',
  'Ebay': 'Marketplace',
  'eBay': 'Marketplace',
  'amazon': 'Marketplace',
  'Amazon': 'Marketplace',
};

const EXCLUDE_SOURCES = new Set(['shopify_draft_order', '1520611', 'decathlon', 'Decathlon']);

function getMondayISO() {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString();
}

async function getChannelData(mondayISO) {
  const rawChannels = {};
  let pageInfo = null;

  do {
    let endpoint;
    if (pageInfo) {
      endpoint = `orders.json?limit=250&page_info=${pageInfo}`;
    } else {
      endpoint = `orders.json?created_at_min=${encodeURIComponent(mondayISO)}&financial_status=paid&status=any&limit=250`;
    }

    const res = await fetch(`https://${STORE_DOMAIN}/admin/api/2024-01/${endpoint}`, {
      headers: { 'X-Shopify-Access-Token': ACCESS_TOKEN },
    });
    if (!res.ok) throw new Error(`Orders fetch failed: ${res.status}`);

    const data = await res.json();
    for (const order of data.orders) {
      const source = order.source_name || 'other';
      console.log('ORDER SOURCE:', source, order.order_number);
      if (EXCLUDE_SOURCES.has(source)) continue;
      rawChannels[source] = (rawChannels[source] || 0) + parseFloat(order.total_price || 0);
    }

    const linkHeader = res.headers.get('Link') || '';
    const match = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    pageInfo = match ? match[1] : null;
  } while (pageInfo);

  const merged = {};
  for (const [source, revenue] of Object.entries(rawChannels)) {
    const name = CHANNEL_MAP[source] || source;
    merged[name] = (merged[name] || 0) + revenue;
  }

  return Object.entries(merged).map(([name, revenue]) => ({ name, revenue }));
}

exports.handler = async () => {
  try {
    const mondayISO = getMondayISO();
    const channels = await getChannelData(mondayISO);

    const store = getStore({
      name: 'sales-channels',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_TOKEN,
    });

    await store.setJSON('current', {
      channels,
      weekStart: mondayISO,
      updated: new Date().toISOString(),
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, channels }) };
  } catch (err) {
    console.error('hourly-refresh failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
