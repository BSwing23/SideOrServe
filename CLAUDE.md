# CLAUDE.md — Side or Serve (powered by GASA)

## Project Overview
Side or Serve is a beach volleyball analytics app for coaches. It answers one question at the coin toss: receive first, or take a side? The app tracks real-time match data (P7 side analysis, server stats, real points) and gives a mathematically grounded recommendation based on observed data — no predictive models, no defaults, no smoothing.

The app is a single-file HTML/JS/CSS application deployed on Netlify at sideorserve.netlify.app. Backend is Firebase Firestore. No build step — edit index.html, commit, Netlify auto-deploys.

---

## Non-Negotiable Rules

### Before Every Deploy
Run a syntax check. No exceptions.
```python
python3 -c "
import re
with open('index.html') as f:
    content = f.read()
scripts = re.findall(r'<script[^>]*>(.*?)</script>', content, re.DOTALL)
js = ' '.join(scripts)
o,c = js.count('{'), js.count('}')
bt = js.count('\`')
from collections import Counter
dupes = [f for f,n in Counter(re.findall(r'function\s+(\w+)\s*\(', js)).items() if n > 1]
print(f'Braces {o}/{c} diff={o-c}')
print(f'Backticks {bt} OK={bt%2==0}')
print(f'Duplicate functions: {dupes if dupes else \"none\"}')
"
```

### Do Not Remove Without Permission
Never delete existing functions, event handlers, or features without explicit instruction. When rewriting a block, audit what you are replacing line by line. Missing onclick handlers, dropped function declarations, and lost features have been the single biggest source of rework in this project.

### Read Before Writing
Before modifying any existing function, read the full function first. If you cannot summarize what it currently does, you do not understand it well enough to change it.

### One Thing at a Time
Fix one issue per deployment. Do not bundle multiple changes unless explicitly asked. This prevents compounding failures.

---

## Color Palette — Strict
The palette is: **Crimson, Gray, White, Black only.**

Allowed values:
- Crimson: `#981E32`, `rgba(152,30,50,x)`
- White: `#FFFFFF`, `white`, `rgba(255,255,255,x)`
- Gray: `rgba(0,0,0,x)`, `rgba(80,80,80,x)`, `rgba(255,255,255,0.06–0.20)`
- Black: `#000000`, `black`

**Absolutely forbidden:**
- Gold / yellow: `#FFB300`, `#FFD700`, `#ffd54f`, `rgba(255,179,0,x)`
- Orange: `#ff7043`, `#FF6600`
- Any shade of green: `#4CAF50`, `#90EE90`, `#2ecc71`, `rgba(76,175,80,x)`, etc.
- Any color not in the above palette

When a positive indicator needs emphasis, use **white text** or a **white border outline**. Use `rgba(255,255,255,0.10)` for subtle highlight backgrounds. Use `rgba(220,80,80,0.9)` for negative/loss indicators (muted crimson, not orange).

---

## Architecture

### Single File
Everything lives in `index.html` — HTML, CSS, JavaScript, Firebase config. No npm, no build system.

### Firebase / Firestore
- Auth: Google OAuth + email/password
- Database: Firestore
- Collections: `players/{uid}`, `matches/{matchId}`, `sets/{setId}`, `venueStats/{venueId}`

**Critical Firestore rule** — the `sets` collection requires this rule or all data tab queries will fail with permission-denied:
```
match /sets/{setId} {
  allow read, write: if request.auth != null &&
    request.auth.uid == resource.data.userId;
}
```

**Query pattern:** Always use `where('userId', '==', currentUser.uid)` — not `owners array-contains`. The `owners` array-contains pattern requires a composite index and a different security rule that is not configured.

**`venueStats` rule** — required for pooled community venue data (see "Pooled Venue Stats" below) or every write/read against it fails with permission-denied:
```
match /venueStats/{venueId} {
  allow read: if request.auth != null;
  allow write: if request.auth != null;
}
```
Unlike `sets`, this is intentionally readable/writable by *any* authenticated subscriber, not just the owner — that's the whole point (cross-subscriber pooling). This trusts the client not to corrupt the pool; there's no per-write validation beyond requiring auth, same trust model as the rest of this app's client-driven stats.

