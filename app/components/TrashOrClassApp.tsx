'use client'

import { useState, useCallback, useEffect } from 'react'
import { usePlaidLink } from 'react-plaid-link'
import type { AnalysisResult, RestaurantScore } from '@/app/api/plaid/analyze/route'

type AppState = 'checking-session' | 'idle' | 'fetching-token' | 'ready' | 'analyzing' | 'done' | 'error'

// Background gradient driven by quality word (the most "vibes" dimension)
const QUALITY_STYLES: Record<string, { bg: string; accent: string }> = {
  Trash:   { bg: 'from-red-950 to-black',     accent: 'text-red-400' },
  Chic:    { bg: 'from-emerald-950 to-black', accent: 'text-emerald-400' },
  Gourmet: { bg: 'from-yellow-950 to-black',  accent: 'text-yellow-400' },
}

const WORD_META: Record<string, { emoji: string; label: string }> = {
  Chaotic:   { emoji: '💸', label: 'Spend' },
  Casual:    { emoji: '💰', label: 'Spend' },
  Refined:   { emoji: '💎', label: 'Spend' },
  Trash:     { emoji: '🗑️', label: 'Quality' },
  Chic:      { emoji: '✨', label: 'Quality' },
  Gourmet:   { emoji: '👑', label: 'Quality' },
  Chef:      { emoji: '👨‍🍳', label: 'Lifestyle' },
  Goblin:    { emoji: '🛋️', label: 'Lifestyle' },
  Socialite: { emoji: '🥂', label: 'Lifestyle' },
}

function StarBar({ score }: { score: number }) {
  const pct = Math.min(100, (score / 5) * 100)
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2 bg-white/10 rounded-full overflow-hidden">
        <div className="h-full bg-white/60 rounded-full transition-all duration-700" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-white/70 text-sm w-8 text-right">{score.toFixed(1)}</span>
    </div>
  )
}

function PriceBar({ score }: { score: number }) {
  const pct = Math.min(100, (score / 4) * 100)
  const label = score < 1.5 ? '$' : score < 2.5 ? '$$' : score < 3.5 ? '$$$' : '$$$$'
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2 bg-white/10 rounded-full overflow-hidden">
        <div className="h-full bg-white/60 rounded-full transition-all duration-700" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-white/70 text-sm w-8 text-right">{label}</span>
    </div>
  )
}

