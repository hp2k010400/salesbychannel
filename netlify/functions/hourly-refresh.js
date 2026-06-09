const { getStore } = require('@netlify/blobs');

const STORE_DOMAIN = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const CHANNEL_MAP = {
  'Online Store': 'Website',
  'Point of Sale': 'Point of Sale (POS)',
  'Tapcart - Mobile App': 'App',
  'Marketplace Connect': 'Marketplace',
};

const SHOPIFYQL_GQL = `
  query ShopifyQLChannels($q: String!) {
    shopifyqlQuery(query: $q) {
      ... on TableResponse {
        tableData { headers rowData }
      }
      ... on ParseErrorResponse {
        parseErrors { message }
      }
    }
  }
`;

function getMondayISO() {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString();
}

async function getChannelData(mondayDate) {
  const q = `FROM sales SINCE ${mondayDate} UNTIL today SELECT channel, SUM(net_sales) AS net_sales GROUP BY channel ORDER BY net_sales DESC`;

  const res = await fetch(`https://${STORE_DOMAIN}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': ACCESS_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: SHOPIFYQL_GQL, variables: { q } }),
  });

  if (!res.ok) throw new Error(`ShopifyQL fetch failed: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);

  const result = json.data.shopifyqlQuery;
  if (result.parseErrors?.length) throw new Error(`ShopifyQL: ${result.parseErrors.map(e => e.message).join(', ')}`);

  const { headers, rowData } = result.tableData;
  const chIdx = headers.indexOf('channel');
  const salIdx = headers.indexOf('net_sales');

  const merged = {};
  for (const row of rowData) {
    const channelName = row[chIdx];
    const revenue = parseFloat(String(row[salIdx] || '0').replace(/,/g, ''));
    if (!channelName || isNaN(revenue) || revenue <= 0) continue;
    const mappedName = CHANNEL_MAP[channelName];
    if (!mappedName) continue;
    merged[mappedName] = (merged[mappedName] || 0) + revenue;
  }

  return Object.entries(merged).map(([name, revenue]) => ({ name, revenue }));
}

exports.handler = async () => {
  try {
    const mondayISO = getMondayISO();
    const mondayDate = mondayISO.slice(0, 10);
    const channels = await getChannelData(mondayDate);

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
