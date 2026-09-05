# Game of Throwns Draft Assistant

An open-source, local-only Chrome extension that overlays draft recommendations and guarded one-click drafting on ESPN fantasy-football draft rooms.

> This repository contains the extension and ranking-engine code, not a third-party rankings database. The maintainer's local `extension/data/rankings.json`, downloaded source pages, and ingestion script are intentionally excluded from version control. Before loading the extension, provide a rankings file containing only data you are authorized to use; see `extension/data/rankings.example.json` for the schema.

The locally configured 2026 model can blend fields representing:

- DraftSharks full-PPR 3D value, projection range, injury risk, and overall rank.
- FantasyPros full-PPR expert consensus rank.
- First Down Studio Vegas-derived full-PPR projection, converted to value over replacement.
- DraftSharks' ESPN ADP, used as the primary platform-specific timing signal. Use ESPN PPR/12-team ADP when available; Sleeper full-PPR ADP remains a fallback only.

The league preset is 12 teams, 13 rounds, one starting QB, two RB, two WR, one FLEX, one TE, one D/ST, and one kicker. ESPN position maximums are enforced at QB 4, RB 8, WR 8, TE 3, D/ST 3, and K 3; unsupported TQB, IDP, punter, and head-coach positions remain unavailable.

Recommendations are hard-filtered through those exact starter, bench, roster-size, and position-maximum rules. Near the end of the draft, the assistant reserves legal lineup space and will force a missing K, D/ST, or other required starter instead of suggesting a player ESPN can only place on an already-full bench.

## This fork's league profile

Default draft slot: **1**. The 13 snake picks are **1, 24, 25, 48, 49, 72, 73, 96, 97, 120, 121, 144, 145**. There are nine starters and four bench spots. Bench capacity can be stricter than a position cap: eight RBs cannot fit into two RB starters, one FLEX, and four bench spots.

On first use after upgrading from the original league preset, saved lineup settings are migrated, the draft slot resets to 1, and auto-draft is disarmed. Recheck the slot in practice rooms, where ESPN may assign a different slot. Current-profile slot and model choices persist.

The confirmed offensive scoring is 0.04 per passing yard, 4 per passing TD, -2 per interception, 0.1 per rushing or receiving yard, 6 per rushing or receiving TD, and 1 per reception. The passing and receiving TD bonus categories are +2 for 40+ yards and +3 for 50+ yards; all two-point conversion categories are +2. Lost fumbles are -2. Kicking includes 3/4/5/6 points for made field goals of 0–39/40–49/50–59/60+ yards, plus the configured missed-kick penalties. The complete offense, kicking, and D/ST weights are in `extension/lib/scoring.js`, verified against the ESPN league settings and supplied screenshots on September 5, 2026.

The engine consumes already-scored projection totals, source values, and ranks. It does not infer raw statistics from aggregate totals or automatically convert half-PPR ranks into PPR. Optional raw-stat source projections are scored with the exact league weights before reaching the engine. All supplied signals must be generated for full PPR; custom bonuses must be included either in the supplied totals or in the raw-stat source projections. A generic PPR board is an approximation for this league until those bonuses are accounted for.

Rankings must declare `meta.scoring: "ppr"` and `meta.leagueTeams: 12`. Missing, malformed, half-PPR, or explicitly synthetic example data shows an error in the draft room and prevents startup. Do not relabel half-PPR data. The included example has `meta.example: true` and cannot be used as a live ranking board.

## Ranking models

The overlay and settings page expose five interchangeable models:

- **Think · Pro RMV experimental** implements the Extended Pro architecture with the data available locally. It builds a cardinal projection from 65% Vegas and 35% DraftSharks consensus projection, moves at most eight points toward positional FantasyPros ECR, calculates dynamic joint RB/WR/TE/FLEX replacement frontiers, and ranks candidates by the improvement to a completed legal lineup. ESPN ADP affects only categorical wait-versus-draft-now timing. Bench ceiling is separate and capped at ten points. Bench-only selections are blocked until all seven offensive starter assignments are filled; early QB2/TE2 picks are suppressed, and overstocked RB or WR benches receive a strong balance discount. This is an inspectable MVP: FantasyPros raw-stat projections, calibrated ESPN pick distributions, weekly injury availability, and matchup-based K/DST projections are not yet available.
- **Sharp value · new** uses 55% DraftSharks 3D value, 35% FantasyPros full-PPR ECR, and 10% Vegas value over replacement. DraftSharks ceiling and injury data make small adjustments. ESPN ADP controls timing and reach decisions, and a soft RB/WR balance penalty prevents extreme benches.
- **Vegas 80 / DraftSharks 20 · RB/WR priority** uses 80% Vegas value over positional replacement and 20% DraftSharks 3D value. It adds a modest RB/WR scarcity premium and QB discount for this one-QB, single-flex league, while retaining soft roster-balance and duplicate-QB safeguards.
- **Vegas only · positional value** uses Vegas projections as its only player-data signal. It compares each player with the Vegas projection at his positional replacement frontier, preventing raw QB totals from overwhelming scarce RB/WR value. ADP, FantasyPros, and DraftSharks do not affect its order; legal-roster and duplicate-position safeguards still apply.
- **Balanced v0.4 · backup** preserves the prior 55% FantasyPros and 45% Vegas formula, including its original ADP and roster adjustments.

All models retain the same ESPN synchronization, legal-roster filters, auto-draft safeguards, and final-round K/D/ST constraints.

