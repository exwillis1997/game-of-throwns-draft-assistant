(async function startDraftAssistant() {
  "use strict";

  if (window.top !== window || document.getElementById("got-draft-assistant-host")) return;

  const engine = globalThis.DraftAssistantEngine;
  const detector = globalThis.EspnDraftDetector;
  const dataUrl = chrome.runtime.getURL("data/rankings.json");
  let dataset;
  try {
    const response = await fetch(dataUrl);
    if (!response.ok) throw new Error("Provide extension/data/rankings.json with your full-PPR rankings.");
    dataset = await response.json();
    const problem = engine.validateDataset(dataset);
    if (problem) throw new Error(problem);
    dataset = globalThis.DraftAssistantScoring.prepareDataset(dataset);
  } catch (error) {
    const notice = document.createElement("div");
    notice.id = "got-draft-assistant-host";
    notice.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;max-width:360px;padding:20px;background:#172033;color:white;border-radius:12px;font:14px/1.5 sans-serif";
    notice.textContent = "Draft Assistant: rankings unavailable. " + error.message;
    document.body.appendChild(notice);
    return;
  }
  const playersByName = new Map(dataset.players.map((player) => [engine.normalizeName(player.name), player]));
  const stored = await chrome.storage.local.get(["draftAssistantConfig", "manualDrafted"]);
  let config = engine.loadConfig(stored.draftAssistantConfig);
  await chrome.storage.local.set({ draftAssistantConfig: config });
  let manualDrafted = stored.manualDrafted || [];
  const draftSessionId = new URL(window.location.href).searchParams.get("leagueId") || "draft";
  const userTeamId = new URL(window.location.href).searchParams.get("teamId") || "unknown";
  const autoAttemptStorageKey = `got-auto-attempt-v2:${draftSessionId}`;
  const submittedPickStorageKey = `got-submitted-pick:${draftSessionId}`;
  let collapsed = false;
  let lastState = null;
  let draftAttemptInFlight = false;
  let autoAttemptInFlight = false;
  let autoAttemptState;
  try {
    const savedAttempt = JSON.parse(sessionStorage.getItem(autoAttemptStorageKey) || "null");
    autoAttemptState = savedAttempt && typeof savedAttempt === "object"
      ? savedAttempt
      : { pickNumber: null, count: 0, nextRetryAt: 0 };
  } catch {
    autoAttemptState = { pickNumber: null, count: 0, nextRetryAt: 0 };
  }
  let submittedPick = Number(sessionStorage.getItem(submittedPickStorageKey)) || null;
  let uncertainPick = null;
  let stateVersion = 0;
  let lastStateFingerprint = "";
  let resyncBlockedUntil = Date.now() + 500;
  let actionPhase = "IDLE";
  let scheduledAutoDraft = null;
  let schedulerError = "";
  let keepAwakeActive = false;
  let draftCompletionHandled = false;
  const MAX_AUTO_ATTEMPTS = 2;
  const AUTO_RETRY_DELAY_MS = 1500;

  const host = document.createElement("div");
  host.id = "got-draft-assistant-host";
  host.innerHTML = `
    <section class="got-panel" aria-label="Game of Throwns Draft Assistant">
      <header class="got-header">
        <div><span class="got-kicker">GAME OF THROWNS</span><h2>Draft Assistant</h2></div>
        <button class="got-collapse" type="button" aria-label="Collapse draft assistant">−</button>
      </header>
      <div class="got-body">
        <div class="got-status-row">
          <span class="got-status">Connecting to ESPN…</span>
          <label>Draft slot <input class="got-slot" type="number" min="1" max="10" placeholder="1–10"></label>
        </div>
        <div class="got-model-row">
          <label>Ranking model
            <select class="got-model" aria-label="Ranking model">
              <option value="think-rmv">Think · Pro RMV experimental</option>
              <option value="sharp-value">Sharp value · new</option>
              <option value="vegas-sharks-80">Vegas 80 / DraftSharks 20 · RB/WR priority</option>
              <option value="vegas-only">Vegas only · positional value</option>
              <option value="balanced-v04">Balanced v0.4 · backup</option>
            </select>
          </label>
          <label>Suggestions
            <select class="got-position" aria-label="Suggestion position">
              <option value="ALL">All positions</option>
              <option value="QB">QB</option>
              <option value="RB">RB</option>
              <option value="WR">WR</option>
              <option value="TE">TE</option>
              <option value="DST">D/ST</option>
              <option value="K">K</option>
            </select>
          </label>
        </div>
        <div class="got-strategy-row">
          <button class="got-early-block-toggle" type="button" aria-pressed="false">Block QB/TE through Round 8</button>
          <button class="got-early-one-toggle" type="button" aria-pressed="false">Allow only one QB or TE through Round 8</button>
          <span>Optional mock-draft rules; choose at most one. Rankings stay unchanged.</span>
        </div>
        <div class="got-auto-row">
          <button class="got-auto-toggle" type="button" aria-pressed="false">Arm auto-draft</button>
          <label>draft with <input class="got-auto-min" type="number" min="5" max="25" step="1" aria-label="Minimum auto-draft seconds remaining">–<input class="got-auto-max" type="number" min="5" max="25" step="1" aria-label="Maximum auto-draft seconds remaining"> sec left</label>
          <span class="got-clock">ESPN --:--</span>
        </div>
        <div class="got-best"></div>
        <div class="got-turn-plan"></div>
        <div class="got-draft-action"></div>
        <ol class="got-alternatives"></ol>
        <details class="got-debug">
          <summary>Draft sync</summary>
          <div class="got-debug-body"></div>
          <label class="got-manual-label">Manual drafted player
            <span><input class="got-manual" type="text" placeholder="Player name"><button class="got-add" type="button">Add</button></span>
          </label>
          <button class="got-undo" type="button">Undo manual mark</button>
        </details>
        <footer></footer>
      </div>
    </section>`;
  document.body.appendChild(host);

  const $ = (selector) => host.querySelector(selector);
  const slotInput = $(".got-slot");
  const modelSelect = $(".got-model");
  const positionSelect = $(".got-position");
  const earlyBlockToggle = $(".got-early-block-toggle");
  const earlyOneToggle = $(".got-early-one-toggle");
  const autoDraftToggle = $(".got-auto-toggle");
  const autoDraftMinInput = $(".got-auto-min");
  const autoDraftMaxInput = $(".got-auto-max");
  slotInput.value = config.draftSlot || "";
  modelSelect.value = config.rankingModel;
  positionSelect.value = ["ALL", "QB", "RB", "WR", "TE", "DST", "K"].includes(config.suggestionPosition)
    ? config.suggestionPosition
    : "ALL";
  autoDraftMinInput.value = Math.min(25, Math.max(5, Number(config.autoDraftMinSeconds) || 5));
  autoDraftMaxInput.value = Math.min(25, Math.max(Number(autoDraftMinInput.value), Number(config.autoDraftMaxSeconds) || 25));

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function playerCard(player) {
    const vegas = Number.isFinite(player.vegasPoints) ? `${Math.round(player.vegasPoints)} Vegas pts` : "No Vegas projection";
    const ecr = Number.isFinite(player.fantasyProsRank) ? `ECR ${player.fantasyProsRank}` : "No ECR";
    const draftSharks = Number.isFinite(player.draftSharks3dValue) ? `DS 3D ${Math.round(player.draftSharks3dValue)}` : "No DS 3D value";
    const timingAdp = Number.isFinite(player.espnAdp) ? player.espnAdp : player.sleeperAdp;
    const adp = Number.isFinite(timingAdp) ? `${Number.isFinite(player.espnAdp) ? "ESPN" : "Sleeper"} ADP ${timingAdp}` : "No ADP";
    const metrics = player.rankingModel === "think-rmv"
      ? `<span>RMV ${Number(player.rosterMarginalValue || 0).toFixed(1)}</span><span>Proj ${Number(player.adjustedProjection || 0).toFixed(1)}</span><span>${adp}</span><span>${escapeHtml(player.survivalCategory || "unknown")}</span>`
      : player.rankingModel === "vegas-only"
        ? `<span>${vegas}</span><span>${Number.isFinite(player.vorp) ? `${Math.round(player.vorp)} VORP` : "No VORP"}</span>`
      : player.rankingModel === "sharp-value" || player.rankingModel === "vegas-sharks-80"
        ? `<span>${draftSharks}</span><span>${ecr}</span><span>${vegas}</span><span>${adp}</span>`
        : `<span>${ecr}</span><span>${vegas}</span><span>${adp}</span>`;
    return `
      <div class="got-player-title"><strong>${escapeHtml(player.name)}</strong><span>${escapeHtml(player.team || "FA")} · ${escapeHtml(player.position)}</span></div>
      <div class="got-metrics">${metrics}</div>
      <p>${escapeHtml(player.reason)}</p>`;
  }

  function espnSnapshot() {
    const snapshot = detector.snapshot(document, config.teams);
    return {
      ...snapshot,
      roster: snapshot.roster.map((player) => {
        const canonical = playersByName.get(engine.normalizeName(player.name));
        return canonical
          ? { name: canonical.name, position: canonical.position }
          : player;
      }),
    };
  }

  async function saveConfig() {
    await chrome.storage.local.set({ draftAssistantConfig: config });
  }

  async function safeRuntimeMessage(message) {
    try {
      if (!chrome.runtime?.id) return null;
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  }

  function saveAutoAttemptState() {
    sessionStorage.setItem(autoAttemptStorageKey, JSON.stringify(autoAttemptState));
  }

  async function syncKeepAwake() {
    const result = await safeRuntimeMessage({ type: "got-keep-awake:set", enabled: Boolean(config.autoDraftEnabled) });
    keepAwakeActive = Boolean(result?.ok && config.autoDraftEnabled);
    if (config.autoDraftEnabled && !result?.ok) schedulerError = "Mac awake guard unavailable";
    scheduleRender();
  }

  function autoDraftBounds() {
    const minimum = Math.min(25, Math.max(5, Number(config.autoDraftMinSeconds) || 5));
    const maximum = Math.min(25, Math.max(minimum, Number(config.autoDraftMaxSeconds) || 25));
    return { minimum, maximum };
  }

  function randomUnit() {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return value[0] / 4294967296;
  }

  function autoTriggerForPick(pickNumber, targetIsVisible) {
    if (!pickNumber) return null;
    const key = `got-auto-trigger:${draftSessionId}:${pickNumber}`;
    let trigger = Number(sessionStorage.getItem(key)) || null;
    if (!trigger || trigger < 5 || trigger > 25) {
      const { minimum, maximum } = autoDraftBounds();
      trigger = engine.chooseTriggerSeconds(minimum, maximum, randomUnit());
      sessionStorage.setItem(key, String(trigger));
    }
    return targetIsVisible ? trigger : Math.max(10, trigger);
  }

  function clearAutoTriggerForPick(pickNumber) {
    if (pickNumber) sessionStorage.removeItem(`got-auto-trigger:${draftSessionId}:${pickNumber}`);
  }

  async function clearBackgroundAutoDraft(pickNumber = scheduledAutoDraft?.pickNumber) {
    if (!pickNumber) return;
    if (scheduledAutoDraft?.pickNumber === pickNumber) scheduledAutoDraft = null;
    await safeRuntimeMessage({
      type: "got-auto-alarm:clear",
      draftId: draftSessionId,
      pickNumber,
    });
  }

  function availablePlayerRows() {
    return [...document.querySelectorAll(".draft-players .players-table tbody tr, .draft-players .players-table [role='row']")];
  }

  function positionKey(position) {
    return position === "D/ST" || position === "DEF" ? "DST" : String(position || "").toUpperCase();
  }

  function teamKey(team) {
    const value = String(team || "").toUpperCase();
    return ({ JAX: "JAC", WAS: "WSH" })[value] || value;
  }

  function elementIdentity(element) {
    const button = element?.querySelector("button[data-player-id]");
    const injuryElement = element?.querySelector(".injury-status, .player-status, [data-player-injury-status]");
    return {
      playerId: button?.dataset.playerId || element?.dataset?.playerSearchPlayerid || "",
      name: element?.dataset?.playerSearchPlayername || element?.querySelector(".playerinfo__playername")?.textContent || "",
      team: element?.querySelector(".playerinfo__playerteam")?.textContent || "",
      position: element?.querySelector(".playerinfo__playerpos")?.textContent || "",
      injuryStatus: injuryElement?.dataset?.playerInjuryStatus || injuryElement?.textContent?.trim() || "",
    };
  }

  function identityMatchesTarget(identity, target) {
    const positionMatches = positionKey(identity.position) === positionKey(target.position);
    const teamMatches = !target.team || target.team === "FA" || teamKey(identity.team) === teamKey(target.team);
    const nameMatches = engine.normalizeName(identity.name) === engine.normalizeName(target.name);
    const defenseTeamIdentity = positionKey(target.position) === "DST" && teamMatches;
    return Boolean(identity.playerId) && positionMatches && teamMatches && (nameMatches || defenseTeamIdentity);
  }

  function findAvailablePlayerRow(target, playerId = "") {
    return availablePlayerRows().find((row) => {
      const identity = elementIdentity(row);
      return playerId ? identity.playerId === playerId && identityMatchesTarget(identity, target) : identityMatchesTarget(identity, target);
    }) || null;
  }

  function findExactSearchMatch(target) {
    const matches = document.querySelectorAll(".draft-players .player--search--match, .draft-players [data-player-search-playername]");
    const exact = [...matches].filter((match) => identityMatchesTarget(elementIdentity(match), target));
    return exact.length === 1 ? exact[0] : null;
  }

  function findEnabledDraftButton(row) {
    if (!row?.isConnected) return null;
    return [...row.querySelectorAll("button")].find((button) => (
      button.textContent?.trim().toLowerCase() === "draft" && !button.disabled
    )) || null;
  }

  async function waitFor(getValue, timeoutMs = 3200, intervalMs = 80) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = getValue();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  }

  function setReactInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function playerSearchInput() {
    return document.querySelector(".draft-players .playersSearch input, .draft-players .player--search input, .draft-players input[placeholder='Player Name']");
  }

  function clearPlayerSearch(search = playerSearchInput()) {
    if (!search) return;
    setReactInputValue(search, "");
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    search.blur();
  }

  async function locatePlayerDraftControl(target) {
    const visibleRow = findAvailablePlayerRow(target);
    const visibleDraftButton = findEnabledDraftButton(visibleRow);
    if (visibleDraftButton) return { row: visibleRow, draftButton: visibleDraftButton, identity: elementIdentity(visibleRow), searchInput: null, previousSearchValue: "" };

    const search = playerSearchInput();
    if (!search) return null;

    const previousSearchValue = search.value;
    const searchTerm = engine.espnSearchTerm(target);
    setReactInputValue(search, searchTerm);
    const searchMatch = await waitFor(() => findExactSearchMatch(target), 1800);
    if (!searchMatch) return null;

    const playerId = searchMatch.dataset.playerSearchPlayerid || "";
    if (!playerId || search.value !== searchTerm) return null;
    searchMatch.click();

    return waitFor(() => {
      const row = findAvailablePlayerRow(target, playerId);
      const draftButton = findEnabledDraftButton(row);
      return draftButton ? { row, draftButton, identity: elementIdentity(row), searchInput: search, previousSearchValue } : null;
    });
  }

  function stateFingerprint(espn) {
    const drafted = espn.draftedNames.map(engine.normalizeName).sort();
    const roster = espn.roster.map((player) => `${engine.normalizeName(player.name)}:${positionKey(player.position)}`).sort();
    return JSON.stringify({ pick: espn.currentPick, onClock: espn.isUserOnClock, autopick: espn.isEspnAutopickEnabled, paused: espn.isDraftPaused, drafted, roster });
  }

  async function stableSnapshot() {
    const first = espnSnapshot();
    const firstFingerprint = stateFingerprint(first);
    await new Promise((resolve) => setTimeout(resolve, 140));
    const second = espnSnapshot();
    return firstFingerprint === stateFingerprint(second) ? { espn: second, fingerprint: firstFingerprint } : null;
  }

  function syncBlocker(espn) {
    if (document.hidden || Date.now() < resyncBlockedUntil) return "Waiting for a fresh ESPN sync.";
    if (espn.isDraftPaused) return "The ESPN draft is paused.";
    if (espn.isEspnAutopickEnabled) return "Disable ESPN Autopick first.";
    if (!espn.isUserOnClock) return "ESPN does not show your team on the clock.";
    if (!config.draftSlot) return "Draft slot is unknown.";
    if (manualDrafted.length) return "Manual drafted-player reconciliation is active; undo it before drafting.";
    const expectedRoster = engine.ownPicksBefore(espn.currentPick, config.draftSlot, config.teams, config.rounds);
    if (expectedRoster !== null && espn.roster.length !== expectedRoster) return `Roster sync is incomplete (${espn.roster.length}/${expectedRoster}).`;
    if (uncertainPick === espn.currentPick) return "The previous action is uncertain; inspect ESPN before rearming.";
    return "";
  }

  async function updateDraftLock(intent, status) {
    return safeRuntimeMessage({ type: "got-draft-lock:update", ...intent, status });
  }

  async function releaseDraftLock(intent) {
    return safeRuntimeMessage({ type: "got-draft-lock:release", ...intent });
  }

  function setDraftAction(message, kind = "status") {
    const action = $(".got-draft-action");
    if (action) action.innerHTML = `<div class="got-action-message got-action-${kind}">${escapeHtml(message)}</div>`;
  }

  async function draftBestPick({ automatic = false, expectedPick = null, autoSchedule = null, requestedPlayerName = "" } = {}) {
    if (draftAttemptInFlight) return "busy";
    const stable = await stableSnapshot();
    if (!stable) {
      setDraftAction("ESPN state is still changing; no pick was attempted.", "error");
      return "retry";
    }
    const espn = stable.espn;
    const blocker = syncBlocker(espn);
    if (blocker) {
      setDraftAction(blocker, "error");
      return /roster sync|does not show your team on the clock/i.test(blocker) ? "retry" : "blocked";
    }
    const initialPick = espn.currentPick;
    if (!initialPick || (expectedPick && expectedPick !== initialPick)) return "stale";
    if (submittedPick === initialPick) {
      setDraftAction(`A pick was already submitted to ESPN for pick ${initialPick}; no second attempt was made.`, "error");
      return "submitted";
    }
    if (automatic && !config.autoDraftEnabled) return "disabled";

    const draftedNames = [...new Set([...espn.draftedNames, ...manualDrafted])];
    const currentRankings = engine.rankPlayers(dataset.players, { ...espn, draftedNames }, config);
    const requestedName = automatic ? "" : engine.normalizeName(requestedPlayerName);
    const target = requestedName
      ? currentRankings.find((player) => engine.normalizeName(player.name) === requestedName)
      : currentRankings[0];
    if (!target) {
      setDraftAction(requestedName
        ? "That recommendation is no longer available or roster-eligible."
        : "No eligible recommendation is available.", "error");
      return "blocked";
    }
    const targetWasVisible = Boolean(findEnabledDraftButton(findAvailablePlayerRow(target)));
    const triggerSeconds = autoTriggerForPick(initialPick, targetWasVisible);
    const minimumSeconds = targetWasVisible ? 5 : 10;
    if (automatic && autoSchedule) {
      const windowStatus = engine.autoDraftWindowStatus(Date.now(), autoSchedule.fireAt, autoSchedule.deadlineAt, minimumSeconds);
      if (windowStatus !== "ready") {
        if (windowStatus === "late") setDraftAction("The background trigger arrived too late; no pick was attempted.", "error");
        return windowStatus;
      }
    } else if (automatic && (
      !Number.isFinite(espn.secondsRemaining)
      || espn.secondsRemaining <= 0
      || espn.secondsRemaining > triggerSeconds
    )) return "early";
    if (!autoSchedule && Number.isFinite(espn.secondsRemaining) && espn.secondsRemaining < minimumSeconds) {
      setDraftAction(`${targetWasVisible ? "Visible-player" : "Search-based"} drafting is disabled below ${minimumSeconds} seconds.`, "error");
      return "late";
    }
    draftAttemptInFlight = true;
    actionPhase = "ARMED";
    let extensionSearchInput = null;
    let previousSearchValue = "";
    let intent = null;
    let clicked = false;
    const searchBeforeAttempt = playerSearchInput();
    const searchValueBeforeAttempt = searchBeforeAttempt?.value || "";
    try {
      setDraftAction(`${automatic ? "Auto-draft: finding" : "Finding"} ${target.name} in ESPN…`);
      const draftControl = await locatePlayerDraftControl(target);
      if (!draftControl) {
        if (searchBeforeAttempt) {
          setReactInputValue(searchBeforeAttempt, searchValueBeforeAttempt);
          searchBeforeAttempt.blur();
        }
        setDraftAction(`Could not find an enabled ESPN Draft button for ${target.name}.`, "error");
        return "retry";
      }
      extensionSearchInput = draftControl.searchInput;
      previousSearchValue = draftControl.previousSearchValue;
      if (!draftControl.identity.playerId || !identityMatchesTarget(draftControl.identity, target)) {
        setDraftAction(`ESPN did not expose one stable identity for ${target.name}; no pick was made.`, "error");
        return "retry";
      }
      if (draftControl.identity.injuryStatus) {
        setDraftAction(`${target.name} has ESPN injury status ${draftControl.identity.injuryStatus}; automated drafting is disabled for this player.`, "error");
        return "blocked";
      }

      intent = {
        draftId: draftSessionId,
        pickNumber: initialPick,
        userTeamId,
        playerId: draftControl.identity.playerId,
        playerName: target.name,
        position: positionKey(target.position),
        nflTeam: teamKey(target.team),
        stateVersion,
        stateHash: stable.fingerprint,
        actionId: crypto.randomUUID(),
      };
      const lock = await safeRuntimeMessage({ type: "got-draft-lock:acquire", ...intent });
      if (!lock?.ok) {
        setDraftAction("Another ESPN draft tab already holds the action lock for this pick.", "error");
        return "locked";
      }

      const liveStable = await stableSnapshot();
      if (!liveStable) {
        await releaseDraftLock(intent);
        setDraftAction("ESPN changed during preflight; no pick was made.", "error");
        return "retry";
      }
      const liveEspn = liveStable.espn;
      const liveDrafted = new Set(liveEspn.draftedNames.map(engine.normalizeName));
      const liveIdentity = elementIdentity(draftControl.row);
      const autoClockInvalid = automatic && (
        !config.autoDraftEnabled
        || (autoSchedule
          ? engine.autoDraftWindowStatus(Date.now(), autoSchedule.fireAt, autoSchedule.deadlineAt, minimumSeconds) !== "ready"
          : !Number.isFinite(liveEspn.secondsRemaining)
            || liveEspn.secondsRemaining <= 0
            || liveEspn.secondsRemaining > triggerSeconds)
      );
      if (
        !liveEspn.isUserOnClock
        || liveEspn.currentPick !== initialPick
        || liveStable.fingerprint !== intent.stateHash
        || Boolean(syncBlocker(liveEspn))
        || autoClockInvalid
        || liveDrafted.has(engine.normalizeName(target.name))
        || liveIdentity.playerId !== intent.playerId
        || !identityMatchesTarget(liveIdentity, target)
        || !draftControl.draftButton.isConnected
        || draftControl.draftButton.disabled
      ) {
        await releaseDraftLock(intent);
        setDraftAction(`ESPN changed before ${target.name} could be submitted; no pick was made.`, "error");
        return "retry";
      }

      submittedPick = initialPick;
      sessionStorage.setItem(submittedPickStorageKey, String(initialPick));
      setDraftAction(`${automatic ? "Auto-drafting" : "Submitting"} ${target.name} to ESPN…`);
      actionPhase = "CLICKING";
      await updateDraftLock(intent, "clicking");
      draftControl.draftButton.click();
      clicked = true;
      clearPlayerSearch();
      await updateDraftLock(intent, "awaiting-confirmation");
      actionPhase = "AWAITING_CONFIRMATION";
      const confirmed = await waitFor(() => {
        const confirmation = espnSnapshot();
        const onRoster = confirmation.roster.some((player) => (
          engine.normalizeName(player.name) === engine.normalizeName(target.name)
          && positionKey(player.position) === positionKey(target.position)
        ));
        return confirmation.currentPick !== initialPick && onRoster;
      }, 4000, 120);
      if (confirmed) {
        await updateDraftLock(intent, "confirmed");
        actionPhase = "CONFIRMED";
        setDraftAction(`ESPN confirmed ${target.name} for pick ${initialPick}.`, "success");
        return "confirmed";
      } else {
        uncertainPick = initialPick;
        actionPhase = "UNCERTAIN";
        await updateDraftLock(intent, "uncertain");
        setDraftAction(`Confirmation for ${target.name} is uncertain. Automatic and one-click drafting are locked until ESPN advances.`, "error");
        return "uncertain";
      }
    } catch {
      if (intent && !clicked) await releaseDraftLock(intent).catch(() => {});
      if (clicked) uncertainPick = initialPick;
      actionPhase = clicked ? "UNCERTAIN" : "ABORTED";
      setDraftAction(clicked
        ? `The ESPN draft control changed after submitting pick ${initialPick}; no retry will run.`
        : `The ESPN draft control changed before submitting pick ${initialPick}.`, "error");
      return clicked ? "uncertain" : "retry";
    } finally {
      if (extensionSearchInput && !clicked) {
        setReactInputValue(extensionSearchInput, previousSearchValue);
        extensionSearchInput.blur();
      }
      if (!clicked && actionPhase === "ARMED") actionPhase = "ABORTED";
      draftAttemptInFlight = false;
      scheduleRender();
    }
  }

  async function attemptScheduledAutoDraft(schedule) {
    if (!schedule?.pickNumber || autoAttemptInFlight || draftAttemptInFlight || submittedPick === schedule.pickNumber) return;
    if (autoAttemptState.pickNumber !== schedule.pickNumber) {
      autoAttemptState = { pickNumber: schedule.pickNumber, count: 0, nextRetryAt: 0 };
    }
    if (autoAttemptState.count >= MAX_AUTO_ATTEMPTS || Date.now() + 250 < autoAttemptState.nextRetryAt) return;
    autoAttemptState.count += 1;
    autoAttemptState.nextRetryAt = 0;
    saveAutoAttemptState();
    autoAttemptInFlight = true;
    let outcome;
    try {
      outcome = await draftBestPick({ automatic: true, expectedPick: schedule.pickNumber, autoSchedule: schedule });
    } finally {
      autoAttemptInFlight = false;
    }
    if (outcome !== "retry" || autoAttemptState.count >= MAX_AUTO_ATTEMPTS || submittedPick === schedule.pickNumber) return;

    const minimumSeconds = Number(schedule.minimumSeconds) || 10;
    const retryAt = engine.autoDraftRetryAt(Date.now(), schedule.deadlineAt, minimumSeconds, autoAttemptState.count, MAX_AUTO_ATTEMPTS, AUTO_RETRY_DELAY_MS);
    if (!retryAt) {
      setDraftAction(`Auto-draft attempt ${autoAttemptState.count} failed too near the safety cutoff; no unsafe retry was made.`, "error");
      return;
    }
    autoAttemptState.nextRetryAt = retryAt;
    saveAutoAttemptState();
    scheduledAutoDraft = { ...schedule, fireAt: retryAt, attempt: autoAttemptState.count + 1 };
    const result = await safeRuntimeMessage({
      type: "got-auto-alarm:schedule",
      draftId: draftSessionId,
      ...scheduledAutoDraft,
    });
    if (result?.ok) setDraftAction(`Auto-draft attempt ${autoAttemptState.count} did not submit; one safe retry is scheduled.`, "error");
    else schedulerError = "retry trigger unavailable";
  }

  async function maybeAutoDraft(espn, target) {
    const pickNumber = espn.currentPick;
    const shouldSchedule = Boolean(
      config.autoDraftEnabled
      && target
      && pickNumber
      && espn.isUserOnClock
      && !espn.isEspnAutopickEnabled
      && !espn.isDraftPaused
      && Number.isFinite(espn.secondsRemaining)
      && espn.secondsRemaining > 0
      && !manualDrafted.length
      && !draftAttemptInFlight
      && submittedPick !== pickNumber
      && !(autoAttemptState.pickNumber === pickNumber && autoAttemptState.count >= MAX_AUTO_ATTEMPTS)
    );
    if (!shouldSchedule) {
      if (scheduledAutoDraft && scheduledAutoDraft.pickNumber !== pickNumber) void clearBackgroundAutoDraft();
      return;
    }

    const expectedRoster = engine.ownPicksBefore(pickNumber, config.draftSlot, config.teams, config.rounds);
    if (!config.draftSlot || (expectedRoster !== null && espn.roster.length !== expectedRoster)) return;
    if (scheduledAutoDraft?.pickNumber === pickNumber) {
      if (Date.now() + 250 >= scheduledAutoDraft.fireAt) {
        void attemptScheduledAutoDraft(scheduledAutoDraft);
      }
      return;
    }

    const targetIsVisible = Boolean(findEnabledDraftButton(findAvailablePlayerRow(target)));
    const triggerSeconds = autoTriggerForPick(pickNumber, targetIsVisible);
    const now = Date.now();
    const deadlineAt = now + espn.secondsRemaining * 1000;
    const fireAt = now + Math.max(0, espn.secondsRemaining - triggerSeconds) * 1000;
    const minimumSeconds = targetIsVisible ? 5 : 10;
    scheduledAutoDraft = { pickNumber, triggerSeconds, minimumSeconds, fireAt, deadlineAt, attempt: 1 };
    const result = await safeRuntimeMessage({
      type: "got-auto-alarm:schedule",
      draftId: draftSessionId,
      ...scheduledAutoDraft,
    });
    if (!result?.ok) {
      schedulerError = "background trigger unavailable";
      setDraftAction("Could not schedule the background auto-draft trigger. Keep ESPN visible or disarm auto-draft.", "error");
      return;
    }
    schedulerError = "";
    if (fireAt <= Date.now() + 250) {
      void attemptScheduledAutoDraft(scheduledAutoDraft);
    }
  }

  function render() {
    const espn = espnSnapshot();
    if (!draftCompletionHandled && config.autoDraftEnabled && espn.roster.length >= config.rosterSize) {
      draftCompletionHandled = true;
      config = { ...config, autoDraftEnabled: false };
      void saveConfig();
      void clearBackgroundAutoDraft();
      void syncKeepAwake();
      setDraftAction("Draft complete. Auto-draft disarmed and the Mac awake guard was released.", "success");
    }
    const fingerprint = stateFingerprint(espn);
    if (fingerprint !== lastStateFingerprint) {
      lastStateFingerprint = fingerprint;
      stateVersion += 1;
    }
    if (uncertainPick && espn.currentPick !== uncertainPick) uncertainPick = null;
    if (espn.inferredDraftSlot && config.draftSlot !== espn.inferredDraftSlot) {
      config = { ...config, draftSlot: espn.inferredDraftSlot };
      slotInput.value = config.draftSlot;
      saveConfig();
    }
    const draftedNames = [...new Set([...espn.draftedNames, ...manualDrafted])];
    lastState = { ...espn, draftedNames };
    const allRankings = engine.rankPlayers(dataset.players, lastState, config);
    const overallBest = allRankings[0];
    const suggestionPosition = positionSelect.value || "ALL";
    const rankings = (suggestionPosition === "ALL"
      ? allRankings
      : allRankings.filter((player) => positionKey(player.position) === suggestionPosition)).slice(0, 5);
    const current = espn.currentPick || "?";
    const slotMessage = config.draftSlot ? `slot ${config.draftSlot}` : "enter draft slot";
    $(".got-status").textContent = `Pick ${current} · ${draftedNames.length} drafted · ${slotMessage}`;
    $(".got-best").innerHTML = rankings[0]
      ? `<div class="got-label">${suggestionPosition === "ALL" ? "BEST PICK" : `BEST ${escapeHtml(suggestionPosition)}`}</div>${playerCard(rankings[0])}`
      : `<p class="got-empty">No available ${suggestionPosition === "ALL" ? "players" : escapeHtml(suggestionPosition + "s")} are roster-eligible.</p>`;
    const nextPick = engine.nextPickAfter(espn.currentPick || 1, config.draftSlot, config.teams, config.rounds);
    if (suggestionPosition === "ALL" && rankings[0] && nextPick === espn.currentPick + 1) {
      const secondState = {
        ...lastState,
        currentPick: nextPick,
        draftedNames: [...draftedNames, rankings[0].name],
        roster: [...espn.roster, { name: rankings[0].name, position: rankings[0].position }],
      };
      const second = engine.rankPlayers(dataset.players, secondState, config)[0];
      $(".got-turn-plan").innerHTML = second
        ? `<strong>TURN PLAN</strong><span>1. ${escapeHtml(rankings[0].name)} → 2. ${escapeHtml(second.name)}</span>`
        : "";
    } else $(".got-turn-plan").innerHTML = "";
    const blocker = syncBlocker(espn);
    const manualDraftLabel = blocker || (espn.isUserOnClock
      ? `Draft ${escapeHtml(rankings[0]?.name || "best pick")} — Pick ${current}`
      : "Available when you’re on the clock");
    $(".got-draft-action").innerHTML = rankings[0]
      ? `<button class="got-draft-best" type="button" data-player-name="${escapeHtml(rankings[0].name)}" ${!blocker && espn.isUserOnClock && !draftAttemptInFlight && submittedPick !== espn.currentPick ? "" : "disabled"}>${manualDraftLabel}</button>`
      : "";
    const canOneClickDraft = !blocker && espn.isUserOnClock && !draftAttemptInFlight && submittedPick !== espn.currentPick;
    $(".got-alternatives").innerHTML = rankings.slice(1).map((player) => `
      <li>
        ${playerCard(player)}
        <button class="got-draft-alternative" type="button" data-player-name="${escapeHtml(player.name)}" ${canOneClickDraft ? "" : "disabled"}>Draft ${escapeHtml(player.name)}</button>
      </li>`).join("");
    const attemptText = autoAttemptState.pickNumber === espn.currentPick ? `${autoAttemptState.count}/${MAX_AUTO_ATTEMPTS}` : `0/${MAX_AUTO_ATTEMPTS}`;
    $(".got-debug-body").textContent = `${espn.visibleAvailableNames.length} visible available · ${espn.roster.length} on your roster · ${manualDrafted.length} manual · action ${actionPhase} · auto attempts ${attemptText} · ${keepAwakeActive ? "Mac awake guard active" : "awake guard off"}`;
    const clockText = Number.isFinite(espn.secondsRemaining)
      ? `${String(Math.floor(espn.secondsRemaining / 60)).padStart(2, "0")}:${String(espn.secondsRemaining % 60).padStart(2, "0")}`
      : "--:--";
    const selectedTrigger = config.autoDraftEnabled && espn.isUserOnClock
      ? autoTriggerForPick(espn.currentPick, Boolean(overallBest && findEnabledDraftButton(findAvailablePlayerRow(overallBest))))
      : null;
    $(".got-clock").textContent = espn.isEspnAutopickEnabled
      ? "BLOCKED · ESPN AUTOPICK"
      : schedulerError
        ? `ERROR · ${schedulerError}`
      : config.autoDraftEnabled
        ? espn.isUserOnClock
          ? `ARMED · ${clockText} · drafts at ${selectedTrigger ?? "–"}s left`
          : "ARMED · waiting for your turn"
        : `OFF · ${clockText}`;
    $(".got-auto-row").classList.toggle("got-auto-armed", Boolean(config.autoDraftEnabled));
    $(".got-auto-row").classList.toggle("got-auto-blocked", Boolean(espn.isEspnAutopickEnabled));
    autoDraftToggle.textContent = config.autoDraftEnabled ? "Disarm auto-draft" : "Arm auto-draft";
    autoDraftToggle.setAttribute("aria-pressed", String(Boolean(config.autoDraftEnabled)));
    earlyBlockToggle.textContent = config.earlyQbTeBlockEnabled
      ? "QB/TE blocked through Round 8"
      : "Block QB/TE through Round 8";
    earlyBlockToggle.setAttribute("aria-pressed", String(Boolean(config.earlyQbTeBlockEnabled)));
    earlyOneToggle.textContent = config.earlyQbTeOneTotalEnabled
      ? "One QB/TE total allowed through Round 8"
      : "Allow only one QB or TE through Round 8";
    earlyOneToggle.setAttribute("aria-pressed", String(Boolean(config.earlyQbTeOneTotalEnabled)));
    $(".got-strategy-row").classList.toggle("got-strategy-active", Boolean(config.earlyQbTeBlockEnabled || config.earlyQbTeOneTotalEnabled));
    $("footer").textContent = `${String(dataset.meta.generatedAt || "Undated").slice(0, 10)} snapshot · full-PPR / 12 teams · league scoring requires matching projections`;
    void maybeAutoDraft(espn, overallBest).catch(() => {
      schedulerError = "background trigger unavailable";
    });
  }

  let timer;
  const scheduleRender = () => {
    clearTimeout(timer);
    timer = setTimeout(render, 120);
  };

  $(".got-collapse").addEventListener("click", () => {
    collapsed = !collapsed;
    $(".got-body").hidden = collapsed;
    $(".got-collapse").textContent = collapsed ? "+" : "−";
  });
  host.addEventListener("click", (event) => {
    const alternativeButton = event.target.closest(".got-draft-alternative");
    if (alternativeButton) {
      draftBestPick({ requestedPlayerName: alternativeButton.dataset.playerName || "" });
      return;
    }
    const bestButton = event.target.closest(".got-draft-best");
    if (bestButton) draftBestPick({ requestedPlayerName: bestButton.dataset.playerName || "" });
  });
  slotInput.addEventListener("change", () => {
    const value = Number(slotInput.value);
    config = { ...config, draftSlot: value >= 1 && value <= config.teams ? value : 0 };
    saveConfig();
    render();
  });
  modelSelect.addEventListener("change", () => {
    const rankingModel = ["think-rmv", "sharp-value", "vegas-sharks-80", "vegas-only", "balanced-v04"].includes(modelSelect.value)
      ? modelSelect.value
      : "sharp-value";
    config = { ...config, rankingModel };
    saveConfig();
    render();
  });
  positionSelect.addEventListener("change", () => {
    const suggestionPosition = ["ALL", "QB", "RB", "WR", "TE", "DST", "K"].includes(positionSelect.value)
      ? positionSelect.value
      : "ALL";
    config = { ...config, suggestionPosition };
    saveConfig();
    render();
  });
  earlyBlockToggle.addEventListener("click", () => {
    const earlyQbTeBlockEnabled = !config.earlyQbTeBlockEnabled;
    config = { ...config, earlyQbTeBlockEnabled, earlyQbTeOneTotalEnabled: earlyQbTeBlockEnabled ? false : config.earlyQbTeOneTotalEnabled };
    clearAutoTriggerForPick(lastState?.currentPick);
    saveConfig();
    render();
  });
  earlyOneToggle.addEventListener("click", () => {
    const earlyQbTeOneTotalEnabled = !config.earlyQbTeOneTotalEnabled;
    config = { ...config, earlyQbTeOneTotalEnabled, earlyQbTeBlockEnabled: earlyQbTeOneTotalEnabled ? false : config.earlyQbTeBlockEnabled };
    clearAutoTriggerForPick(lastState?.currentPick);
    saveConfig();
    render();
  });
  autoDraftToggle.addEventListener("click", () => {
    config = { ...config, autoDraftEnabled: !config.autoDraftEnabled };
    if (config.autoDraftEnabled) clearAutoTriggerForPick(lastState?.currentPick);
    else void clearBackgroundAutoDraft();
    saveConfig();
    void syncKeepAwake();
    render();
  });
  function saveAutoBounds() {
    const minimum = Math.min(25, Math.max(5, Number(autoDraftMinInput.value) || 5));
    const maximum = Math.min(25, Math.max(minimum, Number(autoDraftMaxInput.value) || 25));
    autoDraftMinInput.value = minimum;
    autoDraftMaxInput.value = maximum;
    config = { ...config, autoDraftMinSeconds: minimum, autoDraftMaxSeconds: maximum };
    clearAutoTriggerForPick(lastState?.currentPick);
    saveConfig();
    render();
  }
  autoDraftMinInput.addEventListener("change", saveAutoBounds);
  autoDraftMaxInput.addEventListener("change", saveAutoBounds);
  $(".got-add").addEventListener("click", async () => {
    const input = $(".got-manual");
    const value = input.value.trim();
    if (!value) return;
    manualDrafted = [...manualDrafted, value];
    input.value = "";
    await chrome.storage.local.set({ manualDrafted });
    render();
  });
  $(".got-undo").addEventListener("click", async () => {
    manualDrafted = manualDrafted.slice(0, -1);
    await chrome.storage.local.set({ manualDrafted });
    render();
  });

  new MutationObserver((records) => {
    if (records.some((record) => !host.contains(record.target))) scheduleRender();
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  for (const eventName of ["focus", "online"]) {
    window.addEventListener(eventName, () => {
      resyncBlockedUntil = Date.now() + 500;
      scheduleRender();
    });
  }
  document.addEventListener("visibilitychange", () => {
    resyncBlockedUntil = Date.now() + 500;
    scheduleRender();
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "got-auto-alarm:fire" || message.draftId !== draftSessionId) return;
    if (!config.autoDraftEnabled || submittedPick === message.pickNumber) return;
    scheduledAutoDraft = {
      pickNumber: message.pickNumber,
      triggerSeconds: message.triggerSeconds,
      minimumSeconds: message.minimumSeconds,
      fireAt: message.fireAt,
      deadlineAt: message.deadlineAt,
      attempt: message.attempt,
    };
    if (!message.tabActivated || document.hidden) {
      schedulerError = "could not bring ESPN to the foreground";
      setDraftAction("Auto-draft stopped because Chrome could not activate the ESPN tab.", "error");
      return;
    }
    void attemptScheduledAutoDraft(scheduledAutoDraft);
  });
  setInterval(scheduleRender, 1000);
  void syncKeepAwake();
  render();
})();