### Paired Partner Data Sharing
When a match is scored with a paired partner selected (`selectedPairedPartner`), `saveSetToFirestore()` writes a second, full mirror of the set document under the partner's own `userId` (not just a reference pointer) — "you"/"partner" fields (playerName/partnerName, playerRole/partnerRole, serverStats.you/partner) are swapped so it reads correctly as the partner's own set. `updateRPStats()` similarly applies the identical `updates` object to the partner's own `players/{partnerId}` doc, since every field it builds (ourTeam/opponents/winners/losers/roleBattle/momentum/etc.) is team-level, never per-player. This is necessary because every stats query in this app filters `where('userId','==',currentUser.uid)` — per the `owners array-contains` prohibition below — so a reference pointer alone (which is what `matches` collection sharing uses, and works fine since `showMatchHistory()` explicitly reads it) is not enough for the Data tab to reflect a partner's matches; only a real second document under the partner's own account does that. Both mirror writes are best-effort (wrapped in their own try/catch) and never block the scorekeeper's own save. Requires the Firestore rule changes documented in BACKLOG.md's "Partner Data Sharing" entry.

### Pooled Venue Stats (cross-subscriber)
`updatePooledVenueStats()` / `fetchPooledVenueStats()` (in `index.html`) build a shared, aggregate-only database of side/weather effects at built-in venues, pooled across every subscriber — not just the current user. Scoped by venue + competition tier + Swingle Scale wind level. Custom venues are deliberately excluded: a custom venue's id (`custom-0`, `custom-1`, ...) is just an index into *that specific user's* own venue list, not globally unique, so pooling them would silently merge unrelated courts. Displayed as "🌐 Community Data" inside the Side Bias section of the Data tab. No raw per-set data is exposed or attributable to any individual user — only summed point totals per venue/tier/wind-level bucket.

### Firestore Data Architecture
Each set is saved as its own document in the `sets` collection. Match documents are lightweight headers only. Set documents contain all analytics: `serverStats`, `completedSegments`, `p7Stats`, `longestRuns`, `weatherAtSetStart`, `ourRealPoints`, `theirRealPoints`, `roleBattle`, `servedFirst`, `receivedFirst`.

---

## Core Calculation Engine

### The Fundamental Product Thesis
**Receive first is always the default.** The structural advantage of receiving first (requiring one fewer real point to win) outweighs minor or moderate weather conditions. Side only overrides receive if:
1. Observed net side advantage in points > observed receive advantage in points, AND
2. Swingle Scale >= 4 (13+ mph wind)

Both conditions must be true. A light breeze never overrides the structural receive edge.

### No Theoretical Defaults
**Never use hardcoded fallbacks for RP calculations.** If there is no historical data, show nothing or pull from in-match data. The values 7 (for 21-pt) and 5 (for 15-pt) must never appear as silent fallbacks. After Set 1 completes, real data exists — use it.

### calculateRPsToWin()
Returns observed average loser RPs + 1 from `rpStats.sets21.losers` (or sets15). Falls back to current match in-memory sets if no all-time data. Returns `null` if truly no data.

### calculateReceiveAdvantage()
Pure arithmetic from observed N:
- Receive scenario: win at N–(N-1), requires N/(2N-1) of all RPs
- Serve scenario: win at N–(N-2), requires N/(2N-2) of all RPs
- Advantage = servePct − receivePct (percentage points)

### calculateNetSideAdvantage()
Strict mechanical exposure weighting:
- Converts P7 differential to per-point rate: `ptDiff = p7Diff / switchInterval`
- Counts full segments alternating between sides
- Remainder is exact extra points × per-point rate
- When remainder === 0, net extra evaluates to exactly 0 (no phantom advantage)

### P5 = P7 × (5/7) for Deciding Sets
For Set 3 (15-point deciding sets), scale P7 differentials by 5/7 before passing to `calculateNetSideAdvantage`. This uses the robust 21-pt data pool to project Set 3 efficiency without waiting for a standalone 15-pt sample.