function RestaurantRow({ r }: { r: RestaurantScore }) {
  const [open, setOpen] = useState(false)
  const displayName = r.yelpName ?? r.name
  const showMerchantSubtext = r.yelpName && r.yelpName !== r.name
  const hasMultiple = r.transactions.length > 1

  return (
    <div className="border-b border-white/5 last:border-0">
      <div className="flex items-center justify-between py-3">
        <div className="flex-1 min-w-0">
          {r.yelpUrl ? (
            <a
              href={r.yelpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-white text-sm font-medium truncate hover:underline block"
            >
              {displayName}
            </a>
          ) : (
            <p className="text-white text-sm font-medium truncate">{displayName}</p>
          )}
          <p className="text-white/40 text-xs mt-0.5">
            {showMerchantSubtext && <span className="mr-2">{r.name}</span>}
            {r.visits} visit{r.visits !== 1 ? 's' : ''} · ${r.totalSpend.toFixed(2)}
            {r.yelpPriceLabel && <span> · {r.yelpPriceLabel}</span>}
          </p>
        </div>
        <div className="flex items-center gap-3 ml-4 shrink-0">
          {r.yelpRating !== null && (
            <span className="text-sm text-white/80">★ {r.yelpRating}</span>
          )}
          {hasMultiple && (
            <button
              onClick={() => setOpen(v => !v)}
              className="text-white/30 hover:text-white/60 transition-colors text-xs"
            >
              {open ? '▲' : '▼'}
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="pb-3 space-y-1">
          {r.transactions.map((tx, i) => (
            <div key={i} className="flex justify-between text-xs text-white/40 pl-2">
              <span>{tx.date}</span>
              <span>${tx.amount.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SpendBreakdown({ data }: { data: AnalysisResult }) {
  const buckets = [
    { label: 'Groceries', amount: data.groceriesSpend },
    { label: 'Delivery Apps', amount: data.deliverySpend },
    { label: 'Bars & Restaurants', amount: data.restaurantSpend },
  ]
  const total = data.totalFoodSpend || 1

  return (
    <div className="bg-white/5 rounded-2xl p-6 space-y-4">
      <div className="flex justify-between items-baseline">
        <p className="text-white/50 text-xs uppercase tracking-wider">Spending Breakdown</p>
        <p className="text-white/50 text-xs">${data.totalFoodSpend.toFixed(2)} total</p>
      </div>
      <div className="space-y-4">
        {buckets.map(({ label, amount }) => {
          const pct = (amount / total) * 100
          return (
            <div key={label} className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-white/70">{label}</span>
                <span className="text-white/50">${amount.toFixed(2)} · {pct.toFixed(0)}%</span>
              </div>
              <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-white/50 rounded-full transition-all duration-700"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function RestaurantTabs({ restaurants }: { restaurants: RestaurantScore[] }) {
  const [tab, setTab] = useState<'matched' | 'unmatched'>('matched')
  const matched = restaurants.filter(r => r.yelpRating !== null)
  const unmatched = restaurants.filter(r => r.yelpRating === null)
  const [showAll, setShowAll] = useState(false)

  const active = tab === 'matched' ? matched : unmatched
  const visible = showAll ? active : active.slice(0, 8)

  return (
    <div className="bg-white/5 rounded-2xl p-6">
      {/* Tab bar */}
      <div className="flex gap-1 mb-5 bg-white/5 rounded-xl p-1">
        {(['matched', 'unmatched'] as const).map(t => (
          <button
            key={t}
            onClick={() => { setTab(t); setShowAll(false) }}
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              tab === t ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/60'
            }`}
          >
            {t === 'matched' ? `Rated (${matched.length})` : `Unmatched (${unmatched.length})`}
          </button>
        ))}
      </div>

      {active.length === 0 ? (
        <p className="text-white/30 text-sm text-center py-4">None</p>
      ) : (
        <>
          {visible.map(r => <RestaurantRow key={r.name} r={r} />)}
          {active.length > 8 && (
            <button
              onClick={() => setShowAll(v => !v)}
              className="mt-4 text-xs text-white/40 hover:text-white/70 transition-colors"
            >
              {showAll ? 'Show less' : `+ ${active.length - 8} more`}
            </button>
          )}
        </>
      )}
    </div>
  )
}

function Results({ data, onDisconnect }: { data: AnalysisResult; onDisconnect: () => void }) {
  const qs = QUALITY_STYLES[data.qualityWord] ?? QUALITY_STYLES['Chic']

  const priceLabel = data.classScore < 1.5 ? '$' : data.classScore < 2.5 ? '$$' : data.classScore < 3.5 ? '$$$' : '$$$$'
  const total = data.totalFoodSpend || 1
  const lifestyleBuckets = [
    { label: 'Dining', amount: data.restaurantSpend, pct: Math.round((data.restaurantSpend / total) * 100) },
    { label: 'Delivery', amount: data.deliverySpend, pct: Math.round((data.deliverySpend / total) * 100) },
    { label: 'Groceries', amount: data.groceriesSpend, pct: Math.round((data.groceriesSpend / total) * 100) },
  ].sort((a, b) => b.pct - a.pct)

  return (
    <div className={`min-h-screen bg-gradient-to-b ${qs.bg} px-8 py-16`}>
      <div className="max-w-5xl mx-auto space-y-10">

        {/* Three-word verdict title — full width */}
        <div className="text-center space-y-4">
          <p className="text-white/40 text-sm uppercase tracking-widest">Your Verdict</p>
          <h1 className="text-6xl font-black tracking-tight leading-tight">
            <span className="text-white">{data.spendWord} </span>
            <span className={qs.accent}>{data.qualityWord}</span>
            <span className="text-white"> {data.lifestyleWord}</span>
          </h1>
          <p className="text-white/60 text-base leading-relaxed max-w-sm mx-auto">{data.tagline}</p>
        </div>

        {/* Two-column body */}
        <div className="grid grid-cols-2 gap-6 items-start">

          {/* Left: score cards */}
          <div className="space-y-4">
            {/* Spend */}
            <div className="bg-white/5 rounded-2xl p-6">
              <p className="text-white/40 text-xs uppercase tracking-wider mb-1">Spend</p>
              <p className="text-xl font-bold text-white mb-4">
                {WORD_META[data.spendWord].emoji} {data.spendWord}
              </p>
              <PriceBar score={data.classScore} />
              <p className="text-white/30 text-xs mt-3">Avg price tier · {priceLabel}</p>
            </div>

            {/* Quality */}
            <div className="bg-white/5 rounded-2xl p-6">
              <p className="text-white/40 text-xs uppercase tracking-wider mb-1">Quality</p>
              <p className={`text-xl font-bold mb-4 ${qs.accent}`}>
                {WORD_META[data.qualityWord].emoji} {data.qualityWord}
              </p>
              <StarBar score={data.starScore} />
              <p className="text-white/30 text-xs mt-3">Avg Yelp rating · {data.totalDiningTransactions} restaurant visits</p>
            </div>

            {/* Lifestyle */}
            <div className="bg-white/5 rounded-2xl p-6">
              <p className="text-white/40 text-xs uppercase tracking-wider mb-1">Lifestyle</p>
              <p className="text-xl font-bold text-white mb-4">
                {WORD_META[data.lifestyleWord].emoji} {data.lifestyleWord}
              </p>
              <div className="space-y-3">
                {lifestyleBuckets.map(({ label, amount, pct }) => (
                  <div key={label} className="space-y-1.5">
                    <div className="flex justify-between text-xs">
                      <span className="text-white/60">{label}</span>
                      <span className="text-white/50">${amount.toFixed(2)} · {pct}%</span>
                    </div>
                    <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                      <div className="h-full bg-white/50 rounded-full transition-all duration-700" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-white/30 text-xs mt-3">${data.totalFoodSpend.toFixed(2)} total food spend</p>
            </div>
          </div>

          {/* Right: highlights + restaurant list */}
          <div className="space-y-4">
            {/* Crown jewel + worst offender */}
            {(data.crownJewel || data.worstOffender) && (
              <div className="grid grid-cols-2 gap-3">
                {data.crownJewel && (
                  <div className="bg-white/5 rounded-2xl p-5 space-y-1">
                    <p className="text-white/40 text-xs uppercase tracking-wider">Crown Jewel</p>
                    <p className="text-white font-semibold text-sm leading-snug">{data.crownJewel.yelpName ?? data.crownJewel.name}</p>
                    <p className={`text-sm font-bold ${qs.accent}`}>★ {data.crownJewel.yelpRating} {data.crownJewel.yelpPriceLabel}</p>
                  </div>
                )}
                {data.worstOffender && data.worstOffender.name !== data.crownJewel?.name && (
                  <div className="bg-white/5 rounded-2xl p-5 space-y-1">
                    <p className="text-white/40 text-xs uppercase tracking-wider">Dragging You Down</p>
                    <p className="text-white font-semibold text-sm leading-snug">{data.worstOffender.yelpName ?? data.worstOffender.name}</p>
                    <p className="text-white/60 text-sm font-bold">★ {data.worstOffender.yelpRating} {data.worstOffender.yelpPriceLabel}</p>
                  </div>
                )}
              </div>
            )}

            {/* Restaurant list */}
            <RestaurantTabs restaurants={data.restaurants} />
          </div>
        </div>

        <button
          onClick={onDisconnect}
          className="text-white/20 text-xs hover:text-white/50 transition-colors"
        >
          Disconnect account
        </button>
      </div>
    </div>
  )
}

export default function TrashOrClassApp() {
  const [state, setState] = useState<AppState>('checking-session')
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // On mount, check if there's a saved session and skip Plaid Link if so
  useEffect(() => {
    fetch('/api/plaid/session')
      .then(r => r.json())
      .then(({ connected }) => setState(connected ? 'ready-saved' as AppState : 'idle'))
      .catch(() => setState('idle'))
  }, [])

  const runAnalysis = useCallback(async (public_token?: string) => {
    setState('analyzing')
    setError(null)
    try {
      const res = await fetch('/api/plaid/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(public_token ? { public_token } : {}),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? 'Analysis failed')
      }
      setResult(await res.json())
      setState('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
      setState('error')
    }
  }, [])

  const handleDisconnect = async () => {
    await fetch('/api/plaid/session', { method: 'DELETE' })
    setResult(null)
    setError(null)
    setState('idle')
  }

  // usePlaidLink must be called unconditionally at the top level so React
  // Strict Mode's mount/unmount/remount cycle doesn't embed the script twice.
  const onSuccess = useCallback((public_token: string) => {
    runAnalysis(public_token)
  }, [runAnalysis])

  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess })

  const handleConnect = async () => {
    setState('fetching-token')
    try {
      const res = await fetch('/api/plaid/link-token', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to initialize')
      const { link_token } = await res.json()
      setLinkToken(link_token)
      setState('ready')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start')
      setState('error')
    }
  }

  if (state === 'done' && result) {
    return <Results data={result} onDisconnect={handleDisconnect} />
  }

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center px-6">
      <div className="max-w-sm w-full text-center space-y-10">
        <div className="space-y-4">
          <p className="text-5xl">🍽️</p>
          <h1 className="text-5xl font-black text-white tracking-tight">
            Trash<br />or<br />Class
          </h1>
          <p className="text-white/50 text-base leading-relaxed">
            Connect your bank account and we&apos;ll analyze your restaurant history to deliver the verdict on your dining life.
          </p>
        </div>

        <div className="space-y-4">
          {state === 'checking-session' && (
            <div className="py-4">
              <p className="text-white/40 text-sm animate-pulse">Loading...</p>
            </div>
          )}

          {state === 'idle' && (
            <button
              onClick={handleConnect}
              className="w-full py-4 px-8 bg-white text-black font-bold text-lg rounded-2xl hover:bg-white/90 transition-all"
            >
              Get My Verdict
            </button>
          )}

          {state === 'fetching-token' && (
            <div className="py-4">
              <p className="text-white/40 text-sm animate-pulse">Preparing your trial...</p>
            </div>
          )}

          {state === 'ready' && (
            <button
              onClick={() => open()}
              disabled={!ready}
              className="w-full py-4 px-8 bg-white text-black font-bold text-lg rounded-2xl hover:bg-white/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Connect My Bank
            </button>
          )}

          {(state as string) === 'ready-saved' && (
            <div className="space-y-3">
              <button
                onClick={() => runAnalysis()}
                className="w-full py-4 px-8 bg-white text-black font-bold text-lg rounded-2xl hover:bg-white/90 transition-all"
              >
                Get My Verdict
              </button>
              <button
                onClick={handleDisconnect}
                className="text-white/30 text-sm hover:text-white/60 transition-colors"
              >
                Disconnect account
              </button>
            </div>
          )}

          {state === 'analyzing' && (
            <div className="text-center space-y-4">
              <div className="inline-flex gap-1">
                {['🍕', '🍣', '🥗', '🍔', '🌮'].map((e, i) => (
                  <span
                    key={i}
                    className="text-3xl animate-bounce"
                    style={{ animationDelay: `${i * 120}ms` }}
                  >
                    {e}
                  </span>
                ))}
              </div>
              <p className="text-white/60 text-sm">Reviewing your culinary crimes...</p>
            </div>
          )}

          {state === 'error' && (
            <div className="space-y-3">
              <p className="text-red-400 text-sm">{error}</p>
              <button
                onClick={() => { setState('idle'); setError(null) }}
                className="text-white/40 text-sm hover:text-white/70 transition-colors"
              >
                Try again
              </button>
            </div>
          )}
        </div>

        <div className="flex justify-center gap-8 text-center">
          {[
            { emoji: '★', label: 'Quality Score' },
            { emoji: '$', label: 'Class Score' },
            { emoji: '🏆', label: 'The Verdict' },
          ].map(({ emoji, label }) => (
            <div key={label} className="space-y-1">
              <p className="text-white/20 text-2xl">{emoji}</p>
              <p className="text-white/30 text-xs">{label}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
