import { type NextRequest, NextResponse } from 'next/server'
import { Configuration, PlaidApi, PlaidEnvironments, Transaction } from 'plaid'

const COOKIE_NAME = 'plaid_access_token'
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  maxAge: 60 * 60 * 24 * 30, // 30 days
  path: '/',
}

const plaidClient = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV as keyof typeof PlaidEnvironments ?? 'sandbox'],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      },
    },
  })
)

export interface RestaurantScore {
  name: string
  visits: number
  totalSpend: number
  transactions: { date: string; amount: number }[]
  yelpRating: number | null
  yelpPrice: number | null // 1-4
  yelpPriceLabel: string | null // $, $$, $$$, $$$$
  yelpName: string | null
  yelpUrl: string | null
  imageUrl: string | null
}

export interface AnalysisResult {
  // Three-word verdict
  spendWord: 'Chaotic' | 'Casual' | 'Refined'   // classScore-based: how expensive are your spots?
  qualityWord: 'Trash' | 'Chic' | 'Gourmet'     // starScore-based: how good are your spots?
  lifestyleWord: 'Chef' | 'Goblin' | 'Socialite' // spend-split-based: where do you eat?
  verdict: string  // compound: "Broke Refined Socialite"
  tagline: string
  starScore: number // weighted avg 1-5
  classScore: number // weighted avg 1-4
  totalDiningTransactions: number
  totalDiningSpend: number
  deliverySpend: number
  totalFoodSpend: number // all FOOD_AND_DRINK
  groceriesSpend: number
  restaurantSpend: number
  restaurants: RestaurantScore[]
  crownJewel: RestaurantScore | null
  worstOffender: RestaurantScore | null
}

// Delivery aggregators: transactions carry the platform name, not the actual restaurant,
// so a Yelp lookup would return a random unrelated business. Exclude them entirely.
const DELIVERY_PLATFORMS = new Set([
  'uber eats', 'ubereats', 'doordash', 'grubhub', 'seamless', 'postmates',
  'caviar', 'instacart', 'gopuff', 'favor', 'waitr', 'bite squad',
])

function isDeliveryPlatform(name: string): boolean {
  // Normalize away special chars before matching so "UBER* EATS" → "uber eats"
  const normalized = name.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim()
  return [...DELIVERY_PLATFORMS].some(p => normalized === p || normalized.includes(p))
}

const EXCLUDED_DETAILED_CATEGORIES = new Set([
  'FOOD_AND_DRINK_GROCERIES',
  'FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK',
])

// Any food & drink transaction (including groceries) — used for total spend breakdown
function isFoodAndDrink(tx: Transaction): boolean {
  if (tx.personal_finance_category?.primary === 'FOOD_AND_DRINK') return true
  const cats = tx.category ?? []
  return cats.some(c =>
    ['Restaurants', 'Fast Food', 'Coffee Shop', 'Bar', 'Food and Drink',
     'Grocery Store', 'Supermarkets and Groceries'].includes(c)
  )
}

function isGrocery(tx: Transaction): boolean {
  return EXCLUDED_DETAILED_CATEGORIES.has(tx.personal_finance_category?.detailed ?? '')
}

function isRestaurant(tx: Transaction): boolean {
  if (tx.personal_finance_category?.primary === 'FOOD_AND_DRINK') {
    if (EXCLUDED_DETAILED_CATEGORIES.has(tx.personal_finance_category.detailed ?? '')) return false
    return true
  }
  // Fallback: legacy category array
  const cats = tx.category ?? []
  return cats.some(c => ['Restaurants', 'Fast Food', 'Coffee Shop', 'Bar', 'Food and Drink'].includes(c))
}

