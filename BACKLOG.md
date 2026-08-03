# Side or Serve — Backlog

## Critical (Blocks Data Accuracy)

### Set 2 Auto-Complete Not Firing
In Set 2, one team's first server is deferred until their first sideout. When that sideout occurs, `scorePoint()` returns early — before reaching `checkSetComplete()` — to show the server-selection overlay. After the user picks a server, `selectOtherTeamFirstServer()` resumed play but only called `updateMatchDisplay()`, never `checkSetComplete()`. If the set-winning point caused that sideout, the win was permanently skipped. The match continued as an open set, and Force End then created a phantom 3rd set, corrupting the match score (showing 3-0 instead of 2-0).

**Fix:** Added `checkSetComplete()` after `updateMatchDisplay()` in `selectOtherTeamFirstServer()` (~line 4758).
**Status:** Fixed in commit `2d2a505` — pending push.

---

### Firestore Undefined Field on Save — sanitize() Not Running
In `saveSetToFirestore`, the `sanitize()` function built a correct `out` object replacing `undefined` values with `null`, but then returned the original `obj` instead of `out`. The sanitize was a no-op for all nested objects, leaving `undefined` fields that Firestore rejected with "Unsupported field value: undefined". Affected every `.add()` and `.update()` call on the sets collection.

**Fix:** Changed `return obj === undefined ? null : obj` to `return out` inside the object branch of `sanitize()` (~line 5230).
**Status:** Fixed in commit `2d2a505` — pending push.

---

### Firestore Sets Rule Not Published
Side Advantage, Server Performance (All Time), and Today data all fail with permission-denied if this rule is not in Firebase console:
```
match /sets/{setId} {
  allow read, write: if request.auth != null &&
    request.auth.uid == resource.data.userId;
}
```
**Status:** Rule written, needs verification it was saved/published.

---

## High Priority (Affects Usability)

### All Time Server Stats Blank
The All Time tab on the live screen fetches from Firestore but shows zeroes if the sets rule above is not active. Once rule is confirmed, this should self-resolve.

### Partner Match Count Shows 0
The partner display shows "0 matches" because it reads from an old `totalMatches` field on the partner doc rather than counting shared set documents. Fix: query `sets` where `userId == uid`, filter for sets where `owners` includes partner UID, count results.

### GPS Detection Radius Too Large
Currently 400m. Should be 150-200m so venue auto-detection doesn't trigger for nearby but incorrect courts.

---

## Medium Priority (Polish)

### Set Detail in History — P7 Data Format
The set detail view (tap a set row in history) shows P7 averages but they're stored in different formats across old vs new set docs. Needs normalization.

### Weather at Set Start — Verify Capture
`weatherAtSetStart` is captured in `initializeLiveMatch()`. Verify it's actually populating in Firestore set documents — earlier sessions showed it may be storing null silently when weather wasn't fetched before the set started.

### Preferred Side Mismatch Callout
The "preferred side didn't match data" callout on the data tab — decision was deferred on whether to keep or remove. Brian was leaning toward removing it since coin toss recommendation already answers the real question.

---

## Future Features (Post-Launch)

### Sun Position Calculation
Court orientation + venue GPS + time of day → which side has sun glare when serving. Data available, calculation not implemented. Brian's position: add when P7 data is robust enough (10-15 sets at a venue) to use sun as a tiebreaker.

### Wind Modifying Side Advantage Calculation
Currently wind is informational only. Wind components (headwind/tailwind) could modify the P7 differential — a tailwind side should be worth more in high wind conditions. Swingle 4+ threshold is the gate.

### Role Battle Win % Display
- When your blocker wins PS battle: you win X% of sets
- When your defender wins PS battle: you win X% of sets
Tracking is implemented. Display exists but needs more data to be meaningful.

### Serve/Receive Win % Historical
Tracking is implemented in sets15/sets21 buckets. Display exists. Needs more data.

### Side Bias by Compass Direction
`rpStats.sidePoints.{north/south/east/west}` — total points scored on each side regardless of team. Tracking implemented, display exists in Data tab.

### Momentum Split by Set Type
`rpStats.momentum` is a single pool, not split by 21pt/15pt. Low priority until data volume justifies it.

### Persist Data Tab Drawer Open/Closed State
Data tab stat-box sections are now collapsible drawers (default collapsed). State is not persisted — every `updateDataTab()` re-render (scope change, tier/venue filter change, reload) resets all drawers to collapsed. Could track open section titles in a Set and re-apply `stat-box-expanded` after render if this becomes annoying in practice.

---

## Known Do-Not-Touch Items

- Wind direction calculation: `windTravelDeg = (windDegrees + 180) % 360` — this was inverted for months, corrected, do not revert
- `matchState.weatherAtSetStart` capture in `initializeLiveMatch()` — correct location, do not move
- `/10` conversion for receive advantage — eliminated, do not reintroduce
- `owners array-contains` queries — replaced with `userId ==`, do not switch back
- Color palette — crimson/gray/white/black only, no gold, no green, no orange

---

## Data Model Notes

### Sets Collection Document Fields
```
userId, matchId, setNumber, gameType ('regular'|'deciding')
ourScore, theirScore, ourRealPoints, theirRealPoints
playerName, partnerName, opponent1Name, opponent2Name
playerRole, partnerRole, opponent1Role, opponent2Role
serverStats: { you, partner, opp1, opp2 } each: { ps, totalServes, servingTurns }
completedSegments: [{ side, ourPoints, theirPoints, segmentNumber }]
p7Stats: { side1: { name, our:[], their:[] }, side2: ... }
longestRuns: { our, their }
weatherAtSetStart: { swingleScale, beaufortForce, windSpeed, windDescription, windDirection, capturedAt }
roleBattle: { blocker: { total, won }, defender: { total, won } }
servedFirst: { total, won }
receivedFirst: { total, won }
includedInStats: true/false
complete: true/false
createdAt: timestamp
```

### rpStats Structure (on player doc)
```
sets21: {
  ourTeam: { totalRPs, count }
  opponents: { totalRPs, count }
  winners: { totalRPs, count }
  losers: { totalRPs, count }
  servingTeamWins, receivingTeamWins
  totalPointsSum, competitiveCount
  servedFirst: { total, won }
  receivedFirst: { total, won }
  roleBattle: { blocker: { total, won }, defender: { total, won } }
  momentum: { our: {}, their: {}, longestStreak: { total, won } }
}
sets15: (same structure)
sidePoints: { north, south, east, west, northeast, southwest, northwest, southeast }
```
