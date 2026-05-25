const storedAutostartSelection = localStorage.getItem("switchboard.autostartSelection");

const state = {
  data: null,
  selectedServiceId: localStorage.getItem("switchboard.selectedService") || "opencode",
  autostartSelection: new Set(JSON.parse(storedAutostartSelection || "[]")),
  autostartSelectionLoaded: Boolean(storedAutostartSelection),
  activeLogService: localStorage.getItem("switchboard.logService") || "opencode",
  refreshing: false,
  menuBound: false,
};

const els = {
  summaryTotal: document.getElementById("metricTotal"),
  summaryRunning: document.getElementById("metricRunning"),
  summaryHealthy: document.getElementById("metricHealthy"),
  summaryAutostart: document.getElementById("metricAutostart"),
  serviceMenu: document.getElementById("serviceMenu"),
  selectedServiceTitle: document.getElementById("selectedServiceTitle"),
  selectedServiceSubtitle: document.getElementById("selectedServiceSubtitle"),
  selectedServiceBadge: document.getElementById("selectedServiceBadge"),
  selectedServiceAction: document.getElementById("selectedServiceAction"),
  selectedServiceMeta: document.getElementById("selectedServiceMeta"),
  selectedServiceHint: document.getElementById("selectedServiceHint"),
  selectedServiceHealth: document.getElementById("selectedServiceHealth"),
  autostartList: document.getElementById("autostartList"),
  autostartState: document.getElementById("autostartState"),
  autostartToggle: document.getElementById("autostartToggle"),
  envForm: document.getElementById("envForm"),
  saveEnvBtn: document.getElementById("saveEnvBtn"),
  configList: document.getElementById("configList"),
  logService: document.getElementById("logService"),
  logOutput: document.getElementById("logOutput"),
  refreshBtn: document.getElementById("refreshBtn"),
  loadLogsBtn: document.getElementById("loadLogsBtn"),
  saveAutostartBtn: document.getElementById("saveAutostartBtn"),
  runAutostartBtn: document.getElementById("runAutostartBtn"),
  toast: document.getElementById("toast"),
};

const configs = [
  {
    id: "opencode",
    name: "OpenCode",
    target: "opencode.json",
    url: "http://127.0.0.1:8788/v1",
    models: ["glm-5.1", "deepseek-v4-pro"],
    notes: "AI SDK / OpenAI-compatible provider",
    snippet: `{
  "provider": {
    "sztu": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "SZTU API Gateway",
      "options": {
        "baseURL": "http://127.0.0.1:8788/v1",
        "apiKey": "any",
        "timeout": 600000,
        "chunkTimeout": 600000
      },
      "models": {
        "glm-5.1": {
          "name": "GLM-5.1",
          "reasoning": true
        },
        "deepseek-v4-pro": {
          "name": "DeepSeek-V4-Pro",
          "reasoning": true
        }
      }
    }
  }
}`,
  },
  {
    id: "codebuddy",
    name: "CodeBuddy",
    target: "models.json",
    url: "http://127.0.0.1:8787/v1/chat/completions",
    models: ["glm-5.1", "deepseek-v4-pro"],
    notes: "custom model list",
    snippet: `{
  "models": [
    {
      "id": "glm-5.1",
      "name": "glm-5.1",
      "vendor": "SZTU",
      "apiKey": "any",
      "url": "http://127.0.0.1:8787/v1/chat/completions",
      "supportsToolCall": true,
      "supportsReasoning": true
    },
    {
      "id": "deepseek-v4-pro",
      "name": "deepseek-v4-pro",
      "vendor": "SZTU",
      "apiKey": "any",
      "url": "http://127.0.0.1:8787/v1/chat/completions",
      "supportsToolCall": true,
      "supportsReasoning": true
    }
  ]
}`,
  },
  {
    id: "claudecode",
    name: "Claude Code",
    target: "settings.json / env",
    url: "http://127.0.0.1:8790",
    models: ["glm-5.1", "deepseek-v4-pro"],
    notes: "Anthropic-compatible base URL; .env SZTU_DEFAULT_MODEL controls primary, CLAUDE_SZTU_FALLBACK_MODEL controls fallback",
    snippet: `{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8790",
    "ANTHROPIC_API_KEY": "any",
    "ANTHROPIC_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}`,
  },
];