// ---- Name normalization ----
// Strip common POS prefixes (Square, Toast, etc.) and location suffixes Plaid appends.
const POS_PREFIX_RE = /^(sq\s*\*\s*|tst\s*\*\s*|pp\s*\*\s*|paypal\s*\*\s*|toast\s*\*\s*)/i
const LOCATION_SUFFIX_RE = /\s+([-–#]\s*\S.*|[A-Z]{2}\s*\d{5}.*)$/  // "- Chicago IL" or "#42"

function normalizeName(raw: string): string {
  return raw
    .replace(POS_PREFIX_RE, '')
    .replace(LOCATION_SUFFIX_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Strip any leading prefix of `city` that Plaid has concatenated onto the end of
// the merchant name at a character limit (e.g. "Sightglasan" → "Sightgla" when city
// is "San Francisco" → normalized "san francisco", prefix "san" matches suffix).
// Requires at least 3 chars to avoid false positives on short common words.
function stripCityPrefix(name: string, city: string): string {
  for (let len = city.length; len >= 3; len--) {
    if (name.endsWith(city.slice(0, len))) {
      return name.slice(0, -len).trim()
    }
  }
  return name
}

// Normalize a transaction merchant name, optionally stripping a city prefix artifact.
function normalizeTxName(raw: string, city?: string | null): string {
  const base = normalizeName(raw)
  return city ? stripCityPrefix(base, normalizeName(city)) : base
}

// ---- Levenshtein distance ----
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1])
      prev = tmp
    }
  }
  return dp[n]
}

