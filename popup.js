"use strict";

const DEFAULTS = Object.freeze({
  enabled: true,
  duration: 72,
  caretWidth: 1.5,
  blinkInterval: 530,
  disabledHosts: []
});

const enabledInput = document.querySelector("#enabled");
const siteEnabledInput = document.querySelector("#siteEnabled");
const siteName = document.querySelector("#siteName");
const durationInput = document.querySelector("#duration");
const caretWidthInput = document.querySelector("#caretWidth");
const blinkInput = document.querySelector("#blinkInterval");
const durationValue = document.querySelector("#durationValue");
const widthValue = document.querySelector("#widthValue");
const blinkValue = document.querySelector("#blinkValue");
const presetButtons = [...document.querySelectorAll("[data-duration]")];

let currentHost = "";
let state = { ...DEFAULTS };

function normalizeHost(urlString) {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    return url.hostname;
  } catch {
    return "";
  }
}

function updatePresetSelection() {
  for (const button of presetButtons) {
    button.classList.toggle(
      "selected",
      Number(button.dataset.duration) === Number(state.duration)
    );
  }
}

function render() {
  enabledInput.checked = Boolean(state.enabled);
  durationInput.value = String(state.duration);
  caretWidthInput.value = String(state.caretWidth);
  blinkInput.value = String(state.blinkInterval);

  durationValue.value = `${state.duration} ms`;
  widthValue.value = `${state.caretWidth} px`;
  blinkValue.value = `${state.blinkInterval} ms`;

  const supportedSite = Boolean(currentHost);
  siteEnabledInput.disabled = !supportedSite;
  siteEnabledInput.checked =
    supportedSite && !state.disabledHosts.includes(currentHost);

  siteName.textContent = supportedSite
    ? currentHost
    : "浏览器内部页面不支持";

  updatePresetSelection();
}

async function save(patch) {
  state = { ...state, ...patch };
  await chrome.storage.sync.set(patch);
  render();
}

enabledInput.addEventListener("change", () => {
  save({ enabled: enabledInput.checked });
});

siteEnabledInput.addEventListener("change", () => {
  if (!currentHost) return;

  const disabled = new Set(state.disabledHosts);
  if (siteEnabledInput.checked) {
    disabled.delete(currentHost);
  } else {
    disabled.add(currentHost);
  }

  save({ disabledHosts: [...disabled] });
});

durationInput.addEventListener("input", () => {
  save({ duration: Number(durationInput.value) });
});

caretWidthInput.addEventListener("input", () => {
  save({ caretWidth: Number(caretWidthInput.value) });
});

blinkInput.addEventListener("input", () => {
  save({ blinkInterval: Number(blinkInput.value) });
});

for (const button of presetButtons) {
  button.addEventListener("click", () => {
    save({ duration: Number(button.dataset.duration) });
  });
}

async function initialize() {
  const [saved, tabs] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.tabs.query({ active: true, currentWindow: true })
  ]);

  state = {
    ...DEFAULTS,
    ...saved,
    disabledHosts: Array.isArray(saved.disabledHosts)
      ? saved.disabledHosts
      : []
  };

  currentHost = normalizeHost(tabs[0]?.url || "");
  render();
}

initialize().catch((error) => {
  console.error("SmoothType popup initialization failed:", error);
  siteName.textContent = "设置加载失败";
});