function persistSelections() {
  localStorage.setItem("switchboard.autostartSelection", JSON.stringify([...state.autostartSelection]));
  localStorage.setItem("switchboard.selectedService", state.selectedServiceId);
  localStorage.setItem("switchboard.logService", state.activeLogService);
}

function serviceStatusLabel(service) {
  if (!service.running) return "stopped";
  if (service.healthy) return "running";
  return "degraded";
}

function badgeTone(label) {
  if (label === "running" || label === "enabled") return "good";
  if (label === "degraded" || label === "stopped") return "warn";
  return "bad";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    els.toast.classList.remove("show");
  }, 1800);
}

async function loadState() {
  const response = await fetch("/api/state");
  if (!response.ok) {
    throw new Error(`状态请求失败：${response.status}`);
  }
  return response.json();
}

async function loadEnv() {
  const response = await fetch("/api/env");
  if (!response.ok) {
    throw new Error(`环境变量读取失败：${response.status}`);
  }
  return response.json();
}

async function saveEnv(values) {
  const response = await fetch("/api/env", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ values }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `环境变量保存失败：${response.status}`);
  }
  return response.json();
}

async function loadLogs(serviceId) {
  if (!serviceId) {
    els.logOutput.textContent = "请选择一个服务。";
    return;
  }
  els.logOutput.textContent = "正在读取日志...";
  const response = await fetch(`/api/logs?service=${encodeURIComponent(serviceId)}&lines=120`);
  if (!response.ok) {
    els.logOutput.textContent = `日志读取失败：${response.status}`;
    return;
  }
  const payload = await response.json();
  els.logOutput.textContent = payload.text || "暂无日志。";
}

async function postAction(action, services, extra = {}) {
  const response = await fetch("/api/action", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ action, services, ...extra }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `操作失败：${response.status}`);
  }
  return response.json();
}

function getService(serviceId) {
  return state.data?.services?.find((service) => service.id === serviceId) || null;
}

function selectedService() {
  return getService(state.selectedServiceId) || state.data?.services?.[0] || null;
}

function renderSummary(data) {
  els.summaryTotal.textContent = String(data.summary.total);
  els.summaryRunning.textContent = String(data.summary.running);
  els.summaryHealthy.textContent = String(data.summary.healthy);
  els.summaryAutostart.textContent = data.autostart.enabled ? "开" : "关";
}

function renderServiceMenu(data) {
  els.serviceMenu.innerHTML = data.services.map((service) => {
    const selected = service.id === state.selectedServiceId;
    const label = serviceStatusLabel(service);
    const actionLabel = service.running ? "停止" : "启动";
    return `
      <button class="service-item ${selected ? "active" : ""}" data-service-select="${service.id}" type="button">
        <span class="service-pill ${badgeTone(label)}">${label}</span>
        <span class="service-item-text">
          <strong>${service.name}</strong>
          <span>${service.port} · ${service.pid || "no pid"}</span>
        </span>
        <span class="service-action">${actionLabel}</span>
      </button>
    `;
  }).join("");
}

function renderSelectedService(data) {
  const service = selectedService();
  if (!service) {
    els.selectedServiceTitle.textContent = "未选择服务";
    els.selectedServiceSubtitle.textContent = "左侧选择一个代理";
    els.selectedServiceBadge.textContent = "none";
    els.selectedServiceBadge.className = "badge";
    els.selectedServiceAction.disabled = true;
    els.selectedServiceMeta.textContent = "";
    els.selectedServiceHint.textContent = "";
    els.selectedServiceHealth.textContent = "";
    return;
  }

  const label = serviceStatusLabel(service);
  const actionLabel = service.running ? "停止" : "启动";
  els.selectedServiceTitle.textContent = service.name;
  els.selectedServiceSubtitle.textContent = service.description;
  els.selectedServiceBadge.textContent = label;
  els.selectedServiceBadge.className = `badge ${badgeTone(label)}`;
  els.selectedServiceAction.textContent = actionLabel;
  els.selectedServiceAction.dataset.service = service.id;
  els.selectedServiceAction.disabled = false;
  els.selectedServiceMeta.textContent = `端口 ${service.port} · PID ${service.pid || "-"} · 启动 ${service.startedAt ? new Date(service.startedAt).toLocaleString() : "-"}`;
  els.selectedServiceHint.innerHTML = `
    <span>健康检查</span>
    <strong>${service.health?.status || "n/a"}</strong>
    <span>${service.health?.error ? escapeHtml(service.health.error) : service.health?.ok ? "响应正常" : "未就绪"}</span>
  `;
  els.selectedServiceHealth.textContent = service.health?.text || "";
}