// Length of shared prefix between two strings
function commonPrefixLength(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

// Similarity 0–1 on already-normalized strings.
// Returns score AND the rule that triggered it for logging.
function scoredSimilarity(a: string, b: string): { score: number; rule: string } {
  if (!a || !b) return { score: 0, rule: 'empty' }
  if (a === b) return { score: 1, rule: 'exact' }
  if (a.includes(b) || b.includes(a)) return { score: 0.9, rule: 'substring' }

  const aFirst = a.split(' ')[0]
  const bFirst = b.split(' ')[0]
  if (aFirst.length >= 3 && aFirst === bFirst) return { score: 0.8, rule: 'first-word' }

  const score = 1 - levenshtein(a, b) / Math.max(a.length, b.length)
  return { score, rule: 'levenshtein' }
}

function bestMatch(txName: string, pool: YelpBiz[], city?: string | null): YelpBiz | null {
  const THRESHOLD = 0.5
  const MIN_PREFIX = 4
  const normTx = normalizeTxName(txName, city)
  const dev = process.env.NODE_ENV === 'development'

  if (dev) {
    console.log(`\n  [match] "${txName}" → normalized: "${normTx}" (pool: ${pool.length})`)
  }

  // Primary pass: scored similarity
  type Candidate = { biz: YelpBiz; normYelp: string; score: number; rule: string }
  const allCandidates: Candidate[] = []

  for (const biz of pool) {
    const normYelp = normalizeName(biz.name)
    const { score, rule } = scoredSimilarity(normTx, normYelp)
    if (score > 0) allCandidates.push({ biz, normYelp, score, rule })
  }

  allCandidates.sort((a, b) => b.score - a.score)
  const candidates = allCandidates.filter(c => c.score >= THRESHOLD)

  if (dev) {
    console.log(`  [match]   top candidates (threshold: ${THRESHOLD}):`)
    if (allCandidates.length === 0) {
      console.log(`  [match]     (none scored above 0)`)
    } else {
      allCandidates.slice(0, 10).forEach(c => {
        const marker = c.score >= THRESHOLD ? '✓' : '✗'
        console.log(`  [match]     ${marker} "${c.biz.name}" (norm: "${c.normYelp}") score=${c.score.toFixed(2)} rule=${c.rule}`)
      })
    }
  }

  if (candidates.length > 0) {
    if (dev) console.log(`  [match]   ✓ winner: "${candidates[0].biz.name}" via ${candidates[0].rule}`)
    return candidates[0].biz
  }

  // Fallback: longest common prefix
  let prefixBest: { biz: YelpBiz; normYelp: string; len: number } | null = null
  for (const biz of pool) {
    const normYelp = normalizeName(biz.name)
    const len = commonPrefixLength(normTx, normYelp)
    if (len >= MIN_PREFIX && (!prefixBest || len > prefixBest.len)) {
      prefixBest = { biz, normYelp, len }
    }
  }

  if (dev) {
    if (prefixBest) {
      console.log(`  [match]   ✓ winner: "${prefixBest.biz.name}" via prefix-fallback (shared ${prefixBest.len} chars: "${normTx.slice(0, prefixBest.len)}")`)
    } else {
      console.log(`  [match]   ✗ no match`)
    }
  }

  return prefixBest?.biz ?? null
}

// ---- Yelp types & search ----
const PRICE_MAP: Record<string, number> = { '$': 1, '$$': 2, '$$$': 3, '$$$$': 4 }

interface YelpBiz {
  name: string
  rating: number | null
  price: string | null
  priceNum: number | null
  imageUrl: string | null
  url: string | null
}

async function searchYelp(params: URLSearchParams): Promise<YelpBiz[]> {
  params.set('categories', 'restaurants,food,bars')
  params.set('limit', '50')
  try {
    const res = await fetch(`https://api.yelp.com/v3/businesses/search?${params}`, {
      headers: { Authorization: `Bearer ${process.env.YELP_API_KEY}` },
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.businesses ?? []).map((b: { name: string; rating?: number; price?: string; image_url?: string; url?: string }) => ({
      name: b.name,
      rating: b.rating ?? null,
      price: b.price ?? null,
      priceNum: b.price ? (PRICE_MAP[b.price] ?? null) : null,
      imageUrl: b.image_url ?? null,
      url: b.url ?? null,
    }))
  } catch {
    return []
  }
}

function coordKey(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`
}

function cityKey(city: string, state: string): string {
  return `${city.toLowerCase().trim()},${state.toLowerCase().trim()}`
}

// Euclidean distance between two lat/lon pairs (good enough for proximity ranking)
function coordDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return Math.hypot(lat1 - lat2, lon1 - lon2)
}

// ---- Regional Yelp cache builder ----
type GroupData = {
  visits: number
  totalSpend: number
  transactions: { date: string; amount: number }[]
  lat?: number | null
  lon?: number | null
  city?: string | null
  state?: string | null
}

// Search Yelp for a specific merchant by name + location.
// Cached by term+location so the same merchant is never fetched twice.
const yelpSearchCache = new Map<string, YelpBiz[]>()

async function searchYelpForMerchant(name: string, data: GroupData): Promise<YelpBiz[]> {
  const term = normalizeTxName(name, data.city)
  let locationKey: string
  const params = new URLSearchParams({ term, radius: '40000' })

  if (data.lat && data.lon) {
    locationKey = coordKey(data.lat, data.lon)
    params.set('latitude', String(data.lat))
    params.set('longitude', String(data.lon))
  } else if (data.city && data.state) {
    locationKey = cityKey(data.city, data.state)
    params.set('location', `${data.city}, ${data.state}`)
  } else {
    locationKey = 'us'
    params.set('location', 'United States')
  }

  const cacheKey = `${term}|${locationKey}`
  if (yelpSearchCache.has(cacheKey)) return yelpSearchCache.get(cacheKey)!

  const results = await searchYelp(params)
  yelpSearchCache.set(cacheKey, results)
  return results
}

function computeSpendWord(classScore: number): AnalysisResult['spendWord'] {
  if (classScore < 1.75) return 'Chaotic'
  if (classScore < 2.75) return 'Casual'
  return 'Refined'
}

function computeQualityWord(starScore: number): AnalysisResult['qualityWord'] {
  if (starScore < 3.5) return 'Trash'
  if (starScore < 4.2) return 'Chic'
  return 'Gourmet'
}

function computeLifestyleWord(
  groceriesSpend: number,
  deliverySpend: number,
  restaurantSpend: number,
): AnalysisResult['lifestyleWord'] {
  const max = Math.max(groceriesSpend, deliverySpend, restaurantSpend)
  if (groceriesSpend === max) return 'Chef'
  if (deliverySpend === max) return 'Goblin'
  return 'Socialite'
}

const TAGLINES: Record<string, string> = {
  'Chaotic-Trash-Chef':      'Buying cheap groceries and somehow eating badly. A survivalist.',
  'Chaotic-Trash-Goblin':    'Cheap delivery, questionable choices. The couch doesn\'t judge.',
  'Chaotic-Trash-Socialite': 'Going out constantly for mediocre food on a tight budget. The dedication is real.',
  'Chaotic-Chic-Chef':       'Eating well for less, at home. You know where to shop.',
  'Chaotic-Chic-Goblin':     'Budget delivery with solid taste. Getting quality without the markup.',
  'Chaotic-Chic-Socialite':  'Finding the best spots at the best prices. We need your secrets.',
  'Chaotic-Gourmet-Chef':    'World-class groceries, eaten at home in pajamas. Mysterious.',
  'Chaotic-Gourmet-Goblin':  'Getting the best delivered, spending almost nothing. A wizard.',
  'Chaotic-Gourmet-Socialite':'Somehow eating at the finest spots on a budget. A gift.',
  'Casual-Trash-Chef':       'Mid-range groceries, mediocre execution, eaten at home. A quiet tragedy.',
  'Casual-Trash-Goblin':     'Middle-of-the-road delivery, every night. Consistency is a virtue.',
  'Casual-Trash-Socialite':  'Average spots, average prices, zero regrets. The reliable regular.',
  'Casual-Chic-Chef':        'A solid home cook with good taste. The introvert foodie.',
  'Casual-Chic-Goblin':      'Comfortable in your delivery routine. Solid choices, every time.',
  'Casual-Chic-Socialite':   'The backbone of the restaurant industry. Reliable, solid, respected.',
  'Casual-Gourmet-Chef':     'High standards, home setting. You grocery shop like a professional.',
  'Casual-Gourmet-Goblin':   'Ordering from the best spots, refusing to leave the house. Fair.',
  'Casual-Gourmet-Socialite':'A regular at the right places. The servers know your order.',
  'Refined-Trash-Chef':      'Spending lavishly on mediocre groceries. Bold strategy.',
  'Refined-Trash-Goblin':    'Expensive delivery, questionable taste. Money confidently spent.',
  'Refined-Trash-Socialite': 'Going to pricey places and somehow eating badly. Impressive.',
  'Refined-Chic-Chef':       'Premium home chef vibes. You have the good cutting board.',
  'Refined-Chic-Goblin':     'High-end delivery regular. You tip 30% and feel great about it.',
  'Refined-Chic-Socialite':  'The restaurant regular with the budget and taste to match.',
  'Refined-Gourmet-Chef':    'Michelin-star groceries, eaten alone. A beautiful mystery.',
  'Refined-Gourmet-Goblin':  'Impeccable taste, delivered to your door. Introvert royalty.',
  'Refined-Gourmet-Socialite':'Your dining is a lifestyle. Your bank statement is a love letter to good taste.',
}

function computeVerdict(
  spendWord: AnalysisResult['spendWord'],
  qualityWord: AnalysisResult['qualityWord'],
  lifestyleWord: AnalysisResult['lifestyleWord'],
): { verdict: string; tagline: string } {
  const key = `${spendWord}-${qualityWord}-${lifestyleWord}`
  const tagline = TAGLINES[key] ?? `A ${spendWord.toLowerCase()} ${lifestyleWord.toLowerCase()} with ${qualityWord.toLowerCase()} taste.`
  return { verdict: `${spendWord} ${qualityWord} ${lifestyleWord}`, tagline }
}

const PAGE_SIZE = 500

async function fetchPageWithRetry(
  accessToken: string, startDate: string, endDate: string,
  offset: number, maxRetries = 5,
) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await plaidClient.transactionsGet({
        access_token: accessToken,
        start_date: startDate,
        end_date: endDate,
        options: { count: PAGE_SIZE, offset },
      })
    } catch (err: unknown) {
      const plaidError = (err as { response?: { data?: { error_code?: string } } })?.response?.data
      if (plaidError?.error_code === 'PRODUCT_NOT_READY' && attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)))
        continue
      }
      throw err
    }
  }
  throw new Error('Transactions not ready after retries')
}

async function fetchAllTransactions(accessToken: string, startDate: string, endDate: string): Promise<Transaction[]> {
  const first = await fetchPageWithRetry(accessToken, startDate, endDate, 0)
  const all = [...first.data.transactions]
  const total = first.data.total_transactions

  // Fetch remaining pages in parallel
  if (total > PAGE_SIZE) {
    const offsets = Array.from(
      { length: Math.ceil((total - PAGE_SIZE) / PAGE_SIZE) },
      (_, i) => (i + 1) * PAGE_SIZE,
    )
    const pages = await Promise.all(
      offsets.map(offset => fetchPageWithRetry(accessToken, startDate, endDate, offset))
    )
    for (const page of pages) all.push(...page.data.transactions)
  }

  if (process.env.NODE_ENV === 'development') {
    console.log(`[analyze] fetched ${all.length} / ${total} transactions`)
  }

  return all
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const { public_token } = body

  let accessToken: string
  let isNewConnection = false

  if (public_token) {
    // First-time connect: exchange and store in cookie
    const exchangeRes = await plaidClient.itemPublicTokenExchange({ public_token })
    accessToken = exchangeRes.data.access_token
    isNewConnection = true
  } else {
    // Returning visit: read from cookie
    const saved = request.cookies.get(COOKIE_NAME)?.value
    if (!saved) {
      return Response.json({ error: 'Not connected. Please link your bank account.' }, { status: 401 })
    }
    accessToken = saved
  }

  // Fetch all transactions from the last 90 days (paginated)
  const endDate = new Date().toISOString().split('T')[0]
  const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  let allTxs: Transaction[]
  try {
    allTxs = await fetchAllTransactions(accessToken, startDate, endDate)
  } catch (err: unknown) {
    const plaidError = (err as { response?: { data?: { error_code?: string } } })?.response?.data
    if (plaidError?.error_code === 'PRODUCT_NOT_READY') {
      return Response.json(
        { error: 'Your account just connected — Plaid is still importing your transactions. Wait 30 seconds and try again.' },
        { status: 503 }
      )
    }
    throw err
  }

  // Split all food & drink into buckets for the spending breakdown
  const allFoodAndDrinkTxs = allTxs.filter(isFoodAndDrink)
  const groceryTxs = allFoodAndDrinkTxs.filter(isGrocery)
  const nonGroceryTxs = allFoodAndDrinkTxs.filter(tx => !isGrocery(tx))
  const deliveryTxs = nonGroceryTxs.filter(tx => isDeliveryPlatform(tx.merchant_name ?? tx.name))
  const restaurantTxs = nonGroceryTxs.filter(tx => !isDeliveryPlatform(tx.merchant_name ?? tx.name))

  if (process.env.NODE_ENV === 'development') {
    console.log('[analyze] raw food transactions:', JSON.stringify(allFoodAndDrinkTxs.map(tx => ({
      name: tx.name,
      merchant_name: tx.merchant_name,
      amount: tx.amount,
      date: tx.date,
      category: tx.category,
      personal_finance_category: tx.personal_finance_category,
      location: {
        address: tx.location?.address,
        city: tx.location?.city,
        region: tx.location?.region,
        postal_code: tx.location?.postal_code,
        lat: tx.location?.lat,
        lon: tx.location?.lon,
      },
    })), null, 2))
    console.log(`[analyze] total food: ${allFoodAndDrinkTxs.length} | groceries: ${groceryTxs.length} | restaurants: ${restaurantTxs.length} | delivery: ${deliveryTxs.length}`)
  }
  const deliverySpend = Math.round(deliveryTxs.reduce((s, t) => s + t.amount, 0) * 100) / 100
  const groceriesSpend = Math.round(groceryTxs.reduce((s, t) => s + t.amount, 0) * 100) / 100
  const restaurantSpend = Math.round(restaurantTxs.reduce((s, t) => s + t.amount, 0) * 100) / 100
  const totalFoodSpend = Math.round(allFoodAndDrinkTxs.reduce((s, t) => s + t.amount, 0) * 100) / 100

  if (restaurantTxs.length === 0) {
    const msg = deliveryTxs.length > 0
      ? `All ${nonGroceryTxs.length} dining transactions are delivery platforms (Uber Eats, DoorDash, etc.) — no dine-in restaurant data to score.`
      : 'No restaurant transactions found in the last 90 days.'
    return Response.json({ error: msg }, { status: 422 })
  }

  // Group by merchant name, preserving best available location data
  const grouped = new Map<string, GroupData>()
  for (const tx of restaurantTxs) {
    const name = tx.merchant_name ?? tx.name
    const existing = grouped.get(name) ?? {
      visits: 0,
      totalSpend: 0,
      transactions: [],
      lat: tx.location?.lat,
      lon: tx.location?.lon,
      city: tx.location?.city,
      state: tx.location?.region,
    }
    grouped.set(name, {
      visits: existing.visits + 1,
      totalSpend: existing.totalSpend + tx.amount,
      transactions: [...existing.transactions, { date: tx.date, amount: tx.amount }],
      lat: existing.lat ?? tx.location?.lat,
      lon: existing.lon ?? tx.location?.lon,
      city: existing.city ?? tx.location?.city,
      state: existing.state ?? tx.location?.region,
    })
  }

  const sorted = [...grouped.entries()]
    .sort((a, b) => b[1].visits - a[1].visits)
    .slice(0, 100)

  // Search Yelp per merchant (batches of 5), passing name as term + location
  yelpSearchCache.clear()
  const restaurants: RestaurantScore[] = []
  for (let i = 0; i < sorted.length; i += 5) {
    const batch = sorted.slice(i, i + 5)
    const batchResults = await Promise.all(
      batch.map(async ([name, data]) => {
        const pool = await searchYelpForMerchant(name, data)
        const match = bestMatch(name, pool, data.city)
        return {
          name,
          visits: data.visits,
          totalSpend: Math.round(data.totalSpend * 100) / 100,
          transactions: data.transactions.sort((a, b) => b.date.localeCompare(a.date)),
          yelpRating: match?.rating ?? null,
          yelpPrice: match?.priceNum ?? null,
          yelpPriceLabel: match?.price ?? null,
          yelpName: match?.name ?? null,
          yelpUrl: match?.url ?? null,
          imageUrl: match?.imageUrl ?? null,
        }
      })
    )
    restaurants.push(...batchResults)
  }

  // Score: only restaurants with Yelp data
  const scored = restaurants.filter(r => r.yelpRating !== null)
  const totalVisits = scored.reduce((sum, r) => sum + r.visits, 0)

  let starScore = 0
  let classScore = 0
  if (scored.length > 0 && totalVisits > 0) {
    for (const r of scored) {
      const weight = r.visits / totalVisits
      starScore += (r.yelpRating ?? 0) * weight
      classScore += (r.yelpPrice ?? 1) * weight
    }
  }

  const spendWord = computeSpendWord(classScore)
  const qualityWord = computeQualityWord(starScore)
  const lifestyleWord = computeLifestyleWord(groceriesSpend, deliverySpend, restaurantSpend)
  const { verdict, tagline } = computeVerdict(spendWord, qualityWord, lifestyleWord)

  const withRating = restaurants.filter(r => r.yelpRating !== null)
  const crownJewel = withRating.sort((a, b) => (b.yelpRating ?? 0) - (a.yelpRating ?? 0))[0] ?? null
  const worstOffender = withRating.sort((a, b) => (a.yelpRating ?? 5) - (b.yelpRating ?? 5))[0] ?? null

  const result: AnalysisResult = {
    spendWord,
    qualityWord,
    lifestyleWord,
    verdict,
    tagline,
    starScore: Math.round(starScore * 10) / 10,
    classScore: Math.round(classScore * 10) / 10,
    totalDiningTransactions: restaurantTxs.length,
    totalDiningSpend: restaurantSpend,
    deliverySpend,
    totalFoodSpend,
    groceriesSpend,
    restaurantSpend,
    restaurants,
    crownJewel,
    worstOffender,
  }

  const response = NextResponse.json(result)
  if (isNewConnection) {
    response.cookies.set(COOKIE_NAME, accessToken, COOKIE_OPTS)
  }
  return response
}
