(async function options() {
  const engine = globalThis.DraftAssistantEngine;
  const stored = await chrome.storage.local.get("draftAssistantConfig");
  const config = engine.loadConfig(stored.draftAssistantConfig);
  const form = document.querySelector("form");
  try {
    const response = await fetch(chrome.runtime.getURL("data/rankings.json"));
    const dataset = await response.json();
    if (dataset.meta?.rankingsOnly) {
      config.rankingModel = "fantasypros-ecr";
      for (const option of form.elements.rankingModel.options) option.disabled = option.value !== "fantasypros-ecr";
    }
    if (dataset.meta?.supportedModels) {
      if (!dataset.meta.supportedModels.includes(config.rankingModel)) config.rankingModel = dataset.meta.supportedModels[0];
      for (const option of form.elements.rankingModel.options) option.disabled = !dataset.meta.supportedModels.includes(option.value);
    }
  } catch { /* Settings remain available before a rankings file is installed. */ }
  form.elements.rankingModel.value = config.rankingModel;
  form.elements.draftSlot.value = config.draftSlot || "";
  form.elements.autoDraftMinSeconds.value = config.autoDraftMinSeconds || config.autoDraftSeconds || 5;
  form.elements.autoDraftMaxSeconds.value = config.autoDraftMaxSeconds || 25;
  form.elements.autoDraftEnabled.checked = Boolean(config.autoDraftEnabled);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const next = {
      ...config,
      rankingModel: ["fantasypros-ecr", "think-rmv", "sharp-value", "vegas-sharks-80", "vegas-only", "balanced-v04"].includes(form.elements.rankingModel.value)
        ? form.elements.rankingModel.value
        : "sharp-value",
      draftSlot: Number(form.elements.draftSlot.value) || 0,
      autoDraftEnabled: form.elements.autoDraftEnabled.checked,
      autoDraftMinSeconds: Math.min(25, Math.max(5, Number(form.elements.autoDraftMinSeconds.value) || 5)),
      autoDraftMaxSeconds: Math.min(25, Math.max(Number(form.elements.autoDraftMinSeconds.value) || 5, Number(form.elements.autoDraftMaxSeconds.value) || 25)),
    };
    await chrome.storage.local.set({ draftAssistantConfig: engine.loadConfig(next) });
    form.querySelector("output").textContent = "Saved locally.";
  });
})();