function renderAutostart(data) {
  els.autostartToggle.checked = data.autostart.enabled;
  els.autostartState.innerHTML = `
    <div class="autostart-chip ${badgeTone(data.autostart.enabled ? "enabled" : "stopped")}">${data.autostart.enabled ? "已启用" : "已关闭"}</div>
    <div class="muted-block">任务：${data.autostart.installed ? "已安装" : "未安装"} · ${data.autostart.supported ? "支持计划任务" : "当前系统不支持"}</div>
  `;
  els.autostartList.innerHTML = data.services.map((service) => {
    const selected = state.autostartSelection.has(service.id);
    return `
      <label class="autostart-row">
        <input data-select-autostart="${service.id}" type="checkbox" ${selected ? "checked" : ""} />
        <span>
          <strong>${service.name}</strong>
          <small>${service.id}</small>
        </span>
      </label>
    `;
  }).join("");
}

function renderConfigs() {
  els.configList.innerHTML = configs.map((config) => `
    <article class="config-card">
      <div class="config-head">
        <div>
          <h3>${config.name}</h3>
          <div class="config-meta">${config.target}</div>
        </div>
        <button class="copy-btn" data-copy-config="${config.id}">复制</button>
      </div>
      <div class="config-lines">
        <div class="config-line"><span>接入地址</span><code>${config.url}</code></div>
        <div class="config-line"><span>兼容模型</span><code>${config.models.join(", ")}</code></div>
        <div class="config-line"><span>用途</span><code>${config.notes}</code></div>
      </div>
      <details class="config-details">
        <summary>完整配置片段</summary>
        <pre class="config-code">${escapeHtml(config.snippet)}</pre>
      </details>
    </article>
  `).join("");
}

function renderEnv(envConfig) {
  els.envForm.innerHTML = envConfig.fields.map((field) => {
    const wide = field.key === "SZTU_API_KEY" || field.key === "SZTU_DEFAULT_MODEL" || field.key === "CLAUDE_SZTU_FALLBACK_MODEL";
    const type = field.secret ? "password" : "text";
    return `
      <div class="env-field ${wide ? "wide" : ""}">
        <label for="env-${field.key}">${field.label}</label>
        <input id="env-${field.key}" data-env-key="${field.key}" type="${type}" value="${escapeHtml(field.value)}" autocomplete="off" />
        <small>${field.key}${field.present ? "" : " · 未写入"}</small>
      </div>
    `;
  }).join("");
}

function readEnvForm() {
  const values = {};
  document.querySelectorAll("[data-env-key]").forEach((input) => {
    values[input.getAttribute("data-env-key")] = input.value;
  });
  return values;
}

function renderLogOptions(data) {
  els.logService.innerHTML = data.services.map((service) => `<option value="${service.id}">${service.name}</option>`).join("");
  els.logService.value = data.services.some((service) => service.id === state.activeLogService) ? state.activeLogService : data.services[0]?.id || "";
  state.activeLogService = els.logService.value;
  persistSelections();
}

function updateServiceMenuSelection() {
  document.querySelectorAll("[data-service-select]").forEach((button) => {
    button.classList.toggle("active", button.getAttribute("data-service-select") === state.selectedServiceId);
  });
}

function bindServiceMenuOnce() {
  if (state.menuBound) {
    return;
  }
  state.menuBound = true;
  els.serviceMenu.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-service-select]");
    if (!button) {
      return;
    }
    const id = button.getAttribute("data-service-select");
    if (id === state.selectedServiceId) {
      return;
    }
    const service = getService(id);
    if (!service) {
      return;
    }
    state.selectedServiceId = id;
    state.activeLogService = id;
    persistSelections();
    updateServiceMenuSelection();
    renderSelectedService(state.data);
    renderLogOptions(state.data);
    await loadLogs(id);
    showToast(`已切换到 ${service.name}`);
  });
}

function bindConfigCopy() {
  document.querySelectorAll("[data-copy-config]").forEach((button) => {
    button.addEventListener("click", async () => {
      const config = configs.find((item) => item.id === button.getAttribute("data-copy-config"));
      if (!config) {
        return;
      }
      try {
        await navigator.clipboard.writeText(config.snippet);
        showToast(`${config.name} 配置已复制`);
      } catch {
        showToast("浏览器不允许复制，请手动选中配置");
      }
    });
  });
}

