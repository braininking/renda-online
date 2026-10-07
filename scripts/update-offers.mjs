import { readFile, writeFile } from "node:fs/promises";

const SOURCE = "https://www.promobit.com.br/";
const MAX_OFFERS = 12;
const USER_AGENT = "OfertaRadar/1.0 (+https://renda-online.onrender.com)";
const AMAZON_TAG = "ofertaradar03-20";
const MAGALU_PARTNER = "magazineoneshotlink";

const STORE_DOMAINS = new Set([
  "amazon.com.br",
  "kabum.com.br",
  "magazineluiza.com.br",
  "magalu.com.br",
  "shopee.com.br",
  "mercadolivre.com.br"
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function get(url, options = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    ...options,
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/json,*/*",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status + " em " + url);
  }

  return response;
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function hostname(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isSupported(url) {
  return STORE_DOMAINS.has(hostname(url));
}

function image600(photo) {
  const value = clean(photo);
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    return value.replace(/\/180\//i, "/600/");
  }
  return "https://i.promobit.com.br/600/" + value.replace(/^\/+/, "");
}

async function resolveImage(photo) {
  const high = image600(photo);
  if (!high) return null;

  try {
    const response = await fetch(high, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT }
    });
    if (response.ok) return high;
  } catch {}

  return high.replace("/600/", "/180/");
}

async function resolvePromobitOffer(offerId) {
  try {
    const response = await get(
      "https://www.promobit.com.br/Redirect/to/" +
      encodeURIComponent(offerId) + "/",
      { headers: { "Accept": "text/html,*/*" } }
    );

    const html = await response.text();

    const match =
      html.match(/\bl\s*=\s*['"]([^'"]+)['"]/i) ||
      html.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i);

    if (!match?.[1]) return response.url || null;

    return String(match[1])
      .replace(/\u002f/gi, "/")
      .replace(/\u003a/gi, ":")
      .replace(/&amp;/gi, "&");
  } catch {
    return null;
  }
}

async function resolveFinalUrl(url) {
  if (!url) return null;
  if (isSupported(url)) return url;

  try {
    const response = await get(url, {
      method: "GET",
      headers: { "Accept": "text/html,*/*" }
    });
    return response.url || null;
  } catch {
    return null;
  }
}

function affiliateUrl(url) {
  if (!url) return null;

  const host = hostname(url);

  if (host === "amazon.com.br") {
    try {
      const parsed = new URL(url);
      parsed.searchParams.set("tag", AMAZON_TAG);
      return parsed.toString();
    } catch {
      return null;
    }
  }

  if (host === "magazineluiza.com.br" || host === "magalu.com.br") {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/^\/(.+?)\/p\/([a-z0-9]+)(\/[^?]*)?\/?$/i);
      if (!match) return null;

      const slug = match[1].replace(/^\/+|\/+$/g, "");
      const code = match[2];
      const suffix = match[3] || "";

      return (
        "https://www.magazinevoce.com.br/" +
        MAGALU_PARTNER + "/" +
        slug + "/p/" + code + suffix + "/"
      );
    } catch {
      return null;
    }
  }

  return null;
}

function readNextData(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function offerScore(offer) {
  return (
    (offer.offerIsHighlight ? 100000 : 0) +
    Number(offer.offerEngagementScore || 0) * 10 +
    Number(offer.offerLikes || 0) * 3 +
    Number(offer.offerDiscontPercentage || 0) * 2 +
    Number(offer.offerClicks || 0)
  );
}

function normalizeCandidate(offer) {
  if (!offer?.offerId || !offer?.offerTitle || !offer?.storeDomain) return null;

  const storeDomain = String(offer.storeDomain)
    .toLowerCase()
    .replace(/^www\./, "");

  if (!STORE_DOMAINS.has(storeDomain)) return null;

  const title = clean(offer.offerTitle);
  const price = Number(offer.offerPrice);
  const oldPrice = Number(offer.offerOldPrice);

  return {
    id: String(offer.offerId),
    title,
    storeName: clean(offer.storeName) || storeDomain,
    storeDomain,
    photo: offer.offerPhoto || null,
    price: Number.isFinite(price) ? price : null,
    oldPrice: Number.isFinite(oldPrice) && oldPrice > 0 ? oldPrice : null,
    discount: Number(offer.offerDiscontPercentage || 0),
    publishedAt: offer.offerPublished || null,
    score: offerScore(offer)
  };
}

function buildItem(candidate, affiliate, image) {
  return {
    title: candidate.title,
    store: candidate.storeName,
    price: candidate.price,
    oldPrice: candidate.oldPrice,
    affiliateUrl: affiliate,
    image,
    description:
      candidate.discount > 0
        ? "Oferta encontrada automaticamente no Promobit com " + candidate.discount + "% de desconto."
        : "Oferta encontrada automaticamente no Promobit.",
    source: "Promobit",
    updatedAt: new Date().toISOString()
  };
}

async function main() {
  console.log("[OfertaRadar] buscando ofertas novas...");

  const response = await get(SOURCE);
  const html = await response.text();
  const data = readNextData(html);

  const rawOffers = data?.props?.pageProps?.serverOffers?.offers || [];
  const candidates = rawOffers
    .map(normalizeCandidate)
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  console.log("[OfertaRadar] candidatos:", candidates.length);

  const seen = JSON.parse(await readFile("seen-offers.json", "utf8").catch(() => "{}"));
  const selected = [];
  const selectedIds = new Set();

  for (const candidate of candidates) {
    if (selected.length >= MAX_OFFERS) break;
    if (seen[candidate.id]) continue;

    const promobitUrl = await resolvePromobitOffer(candidate.id);
    const finalUrl = await resolveFinalUrl(promobitUrl);
    const affiliate = affiliateUrl(finalUrl);

    if (!affiliate) continue;

    const image = await resolveImage(candidate.photo);
    selected.push(buildItem(candidate, affiliate, image));
    selectedIds.add(candidate.id);
    await sleep(150);
  }

  if (selected.length < 6) {
    for (const candidate of candidates) {
      if (selected.length >= MAX_OFFERS) break;
      if (selectedIds.has(candidate.id)) continue;

      const promobitUrl = await resolvePromobitOffer(candidate.id);
      const finalUrl = await resolveFinalUrl(promobitUrl);
      const affiliate = affiliateUrl(finalUrl);
      if (!affiliate) continue;

      const image = await resolveImage(candidate.photo);
      selected.push(buildItem(candidate, affiliate, image));
      selectedIds.add(candidate.id);
      await sleep(150);
    }
  }

  if (!selected.length) {
    throw new Error("Nenhuma oferta afiliada válida foi encontrada nesta rodada.");
  }

  for (const id of selectedIds) {
    seen[id] = new Date().toISOString();
  }

  const entries = Object.entries(seen)
    .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
    .slice(0, 5000);

  await writeFile("seen-offers.json", JSON.stringify(Object.fromEntries(entries), null, 2) + "\n");
  await writeFile("offers.json", JSON.stringify(selected, null, 2) + "\n");

  console.log("[OfertaRadar] ofertas publicadas:", selected.length);
  console.log(selected.map(item => "- " + item.store + ": " + item.title).join("\n"));
}

main().catch(error => {
  console.error("[OfertaRadar] erro:", error);
  process.exit(1);
});