All five models apply a small RB close-call preference. It is worth 0.025 in normalized-score models and 1.5 point-equivalents in Think RMV—enough to favor an RB over a nearly equal WR, but not enough to override a materially stronger player or the soft RB/WR bench-balance controls. In the Vegas-only model, Vegas remains the sole player-data source; this is a league-position adjustment rather than another projection source.

The optional **Block QB/TE through Round 8** button is an eligibility experiment for mock drafts. When enabled, QB and TE are removed from manual recommendations and automatic best-pick selection during rounds 1–8, then restored automatically in round 9. It does not modify any ranking-model weights or player scores, defaults to off, and persists locally until toggled again.

The mutually exclusive **Allow only one QB or TE through Round 8** button starts with both positions eligible. After the roster contains either one QB or one TE, both positions are removed from manual recommendations and automatic best-pick selection until round 9. This also defaults to off and does not modify ranking scores.

When your team is on the clock, the overlay provides a one-click Draft button for both the top recommendation and each of the four alternatives. Manual alternative picks use the same fresh-state validation, cross-tab action lock, ESPN identity check, and search cleanup as the best-pick action. Automatic drafting always selects only the top recommendation.

The Suggestions selector can show the top five overall players or filter the board to QB, RB, WR, TE, D/ST, or K. Position filtering affects only the displayed manual choices; automatic drafting continues to use the unfiltered overall top recommendation.

## Load in Chrome

1. Create `extension/data/rankings.json` using the structure in `extension/data/rankings.example.json` and data you have permission to use.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the `extension` directory in this project.
6. Open or reload an ESPN football draft room.

While your team is on the clock, the overlay enables a **Draft [player] — Pick [number]** button. The action requires one ESPN player-ID match plus matching team and position, two stable draft snapshots, the expected roster count, a known draft slot, and a cross-tab lock keyed by draft and pick. Manual reconciliation, ESPN Autopick, paused/resumed state, stale roster state, or an uncertain prior action disables executable drafting.

After an extension-triggered pick or failed lookup, the ESPN player search is cleared and blurred so the complete available-player board is visible again.

The overlay includes an explicit **Arm auto-draft** / **Disarm auto-draft** button. Each pick gets one stable random trigger with 5–25 seconds remaining, allowing an early selection in a 30-second league while preserving the original late-clock range. The selected trigger is shown only while your team is on the clock. The unattended scheduler registers both a persistent Chrome alarm and an exact timer for the same idempotent action, so switching tabs or suspending the extension worker does not leave a single wake path. At the trigger it activates the ESPN tab, waits 750 ms for ESPN's React UI to resume, and then requires a visible, freshly synchronized page before drafting. This avoids background-tab throttling during 30-second real drafts. Any pick requiring ESPN search still uses a 10-second minimum. If a transient ESPN sync or lookup failure occurs before the safety cutoff, it makes one bounded retry; it never retries after a click or uncertain submission. The arm setting persists locally.

While auto-draft is armed, the extension uses Chrome's system-awake guard so macOS does not sleep even if the display turns off. The guard is released when auto-draft is disarmed, the ESPN tab closes, or the 13-player roster is complete. The ESPN draft tab must remain open and signed in, with a working network connection.

The timer status explicitly shows **OFF**, **ARMED**, or **BLOCKED · ESPN AUTOPICK**. ESPN's own Autopick mode disables its player Draft buttons, so it must be disabled before the extension can submit a recommendation.

## Rankings data and third-party rights

The extension reads `extension/data/rankings.json` locally and does not upload it. This repository does not grant a license to scrape, copy, or redistribute rankings, projections, ADP, or other content from third-party providers. Follow each provider's terms and use an authorized API, export, or independently created dataset. Third-party names and trademarks—including ESPN, FantasyPros, DraftSharks, Sleeper, and First Down Studio—belong to their respective owners; this project is independent and is not endorsed by them.

The example JSON is synthetic and exists only to document the input schema. It is not a usable fantasy ranking board.

## Tests

```sh
npm test
```

Use ESPN Practice Drafts to validate the live selectors. The overlay's **Draft sync** section reports the current pick, detected drafted players, roster count, and visible available-player count. A manual drafted-player control is included as a fallback.

## Practice checklist

1. Supply a real full-PPR rankings file with the metadata above; reload the unpacked extension and the ESPN room.
2. Keep auto-draft disarmed initially. Check the detected slot, roster, available players, and current pick against ESPN.
3. In a 12-team practice draft, verify the slot-one 1/24/25 turn and that D/ST and K remain available for required final slots.
4. Test the 5–25-second trigger window only in a practice room before relying on auto-draft.

Automated tests cover all five models completing a legal 13-player roster, migration, the first-pick turn, timing bounds, and ranking metadata. Live ESPN selectors and click behavior still require a practice-room check.

## Optional raw-stat projections

A player may provide `statProjections` with any of `vegasPoints`, `draftSharksProjection`, and `draftSharksConsensusProjection` as keys. Each value is an object of projected ESPN category counts, for example:

```json
"statProjections": {
  "vegasPoints": { "REC": 80, "REY": 1000, "RETD": 8, "RETD40": 2, "RETD50": 1 }
}
```

This replaces that source's total with 235 league points; it does not add bonuses to an existing total. Omitted categories explicitly mean zero, so supply every category your projection models. Use ESPN-compatible category counts for overlapping TD/missed-field-goal categories; this module does not infer which counters an event qualifies for. For D/ST points/yards-allowed categories, provide expected games in each bucket, not season totals. Unknown categories and invalid counts produce a visible data error. ECR, ADP, and DraftSharks 3D values remain independent source inputs and are never converted from these totals.