function bindAutostartSelection() {
  document.querySelectorAll("[data-select-autostart]").forEach((input) => {
    input.addEventListener("change", () => {
      const id = input.getAttribute("data-select-autostart");
      if (input.checked) {
        state.autostartSelection.add(id);
      } else {
        state.autostartSelection.delete(id);
      }
      persistSelections();
    });
  });
}

function hydrateAutostartSelection(data) {
  if (!state.autostartSelectionLoaded) {
    state.autostartSelection = new Set(data.autostart.services);
    state.autostartSelectionLoaded = true;
  }
  persistSelections();
}

async function refresh(options = {}) {
  if (state.refreshing) {
    return;
  }
  state.refreshing = true;
  const loadLog = options.loadLog === true;
  try {
    const data = await loadState();
    state.data = data;
    hydrateAutostartSelection(data);
    if (!getService(state.selectedServiceId)) {
      state.selectedServiceId = data.services[0]?.id || "";
    }
    if (!getService(state.activeLogService)) {
      state.activeLogService = state.selectedServiceId;
    }
    renderSummary(data);
    renderServiceMenu(data);
    renderSelectedService(data);
    renderAutostart(data);
    renderConfigs();
    renderLogOptions(data);
    bindServiceMenuOnce();
    bindAutostartSelection();
    bindConfigCopy();
    if (loadLog) {
      await loadLogs(state.activeLogService);
    }
  } finally {
    state.refreshing = false;
  }
}

els.refreshBtn.addEventListener("click", () => refresh({ loadLog: true }).catch((error) => {
  els.logOutput.textContent = error.message;
}));

els.loadLogsBtn.addEventListener("click", () => {
  state.activeLogService = els.logService.value;
  persistSelections();
  loadLogs(state.activeLogService).catch((error) => {
    els.logOutput.textContent = error.message;
  });
});

els.saveEnvBtn.addEventListener("click", async () => {
  els.saveEnvBtn.disabled = true;
  try {
    const envConfig = await saveEnv(readEnvForm());
    renderEnv(envConfig);
    showToast(".env 已保存，端口/模型变更后请重启代理");
  } catch (error) {
    els.logOutput.textContent = error.message;
  } finally {
    els.saveEnvBtn.disabled = false;
  }
});

els.logService.addEventListener("change", () => {
  state.activeLogService = els.logService.value;
  persistSelections();
  loadLogs(state.activeLogService).catch((error) => {
    els.logOutput.textContent = error.message;
  });
});

els.selectedServiceAction.addEventListener("click", async () => {
  const service = getService(els.selectedServiceAction.dataset.service);
  if (!service) {
    return;
  }
  const action = service.running ? "stop" : "start";
  els.selectedServiceAction.disabled = true;
  try {
    await postAction(action, [service.id]);
    await refresh({ loadLog: true });
  } catch (error) {
    els.logOutput.textContent = error.message;
  } finally {
    els.selectedServiceAction.disabled = false;
  }
});

els.autostartToggle.addEventListener("change", async () => {
  try {
    await postAction("toggle-autostart", [...state.autostartSelection], { enabled: els.autostartToggle.checked });
    await refresh({ loadLog: false });
  } catch (error) {
    els.logOutput.textContent = error.message;
    els.autostartToggle.checked = !els.autostartToggle.checked;
  }
});

els.saveAutostartBtn.addEventListener("click", async () => {
  try {
    await postAction("toggle-autostart", [...state.autostartSelection], { enabled: els.autostartToggle.checked });
    await refresh({ loadLog: false });
    showToast("自启配置已保存");
  } catch (error) {
    els.logOutput.textContent = error.message;
  }
});

els.runAutostartBtn.addEventListener("click", async () => {
  try {
    await postAction("run-autostart", []);
    await refresh({ loadLog: true });
  } catch (error) {
    els.logOutput.textContent = error.message;
  }
});

refresh({ loadLog: true }).catch((error) => {
  els.logOutput.textContent = error.message;
});

loadEnv()
  .then(renderEnv)
  .catch((error) => {
    els.envForm.textContent = error.message;
  });

setInterval(() => {
  refresh().catch(() => {});
}, 6000);
