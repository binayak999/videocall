const TOKEN_KEY = "meetclone_jwt";

function $(id) {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing #${id}`);
  }
  return el;
}

function getToken() {
  return window.localStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  window.localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  window.localStorage.removeItem(TOKEN_KEY);
}

function showPre(el, data, isError) {
  el.hidden = false;
  el.textContent =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);
  el.classList.toggle("err", Boolean(isError));
}

async function readJson(response) {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function updateTokenPreview() {
  const token = getToken();
  const el = $("token-preview");
  if (!token) {
    el.textContent = "—";
    return;
  }
  const tail = token.length > 18 ? `${token.slice(0, 10)}…${token.slice(-6)}` : token;
  el.textContent = tail;
}

async function refreshStatus() {
  const apiEl = $("api-health");
  const sigEl = $("signaling-health");
  apiEl.textContent = "Loading…";
  sigEl.textContent = "Loading…";

  try {
    const r = await fetch("/health");
    const body = await readJson(r);
    showPre(apiEl, { ok: r.ok, status: r.status, body }, !r.ok);
  } catch (e) {
    showPre(apiEl, { error: e instanceof Error ? e.message : String(e) }, true);
  }

  try {
    const r = await fetch("/api/signaling-health");
    const body = await readJson(r);
    showPre(sigEl, { ok: r.ok, status: r.status, body }, !r.ok);
  } catch (e) {
    showPre(sigEl, { error: e instanceof Error ? e.message : String(e) }, true);
  }
}

function wireForms() {
  $("form-register").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const fd = new FormData(form);
    const payload = {
      email: String(fd.get("email") ?? ""),
      name: String(fd.get("name") ?? ""),
      password: String(fd.get("password") ?? ""),
    };
    const out = $("auth-result");
    try {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await readJson(r);
      if (r.ok && body && typeof body === "object" && "token" in body) {
        const token = body.token;
        if (typeof token === "string") setToken(token);
        updateTokenPreview();
      }
      showPre(out, { ok: r.ok, status: r.status, body }, !r.ok);
    } catch (e) {
      showPre(out, { error: e instanceof Error ? e.message : String(e) }, true);
    }
  });

  $("form-login").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const fd = new FormData(form);
    const payload = {
      email: String(fd.get("email") ?? ""),
      password: String(fd.get("password") ?? ""),
    };
    const out = $("auth-result");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await readJson(r);
      if (r.ok && body && typeof body === "object" && "token" in body) {
        const token = body.token;
        if (typeof token === "string") setToken(token);
        updateTokenPreview();
      }
      showPre(out, { ok: r.ok, status: r.status, body }, !r.ok);
    } catch (e) {
      showPre(out, { error: e instanceof Error ? e.message : String(e) }, true);
    }
  });

  $("form-create-meeting").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const token = getToken();
    const out = $("meetings-result");
    if (!token) {
      showPre(out, { error: "Log in or register first (no JWT in localStorage)." }, true);
      return;
    }
    const fd = new FormData(form);
    const titleRaw = fd.get("title");
    const bodyPayload =
      typeof titleRaw === "string" && titleRaw.trim().length > 0
        ? { title: titleRaw.trim() }
        : {};
    try {
      const r = await fetch("/api/meetings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(bodyPayload),
      });
      const body = await readJson(r);
      showPre(out, { ok: r.ok, status: r.status, body }, !r.ok);
    } catch (e) {
      showPre(out, { error: e instanceof Error ? e.message : String(e) }, true);
    }
  });

  $("form-get-meeting").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const fd = new FormData(form);
    const code = String(fd.get("code") ?? "").trim();
    const out = $("meetings-result");
    if (code.length === 0) {
      showPre(out, { error: "Enter a meeting code." }, true);
      return;
    }
    try {
      const r = await fetch(`/api/meetings/${encodeURIComponent(code)}`);
      const body = await readJson(r);
      showPre(out, { ok: r.ok, status: r.status, body }, !r.ok);
    } catch (e) {
      showPre(out, { error: e instanceof Error ? e.message : String(e) }, true);
    }
  });
}

$("btn-refresh-status").addEventListener("click", () => {
  void refreshStatus();
});

$("btn-clear-token").addEventListener("click", () => {
  clearToken();
  updateTokenPreview();
});

wireForms();
updateTokenPreview();
void refreshStatus();
