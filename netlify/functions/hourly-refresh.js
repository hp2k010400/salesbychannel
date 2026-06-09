const { getStore } = require('@netlify/blobs');

const STORE_DOMAIN = process.env.SHOPIFY_STORE;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const CHANNEL_MAP = {
  'Online Store': 'Website',
  'Point of Sale': 'Point of Sale (POS)',
  'Tapcart - Mobile App': 'App',
  'Tapcart': 'App',
  'Marketplace Connect': 'Marketplace',
  'eBay': 'Marketplace',
  'Amazon': 'Marketplace',
};

const CHANNEL_ID_MAP = {
  'gid://shopify/ChannelInformation/79751086195': 'App',
};

const EXCLUDE_CHANNELS = new Set([
  'Decathlon', 'Draft Orders', 'shopify_draft_order', 'other',
  'eBay by Shopify', 'Amazon by Shopify',
]);

const ORDERS_QUERY = `
  query GetOrders($queryStr: String!, $after: String) {
    orders(first: 250, query: $queryStr, after: $after) {
      edges {
        node {
          currentSubtotalPriceSet { shopMoney { amount } }
          channelInformation {
            channelId
            channelDefinition { channelName }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
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

async function gqlFetch(queryStr, after) {
  const res = await fetch(`https://${STORE_DOMAIN}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': ACCESS_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: ORDERS_QUERY, variables: { queryStr, after } }),
  });
  if (!res.ok) throw new Error(`GraphQL fetch failed: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function getChannelData(mondayISO) {
  const rawChannels = {};
  let after = null;
  const mondayDate = mondayISO.slice(0, 10);
  const queryStr = `financial_status:paid processed_at:>=${mondayDate}`;

  do {
    const data = await gqlFetch(queryStr, after);
    const { edges, pageInfo } = data.orders;

    for (const { node: order } of edges) {
      const channelId = order.channelInformation?.channelId;
      const channelName = order.channelInformation?.channelDefinition?.channelName
        || CHANNEL_ID_MAP[channelId]
        || 'other';
      if (EXCLUDE_CHANNELS.has(channelName)) continue;
      const amount = parseFloat(order.currentSubtotalPriceSet?.shopMoney?.amount || 0);
      rawChannels[channelName] = (rawChannels[channelName] || 0) + amount;
    }

    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);

  const merged = {};
  for (const [channelName, revenue] of Object.entries(rawChannels)) {
    const name = CHANNEL_MAP[channelName] || channelName;
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