### receiveAdvantagePoints Conversion
**No /10 arbitrary conversion.** Derive receive advantage in points as:
```javascript
const receiveAdvantagePoints = (receiveAdv.servePct - receiveAdv.receivePct) / 100 * projectedTotal;
```
Where `projectedTotal` comes from observed `rpStats.totalPointsSum / rpStats.competitiveCount`, with 28/40 as a last-resort fallback only when zero sets have been played.

---

## Wind / Weather

### Swingle Scale
Wind is characterized using the Swingle Scale — the Beaufort 0–12 levels reframed specifically for how wind affects a 270mm volleyball on a 16×8m sand court. It is not a general wind scale. Brian Swingle created it.

### Wind Direction Bug (Fixed)
Meteorological wind direction reports where wind comes FROM. The cosine projection for court-side components needs where it goes TO (+180°). This was inverted for months and has been corrected. Do not revert this.

### Weather Capture
`matchState.weatherAtSetStart` is captured in `initializeLiveMatch()` at the start of each set. This is the correct moment — it locks in conditions at the beginning, not the end. Do not move this capture point.

---

## UI Rules

### Live Screen Layout Order (Top to Bottom)
1. Score banner
2. Previous sets bar
3. Scope buttons (This Set / This Match / All Time)
4. Player scoring cards (immediate action zone)
5. Win probability
6. Momentum / streak
7. Control buttons (Undo, Force Switch, Force End, Home, Cancel)
8. Tip text box

### Button Styles
- Primary buttons (score points): white background, crimson text
- Secondary buttons (Undo, Force Switch): `rgba(255,255,255,0.15)` background
- Destructive/utility buttons (Force End, Cancel): `rgba(0,0,0,0.2)` background, white border, white text
- No emoji icons on destructive buttons
- No yellow warning icons anywhere

### Coin Toss Tab Hero Directive
The top of the Coin Toss tab shows a large, high-contrast directive:
- "CHOOSE RECEIVE FIRST" (white text, default)
- "PUT [PLAYER NAME] ON THE [SIDE] SIDE" (white text, State B override only)
Followed by a collapsible "Why?" button that reveals the raw calculation details.

### Data Tab
All 8 permutations (4 scopes × 21/15 toggle) show the same sections in the same order. Never show different sections for different scopes.

Sections in order:
1. What the Data Says (leading recommendation)
2. RP Averages
3. Side Analysis (live) + Side Advantage (historical)
4. Server Performance
5. Role Matchup
6. Momentum
7. Role Battle Win %
8. Serve/Receive Win %
9. Side Bias
10. Coin Toss Advantage

---

## Known Issues / Backlog

### Outstanding
- GPS detection radius is 400m, should be 150-200m
- Partner match count shows 0 (needs to count from sets collection)
- Side Advantage section errors if Firestore `sets` rule not published
- All Time server stats depend on Firestore rule being active

### Do Not Reintroduce
- Green colors (has been fixed repeatedly — do not let them back in)
- Theoretical defaults in RP calculations
- `/10` arbitrary conversion for receive advantage points
- `owners array-contains` Firestore queries (use `userId ==`)
- Duplicate variable declarations (`const rW`, `const set1`, etc.) that cause load failures

---

## Deployment
1. Edit `index.html`
2. Run syntax check (see above)
3. Commit: `git add index.html && git commit -m "description of change"`
4. Netlify auto-deploys on push to main

Site: sideorserve.netlify.app
Firebase project: (check existing config in index.html)

---

## Key People
- **Brian Swingle** — founder, 30 years coaching experience, creator of the Swingle Scale and the receive-first mathematical framework
- **Alex Simons** — retired Microsoft VP, validated receive-first framework with 5,000+ NCAA DI matches
- **Gemini** — acting as project manager in parallel sessions

## Background Reading
For full context on the mathematical framework, search this conversation history for:
- "GASA6 receive-first advantage"
- "Swingle Scale development"
- "P7 side analysis"
- "Real Points framework"
