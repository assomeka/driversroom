// admin.js — Import JSON, pénalités (groupes), drag & drop inter-groupes
// v2025-10-10 — Liste repliable + éditeur qui REMPLACE la liste (mode plein écran)
// v2025-10-06 — FIX: Split visible en mode JSON même si ESTACUP = Non
// v2025-10-04 — points auto vs manuel, refresh points après DnD, sections Pilotes & ESTACUP intégrées du n°1
// + v2025-10-15 — 👈 Ajout : onglet "Votes" (admin) — agrégation Round 3 & Round 5
// + v2025-10-15-bis — Compat votes (q3/q5 et round3/round5) + fix barre B
// + v2025-10-16 — Amélioration affichage résumé voitures + badge livrée + licence éditable
// + v2025-10-16b — Tri des modèles par popularité + licence en select (Rookie / Challenger / Pro, coloré)
// + v2025-10-16c — Date dernière mise à jour par pilote + tri dédié

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  getDocs,
  getDoc,
  setDoc,
  updateDoc,
  doc,
  deleteDoc,
  addDoc,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------------- Firebase ---------------- */
const firebaseConfig = {
  apiKey: "AIzaSyDJ7uhvc31nyRB4bh9bVtkagaUksXG1fOo",
  authDomain: "estacupbymeka.firebaseapp.com",
  projectId: "estacupbymeka",
  storageBucket: "estacupbymeka.appspot.com",
  messagingSenderId: "1065406380441",
  appId: "1:1065406380441:web:55005f7d29290040c13b08"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ---------------- State ---------------- */
let ranking = [];
let selectedPilots = [];
let courseMap = new Map();
const selectedUIDs = new Set();
const pilotLiByUid = new Map();

/* ---------------- Utils ---------------- */
const $ = (id) => document.getElementById(id);
const stripAccents = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const normLower = s => stripAccents(s).toLowerCase().trim();
const buildKey = (lastName, firstName) => `${normLower(lastName)} ${normLower(firstName)}`.trim();
const escapeHtml = s => (s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const firstInt = str => { const m = String(str || "").match(/-?\d+/); return m ? parseInt(m[0], 10) : NaN; };
function formatMs(ms) {
  if (!Number.isFinite(ms) && ms !== 0) return "—";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  const ms3 = String(ms % 1000).padStart(3, "0");
  return (h > 0 ? `${h}:${mm}:${ss}.${ms3}` : `${m}:${ss}.${ms3}`);
}
function toDateVal(v) {
  if (!v) return null;
  if (v?.seconds && typeof v.seconds === "number") return new Date(v.seconds * 1000);
  if (typeof v?.toDate === "function") { try { return v.toDate(); } catch {} }
  const d = new Date(v);
  return isNaN(d) ? null : d;
}
function parseTimeLooseToMs(v, cap=6*60*60*1000) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const suf = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/i);
  if (suf) {
    const num = parseFloat(suf[1]);
    const ms = !suf[2] || suf[2].toLowerCase()==="s" ? Math.round(num*1000) : Math.round(num);
    return Math.min(ms, cap);
  }
  if (s.includes(":")) {
    const parts = s.replace(",", ".").split(":").map(x=>x.trim());
    const last = parseFloat(parts.pop());
    if (Number.isNaN(last)) return null;
    let mult = 1000, ms = Math.round(last*1000);
    while(parts.length){
      const n = parseInt(parts.pop(),10);
      if(Number.isNaN(n)) return null;
      ms += n*mult*60*1000;
      mult*=60;
    }
    return Math.min(ms, cap);
  }
  const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(s);
  if (iso) {
    const h=Number(iso[1]||0), m=Number(iso[2]||0), sec=Number(iso[3]||0);
    return Math.min(Math.round(((h*60+m)*60+sec)*1000), cap);
  }
  const f = parseFloat(s.replace(",", "."));
  if (Number.isFinite(f)) {
    const ms = f>10000 ? Math.round(f) : Math.round(f*1000);
    return Math.min(ms, cap);
  }
  return null;
}

/* ---------------- Import wizard state ---------------- */
const ImportState = {
  isEstacup: true,
  roundText: "",
  circuit: "",
  date: null,
  splitCount: 1,
  files: { sprintS1: null, mainS1: null, sprintS2: null, mainS2: null },
  parsed: { S1: { sprint: [], main: [] }, S2: { sprint: [], main: [] } },
  lapData: {},                 // <<< nouveau : tours bruts par manche
  nameMap: new Map(),
  unmatched: [],
  usersCache: []
};

/* ---------------- Bootstrap ---------------- */
onAuthStateChanged(auth, async (user) => {
  if (!user) return (window.location.href = "login.html");
  const snap = await getDoc(doc(db, "users", user.uid));
  if (!snap.exists() || snap.data().admin !== true) {
    document.body.innerHTML = "<p>Accès refusé</p>"; return;
  }
  document.getElementById("adminOnly")?.classList.remove("hidden");
  document.getElementById("adminName").textContent = snap.data().firstName || "";

  ensureDriversRoomButton();
  ensureRedLogoutButton();
  setupNavigation();

  setupPilotsSection();
  await loadPilots();
  await loadCourses();
  await loadIncidentHistory();
  await loadEstacupSignups();
  await loadReclamations();
  setupResultsUI();
});

/* ---------------- UI helpers ---------------- */
function ensureDriversRoomButton() {
  document.getElementById("goToDashboard")?.remove();
  const menu = document.querySelector(".admin-menu");
  if (!menu || document.getElementById("backToDriversRoom")) return;
  const btn = document.createElement("button");
  btn.id = "backToDriversRoom"; btn.type = "button"; btn.textContent = "Driver's Room";
  btn.addEventListener("click", () => (window.location.href = "dashboard.html"));
  menu.appendChild(btn);
}
function ensureRedLogoutButton() {
  const btn = document.getElementById("logout"); if (!btn) return;
  Object.assign(btn.style, { backgroundColor: "#e53935", borderColor: "#e53935", color: "#fff", fontWeight: "600", padding: "8px 12px", borderRadius: "10px" });
  btn.addEventListener("click", () => signOut(auth).then(() => (window.location.href = "login.html")));
}
function setupNavigation() {
  const buttons = document.querySelectorAll(".admin-menu button[data-section]");
  const sections = document.querySelectorAll(".admin-section");
  function showSection(key) {
    sections.forEach((s) => s.classList.add("hidden"));
    document.getElementById(`section-${key}`)?.classList.remove("hidden");
    if (key === "incidents") { loadReclamations?.(); loadIncidentHistory?.(); loadCourses?.(); loadPilots?.(); }
    if (key === "estacup") loadEstacupSignups?.();
    if (key === "courses") loadCourses?.();
    if (key === "votes")   loadVotesResults?.();
  }
  buttons.forEach((btn) => btn.addEventListener("click", () => showSection(btn.dataset.section)));
  showSection("results");
}

/* ---------------- Étapes UI (import résultats) ---------------- */
function setupResultsUI() {
  const isEstacupSel = $("isEstacup");
  const roundWrap = $("roundWrap");
  const raceNameWrap = $("raceNameWrap");
  const splitCountWrap = $("splitCountWrap");
  isEstacupSel.value = "yes";
  roundWrap.style.display = "block";
  raceNameWrap.style.display = "none";

  // FIX : le nombre de splits reste visible en mode JSON même si ESTACUP = Non
  isEstacupSel.addEventListener("change", () => {
    const yes = isEstacupSel.value === "yes";
    splitCountWrap.style.display = $("modeJson").checked ? "block" : "none";
    roundWrap.style.display = yes ? "block" : "none";
    raceNameWrap.style.display = yes ? "none" : "block";
  });

  const manualBox = $("manualBox");
  const jsonBox = $("jsonImportBox");
  const modeRadios = document.querySelectorAll('input[name="inputMode"]');
  modeRadios.forEach(r =>
    r.addEventListener("change", () => {
      const mode = document.querySelector('input[name="inputMode"]:checked').value;
      manualBox.style.display = (mode === "manual") ? "block" : "none";
      jsonBox.style.display = (mode === "json") ? "block" : "none";
      $("splitCountWrap").style.display = (mode === "json") ? "block" : "none";
    })
  );

  $("fileSprintS1")?.addEventListener("change", e => ImportState.files.sprintS1 = e.target.files?.[0] || null);
  $("fileMainS1")?.addEventListener("change", e => ImportState.files.mainS1 = e.target.files?.[0] || null);
  $("fileSprintS2")?.addEventListener("change", e => ImportState.files.sprintS2 = e.target.files?.[0] || null);
  $("fileMainS2")?.addEventListener("change", e => ImportState.files.mainS2 = e.target.files?.[0] || null);
  $("splitCount")?.addEventListener("change", e => {
    ImportState.splitCount = parseInt(e.target.value, 10) || 1;
    $("split2Wrap").style.display = (ImportState.splitCount === 2) ? "block" : "none";
  });

  $("analyzeJson")?.addEventListener("click", handleAnalyzeJson);
  $("applyMatching")?.addEventListener("click", applyMatchingSelections);
  $("submitJsonResults")?.addEventListener("click", saveImportedResults);

  $("modeManual").dispatchEvent(new Event("change"));
}

/* ---------------- Classement manuel (UI) ---------------- */
function renderRanking() {
  const ol = document.getElementById("rankingList"); if (!ol) return;
  ol.innerHTML = "";
  ranking.forEach((p, idx) => {
    const li = document.createElement("li");
    li.textContent = `${idx + 1}. ${p.name}`;
    ol.appendChild(li);
  });
  updatePilotListSelections();
}
function removeFromRanking(uid) {
  const idx = ranking.findIndex(r => r.uid === uid);
  if (idx !== -1) { ranking.splice(idx, 1); selectedUIDs.delete(uid); renderRanking(); }
}

/* ---------------- ELO ---------------- */
function computeEloUpdates(rankingArr, ratingsMap, K = 32) {
  const N = rankingArr.length;
  if (N < 2) return Object.fromEntries(rankingArr.map(p => [p.uid, ratingsMap[p.uid] ?? 1000]));
  const pos = Object.fromEntries(rankingArr.map((p, i) => [p.uid, p.position ?? (i + 1)]));
  const K_eff = K / (N - 1);
  const delta = Object.fromEntries(rankingArr.map(p => [p.uid, 0]));
  for (let i = 0; i < N; i++) {
    const ui = rankingArr[i].uid, Ri = ratingsMap[ui] ?? 1000;
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const uj = rankingArr[j].uid, Rj = ratingsMap[uj] ?? 1000;
      const Sij = pos[ui] < pos[uj] ? 1 : (pos[ui] > pos[uj] ? 0 : 0.5);
      const Eij = 1 / (1 + Math.pow(10, (Rj - Ri) / 400));
      delta[ui] += K_eff * (Sij - Eij);
    }
  }
  const CLAMP = 9999;
  const out = {};
  rankingArr.forEach(p => {
    const base = ratingsMap[p.uid] ?? 1000;
    const d = Math.max(-CLAMP, Math.min(CLAMP, delta[p.uid]));
    out[p.uid] = Math.round(base + d);
  });
  return out;
}

/* ---------------- Incidents ---------------- */
document.getElementById("addIncidentPilot")?.addEventListener("click", async () => {
  const select = document.getElementById("incidentPilotSelect");
  const uid = select?.value; if (!uid) return;
  const snap = await getDoc(doc(db, "users", uid)); if (!snap.exists()) return;
  const d = snap.data(); const name = `${d.firstName || ""} ${d.lastName || ""}`.trim() || uid;
  const before = d.licensePoints ?? 10; const after = before - 1;
  selectedPilots.push({ uid, name, before, after }); updateIncidentList();
});
function updateIncidentList() {
  const list = document.getElementById("incidentList"); if (!list) return;
  list.innerHTML = "";
  selectedPilots.forEach((p, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${p.name}</strong> — Avant : ${p.before} → <input type="number" value="${p.after}" data-i="${i}" style="width:100px;text-align:center;font-size:1.1em;padding:4px;" /> pts
      <button type="button" class="remove" data-i="${i}" title="Retirer">✖</button>`;
    list.appendChild(li);
  });
  list.querySelectorAll("input").forEach(inp => inp.addEventListener("input", (e) => {
    const idx = parseInt(e.target.dataset.i, 10); const val = parseInt(e.target.value, 10);
    if (!isNaN(val)) selectedPilots[idx].after = val;
  }));
  list.querySelectorAll(".remove").forEach(btn => btn.addEventListener("click", () => {
    const idx = parseInt(btn.dataset.i, 10); selectedPilots.splice(idx, 1); updateIncidentList();
  }));
}
document.getElementById("submitIncident")?.addEventListener("click", async () => {
  const description = document.getElementById("incidentDescription")?.value.trim();
  const raceId = document.getElementById("incidentRaceSelect")?.value || null;
  if (!description || selectedPilots.length === 0) { alert("Description et au moins un pilote requis."); return; }

  const adminName = (document.getElementById("adminName")?.textContent || "").trim();
  // On stocke aussi le nom pour l’affichage, en plus de l’uid
  const payload = {
    date: new Date(),
    description,
    courseId: raceId || null,
    pilotes: selectedPilots.map(p => ({ uid: p.uid, name: p.name, before: p.before, after: p.after })),
    createdByUid: (auth.currentUser && auth.currentUser.uid) || null,
    createdByName: adminName || null,
  };

  await addDoc(collection(db, "incidents"), payload);

  // Appliquer les points "après" sur chaque pilote
  for (const p of selectedPilots) {
    await updateDoc(doc(db, "users", p.uid), { licensePoints: p.after });
  }

  selectedPilots = [];
  updateIncidentList();
  document.getElementById("incidentDescription").value = "";
  alert("Incident enregistré.");
  await loadIncidentHistory();
});


/* ---------------- Pilotes (liste pour Résultats/Incidents) ---------------- */
async function loadPilots() {
  const pilotList = document.getElementById("pilotList");
  const select = document.getElementById("incidentPilotSelect");
  const snap = await getDocs(collection(db, "users"));

  if (pilotList) pilotList.innerHTML = "";
  if (select) {
    select.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = ""; opt0.textContent = "-- Sélectionner un pilote --";
    select.appendChild(opt0);
  }

  pilotLiByUid.clear();
  ImportState.usersCache = [];

  // récupérer et trier A→Z
  const users = snap.docs.map(docu => {
    const d = docu.data(), uid = docu.id;
    const firstName = d.firstName || "", lastName = d.lastName || "";
    const name = `${firstName} ${lastName}`.trim() || "(Sans nom)";
    return {
      id: uid, firstName, lastName, name,
      email: d.email || "",
      teamName: d.teamName || d.team || "",
      carChoice: d.carChoice || d.car || "",
      _k: buildKey(lastName, firstName)
    };
  }).sort((a,b)=> a.lastName.localeCompare(b.lastName, 'fr', {sensitivity:'base'}) || a.firstName.localeCompare(b.firstName, 'fr', {sensitivity:'base'}));

  for (const u of users) {
    ImportState.usersCache.push(u);

    if (pilotList) {
      const li = document.createElement("li"); li.dataset.uid = u.id;
      const nameSpan = document.createElement("span"); nameSpan.textContent = u.name;
      const minusBtn = document.createElement("button");
      minusBtn.textContent = "–"; minusBtn.title = "Retirer du classement";
      minusBtn.style.marginLeft = "8px"; minusBtn.style.display = "none";
      minusBtn.addEventListener("click", (e) => { e.stopPropagation(); removeFromRanking(u.id); });
      li.appendChild(nameSpan); li.appendChild(minusBtn);
      li.addEventListener("click", () => {
        if (selectedUIDs.has(u.id)) return;
        ranking.push({ uid: u.id, name: u.name }); selectedUIDs.add(u.id); renderRanking();
      });
      pilotList.appendChild(li);
      pilotLiByUid.set(u.id, { li, minusBtn });
    }
    if (select) {
      const opt = document.createElement("option");
      opt.value = u.id; opt.textContent = u.name; select.appendChild(opt);
    }
  }

  // remplissage auto de tous les <select data-pilots="alpha">
  document.querySelectorAll('select[data-pilots="alpha"]').forEach(sel=>{
    const cur = sel.value;
    sel.innerHTML = `<option value="">-- Pilote --</option>` + users.map(u=>{
      const label = `${u.firstName} ${u.lastName}`.trim() || u.email || u.id;
      return `<option value="${u.id}">${escapeHtml(label)}</option>`;
    }).join("");
    if (cur && users.some(u=>u.id===cur)) sel.value = cur;
  });

  updatePilotListSelections();
}
function updatePilotListSelections() {
  pilotLiByUid.forEach(({ li, minusBtn }, uid) => {
    const isSelected = selectedUIDs.has(uid);
    li.style.opacity = isSelected ? "0.8" : "1";
    li.style.fontWeight = isSelected ? "600" : "400";
    if (minusBtn) minusBtn.style.display = isSelected ? "inline-block" : "none";
  });
}

/* ---------------- Pilotes — section (search/refresh) ---------------- */
/* ---------- Gestion Pilotes (édition admin) — repris du n°1 ---------- */
function setupPilotsSection() {
  const search = document.getElementById("pilotSearch");
  const list = document.getElementById("pilotAdminList");
  const refresh = document.getElementById("refreshPilots");
  const form = document.getElementById("pilotForm");
  const formEmpty = document.getElementById("pilotFormEmpty");

  if (!list) return;

  const f_first = document.getElementById("pf_firstName");
  const f_last  = document.getElementById("pf_lastName");
  const f_email = document.getElementById("pf_email");
  const f_dob   = document.getElementById("pf_dob");
  const f_lid   = document.getElementById("pf_licenseId");
  const f_pts   = document.getElementById("pf_licensePoints");
  const f_cls   = document.getElementById("pf_licenseClass");
  const f_elo   = document.getElementById("pf_eloRating");
  const btnSave = document.getElementById("pf_save");
  const btnReset = document.getElementById("pf_reset");

  let allPilots = [];
  let current = null;

  async function fetchPilots() {
    list.innerHTML = "<li>Chargement…</li>";
    const snap = await getDocs(collection(db, "users"));
    allPilots = [];
    list.innerHTML = "";
    snap.forEach(d => { allPilots.push({ id: d.id, data: d.data() || {} }); });
    renderPilotList();
  }

  function match(p, q) {
    const txt = (q || "").trim().toLowerCase();
    if (!txt) return true;
    const d = p.data;
    const name = `${d.firstName || ""} ${d.lastName || ""}`.toLowerCase();
    const email = (d.email || "").toLowerCase();
    return name.includes(txt) || email.includes(txt);
  }

  function renderPilotList() {
    list.innerHTML = "";
    const q = search?.value || "";
    const items = allPilots
      .filter(p => match(p, q))
      .sort((a,b)=> {
        const an = `${a.data.firstName||""} ${a.data.lastName||""}`.trim().toLowerCase();
        const bn = `${b.data.firstName||""} ${b.data.lastName||""}`.trim().toLowerCase();
        return an.localeCompare(bn);
      });

    if (items.length === 0) { list.innerHTML = "<li>Aucun pilote.</li>"; return; }

    for (const p of items) {
      const li = document.createElement("li");
      const d = p.data;
      const name = `${d.firstName || ""} ${d.lastName || ""}`.trim() || "(Sans nom)";
      const cls = d.licenseClass || "Rookie";
      li.innerHTML = `<strong>${name}</strong><br><small>${d.email || ""}</small><br><small>Classe: ${cls} • E-Safety: ${d.licensePoints ?? 10} • E-Rating: ${d.eloRating ?? 1000}</small>`;
      li.style.cursor = "pointer";
      li.onclick = () => selectPilot(p);
      list.appendChild(li);
    }
  }

  function toDateInput(val) {
    try {
      if (!val) return "";
      if (val.seconds) {
        const d = new Date(val.seconds*1000);
        return d.toISOString().slice(0,10);
      }
      const d = new Date(val);
      if (!isNaN(d)) return d.toISOString().slice(0,10);
      return String(val);
    } catch { return ""; }
  }

  function selectPilot(p) {
    current = p;
    formEmpty?.classList.add("hidden");
    form?.classList.remove("hidden");

    const d = p.data || {};
    f_first.value = d.firstName || "";
    f_last.value  = d.lastName || "";
    f_email.value = d.email || "";
    f_dob.value   = toDateInput(d.dob || d.birthDate || d.birthday || d.dateNaissance || d.naissance);
    f_lid.value   = d.licenceId || d.licenseId || "";
    f_pts.value   = (d.licensePoints ?? 10);
    f_cls.value   = d.licenseClass || "Rookie";
    f_elo.value   = d.eloRating ?? 1000;
  }

  btnSave?.addEventListener("click", async () => {
    if (!current) return;
    const ref = doc(db, "users", current.id);
    const prevSnap = await getDoc(ref);
    const prev = prevSnap.exists() ? prevSnap.data() : {};

    const payload = {
      ...prev,
      firstName: f_first.value.trim() || prev.firstName || "",
      lastName:  f_last.value.trim()  || prev.lastName  || "",
      email:     f_email.value.trim() || prev.email     || "",
      licenceId: f_lid.value.trim()   || prev.licenceId || prev.licenseId || "",
      licenseId: f_lid.value.trim()   || prev.licenseId || prev.licenceId || "",
      licensePoints: Number(f_pts.value) || 0,
      licenseClass: f_cls.value || "Rookie"
      // eloRating non modifié depuis ici
    };

    const dobStr = f_dob.value.trim();
    if (dobStr) payload.dob = dobStr;

    await setDoc(ref, payload);
    alert("Pilote mis à jour.");
    await fetchPilots();
    const again = allPilots.find(x => x.id === current.id);
    if (again) selectPilot(again);
  });

  btnReset?.addEventListener("click", () => {
    if (!current) return;
    selectPilot(current);
    alert("Formulaire réinitialisé.");
  });

  refresh?.addEventListener("click", fetchPilots);
  search?.addEventListener("input", renderPilotList);

  fetchPilots();
}


/* ========================= Import JSON (parse) ========================= */
function readFileAsJson(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const fr = new FileReader();
    fr.onload = () => { try { resolve(JSON.parse(fr.result)); } catch (e) { reject(new Error("JSON invalide")); } };
    fr.onerror = () => reject(new Error("Lecture fichier échouée"));
    fr.readAsText(file);
  });
}
function sanitizeTimeString(s) { return String(s || "").trim().split(/\s+/)[0]; }
function parseIsoDurationToMs(s) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(String(s || "").trim());
  if (!m) return null;
  const h = Number(m[1] || 0), min = Number(m[2] || 0), sec = Number(m[3] || 0);
  return Math.round(((h * 60 + min) * 60 + sec) * 1000);
}
function looksLikeTimestamp(s) {
  const v = String(s || "");
  return v.includes("T") || v.includes("-") || (/^\d{1,2}:\d{2}:\d{2}(\.\d+)?$/.test(v) && parseInt(v.split(":")[0], 10) >= 12);
}
function toMsDuration(val, capsMs) {
  if (val == null) return null;
  if (typeof val === "number" && isFinite(val)) {
    const ms = val > 10000 ? Math.round(val) : Math.round(val * 1000);
    return ms > capsMs ? null : ms;
  }
  let s = String(val).trim();
  if (!s) return null;
  if (looksLikeTimestamp(s)) return null;
  const iso = parseIsoDurationToMs(s);
  if (iso != null) return iso > capsMs ? null : iso;
  s = sanitizeTimeString(s);
  const cleaned = s.replace(/^\+/, "").replace(/[,]/g, ".").replace(/\s+/g, "");
  const suf = cleaned.match(/^(\d+(?:\.\d+)?)(ms|s)?$/i);
  if (suf) {
    const num = parseFloat(suf[1]);
    const ms = (!suf[2] || suf[2].toLowerCase() === "s") ? Math.round(num * 1000) : Math.round(num);
    return ms > capsMs ? null : ms;
  }
  if (s.includes(":")) {
    const parts = s.split(":");
    const last = parts.pop().replace(",", ".");
    const minsOrHours = parts.map(x => parseInt(x, 10));
    const sec = parseFloat(last);
    if (minsOrHours.some(isNaN) || Number.isNaN(sec)) return null;
    let ms = Math.round(sec * 1000), mult = 1;
    while (minsOrHours.length) {
      const v = minsOrHours.pop();
      ms += v * mult * 60 * 1000;
      mult *= 60;
    }
    return ms > capsMs ? null : ms;
  }
  const num = Number(s.replace(/[,]/g, "."));
  if (Number.isFinite(num)) {
    const ms = num > 10000 ? Math.round(num) : Math.round(num * 1000);
    return ms > capsMs ? null : ms;
  }
  return null;
}
function looksLikeTimeString(v) { const s = String(v || ""); return s.includes(":") || /^PT/i.test(s) || /^[+]?[\d.,]+\s*(ms|s)?$/i.test(s); }
function extractPenaltyMs(it) {
  let penMs = 0; const MAX_ENTRY = 30 * 60 * 1000;
  const addMs = (ms) => { if (ms == null || !isFinite(ms) || ms < 0) return; penMs += Math.min(ms, MAX_ENTRY); };
  const cap = 6 * 60 * 60 * 1000;
  const singleFields = ["PenaltyTime", "PenaltySeconds", "PenaltyMs", "PenaltyMS", "Penalty", "AddedTime", "AddTime", "TimeAdded", "TimePenalty", "RaceTimePenalty"];
  for (const k of singleFields) if (it[k] != null) addMs(toMsDuration(it[k], cap));
  const arrays = [];
  if (Array.isArray(it.Penalties)) arrays.push(it.Penalties);
  if (Array.isArray(it.PenaltyList)) arrays.push(it.PenaltyList);
  if (Array.isArray(it.PenaltyArray)) arrays.push(it.PenaltyArray);
  if (it.Timing?.Penalties && Array.isArray(it.Timing.Penalties)) arrays.push(it.Timing.Penalties);
  for (const arr of arrays) for (const p of arr) {
    const cand = [p?.ms, p?.Ms, p?.MS, p?.Seconds, p?.Secs, p?.Value, p?.Amount, p?.Time, p?.TimeStr, p?.AddedTime];
    for (const c of cand) {
      if (c == null) continue;
      const got = looksLikeTimeString(c) ? toMsDuration(c, cap) : toMsDuration(Number(c), cap);
      if (got != null) addMs(got);
    }
  }
  return penMs;
}
function extractLaps(it) {
  const candidates = [
    it.Laps, it.LapCount, it.CompletedLaps, it.NumLaps, it.NumOfLaps, it.NumberOfLaps, it.RaceLaps,
    it.LapsCompleted, it.Completed, it.Timing && (it.Timing.Laps ?? it.Timing.CompletedLaps)
  ];
  for (const raw of candidates) {
    if (typeof raw === "number" && isFinite(raw)) return raw;
    const n = firstInt(raw);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

/* ================== CLASSEMENT + PÉNALITÉS + OVERRIDE (DnD) ================== */
function recomputePositions(rows) {
  if (!rows || rows.length === 0) return;

  rows.forEach(r => {
    r.adjTotalMs = Number.isFinite(r.totalMs)
      ? (r.totalMs + (r.basePenaltyMs || 0) + (r.editPenaltyMs || 0))
      : null;
  });

  const withTime = rows.filter(r => Number.isFinite(r.adjTotalMs));
  const noTime = rows.filter(r => !Number.isFinite(r.adjTotalMs));
  if (withTime.length === 0) return;

  const maxLaps = Math.max(...withTime.map(r => Math.max(0, r.laps || 0)));
  const contenders = withTime.filter(r => (r.laps || 0) === maxLaps);
  const leader = contenders.reduce((a, b) => (a.adjTotalMs <= b.adjTotalMs ? a : b));
  const leaderAdj = leader.adjTotalMs;
  const leaderLaps = maxLaps;

  const median = (arr) => { const a = arr.slice().sort((x, y) => x - y); const n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : NaN; };
  let lapRef = leaderLaps > 0 ? leaderAdj / leaderLaps : NaN;
  if (!Number.isFinite(lapRef) || lapRef <= 0) {
    const cands = withTime.filter(r => (r.laps || 0) > 0 && Number.isFinite(r.totalMs))
      .map(r => r.totalMs / (r.laps || 1))
      .filter(v => Number.isFinite(v) && v > 0);
    lapRef = median(cands);
  }
  if (!Number.isFinite(lapRef) || lapRef <= 0) lapRef = 60000;
  lapRef = Math.max(30000, Math.min(180000, Math.round(lapRef)));

  withTime.forEach(r => {
    const laps = Math.max(0, r.laps || 0);
    const baseDef = Math.max(0, leaderLaps - laps);
    const overMs = Math.max(0, r.adjTotalMs - leaderAdj);
    const extraDef = (laps >= leaderLaps) ? Math.floor(overMs / lapRef) : 0;
    let effDef = baseDef + extraDef;
    let effLaps = Math.max(0, leaderLaps - effDef);

    if (Number.isFinite(r._overrideGroup)) {
      effLaps = Math.max(0, Math.min(leaderLaps, Number(r._overrideGroup)));
      effDef = Math.max(0, leaderLaps - effLaps);
    }
    r._effDef = effDef;
    r._effLaps = effLaps;
  });

  const byGroup = new Map();
  withTime.forEach(r => {
    const g = r._effLaps || 0;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(r);
  });

  const groupsDesc = [...byGroup.keys()].sort((a, b) => b - a);
  const ordered = [];

  groupsDesc.forEach(g => {
    const arr = byGroup.get(g);
    arr.sort((a, b) => {
      const ma = Number.isFinite(a.manualOrder) ? a.manualOrder : null;
      const mb = Number.isFinite(b.manualOrder) ? b.manualOrder : null;
      if (ma !== null || mb !== null) {
        if (ma === null) return 1;
        if (mb === null) return -1;
        if (ma !== mb) return ma - mb;
      }
      const pa = a.positionHint || 9999, pb = b.positionHint || 9999;
      if (pa !== pb) return pa - pb;
      if (a.adjTotalMs !== b.adjTotalMs) return a.adjTotalMs - b.adjTotalMs;
      return 0;
    });
    ordered.push(...arr);
  });

  noTime.forEach(r => r._effLaps = Math.max(0, Math.min(leaderLaps, r.laps || 0)));
  noTime.sort((a, b) => {
    if ((a._effLaps || 0) !== (b._effLaps || 0)) return (b._effLaps || 0) - (a._effLaps || 0);
    const pa = a.positionHint || 9999, pb = b.positionHint || 9999;
    return pa - pb;
  });
  ordered.push(...noTime);

  ordered.forEach((r, i) => r.position = i + 1);

  const top = ordered[0];
  const topAdj = Number.isFinite(top?.adjTotalMs) ? top.adjTotalMs : null;
  const topDef = top?._effDef ?? 0;
  ordered.forEach(r => {
    if (!Number.isFinite(r.adjTotalMs)) { r._gapText = "—"; return; }
    if ((r._effDef || 0) !== topDef) {
      const lapsBehind = (r._effDef || 0) - topDef;
      r._gapText = `+${lapsBehind} lap${lapsBehind > 1 ? "s" : ""}`;
    } else {
      const diff = r.adjTotalMs - topAdj;
      r._gapText = diff === 0 ? "+0.000" : "+" + formatMs(diff);
    }
  });

  rows.splice(0, rows.length, ...ordered);
}

/* ---------- Extraction des résultats génériques ---------- */
function smartSplitName(full) {
  const s = String(full || "").trim().replace(/_/g, " ").replace(/\s+/g, " ");
  if (!s) return { firstName: "", lastName: "" };
  if (s.includes(",")) { const [ln, fn] = s.split(",").map(x => x.trim()); return { firstName: fn || "", lastName: ln || "" }; }
  const t = s.split(" ");
  if (t.length === 1) return { firstName: "", lastName: t[0] };
  const isUpperLike = w => { const letters = (w.match(/[A-Z À-ÖØ-Ý]/gi) || []).join(""); return letters && letters === letters.toUpperCase(); };
  if (t.length === 2) {
    const [a, b] = t;
    if (isUpperLike(a) && !isUpperLike(b)) return { firstName: b, lastName: a };
    if (isUpperLike(b) && !isUpperLike(a)) return { firstName: a, lastName: b };
    return { firstName: a, lastName: b };
  }
  const lastName = t[t.length - 1]; const firstName = t.slice(0, -1).join(" ");
  return { firstName, lastName };
}
const CAR_NAME_MAP = {
  "estacup_acura_nsx_gt3_evo2": "Acura NSX GT3 EVO 2",
  "estacup_audi_r8_lms_gt3_evo_ii": "Audi R8 LMS GT3 EVO II",
  "estacup_bmw_m4_gt3": "BMW M4 GT3",
  "estacup_ferrari_296_gt3": "Ferrari 296 GT3",
  "estacup_ford_mustang_gt3": "Ford Mustang GT3",
  "estacup_lamborghini_huracan_gt3_evo2": "Lamborghini Huracan GT3 EVO2",
  "estacup_lexus_rc_f_gt3": "Lexus RC F GT3",
  "estacup_mclaren_720S_gt3_evo": "McLaren 720S GT3 EVO",
  "estacup_mercedes_amg_gt3_evo": "Mercedes-AMG GT3 EVO",
  "estacup_porsche_911_gt3_r": "Porsche 911 GT3 R",
};
function normalizeCarName(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (CAR_NAME_MAP[s]) return CAR_NAME_MAP[s];
  let key = s.replace(/^estacup_/i, "");
  if (CAR_NAME_MAP[key]) return CAR_NAME_MAP[key];
  key = key.replace(/_/g, " ").trim();
  key = key.replace(/\bgt3\b/ig, "GT3")
    .replace(/\bevo ?ii\b/ig, "EVO II")
    .replace(/\bevo\b/ig, "EVO");
  return key.charAt(0).toUpperCase() + key.slice(1);
}
function carBrandFromName(normalized) {
  const s = String(normalized || "").trim();
  if (!s) return "";
  if (/^Mercedes[- ]?AMG/i.test(s)) return "Mercedes-AMG";
  return s.split(/\s+/)[0];
}
function extractResultsGeneric(json) {
  if (!json) return [];
  const rows = [];
  const pushGeneric = (it = {}) => {
    const rawName =
      it.DriverName || it.Driver || it.Name ||
      (it.Driver && (it.Driver.Name || `${it.Driver.FirstName || ""} ${it.Driver.LastName || ""}`.trim())) ||
      (it.CurrentDriver && (it.CurrentDriver.DriverName || `${it.CurrentDriver.FirstName || ""} ${it.CurrentDriver.LastName || ""}`.trim())) || "";
    const { firstName, lastName } = smartSplitName(rawName);
    const team = it.Team || it.TeamName || (it.Driver && it.Driver.Team) || "";
    const carRaw = it.CarModel || it.Car || it.Model || it.CarModelShort || (it.Vehicle || "");
    const carFull = normalizeCarName(carRaw);
    const carBrand = carBrandFromName(carFull);

    const bestCandidates = [
      it.BestLapTime, it.BestLapMs, it.BestLapMS, it.BestLap,
      it.Best && (it.Best.LapTime || it.Best.Time || it.Best.Value),
      it.BestLap && (it.BestLap.LapTime || it.BestLap.Time || it.BestLap.Value)
    ].filter(Boolean);
    let bestLapMs = null;
    for (const c of bestCandidates) { bestLapMs = toMsDuration(c, 10 * 60 * 1000); if (bestLapMs != null) break; }

    const totalCandidates = [
      it.TotalTime, it.TotalMs, it.TotalMS, it.Total, it.RaceTime, it.TotalRaceTime,
      it.Timing && (it.Timing.TotalTime || it.Timing.Time)
    ].filter(Boolean);
    let totalMs = null;
    for (const c of totalCandidates) { totalMs = toMsDuration(c, 6 * 60 * 60 * 1000); if (totalMs != null) break; }

    const laps = extractLaps(it);
    const basePenaltyMs = extractPenaltyMs(it) || 0;
    const editPenaltyMs = 0;

    rows.push({
      driverName: rawName, firstName, lastName, team: team || "",
      car: carFull, carBrand,
      bestLapMs, totalMs,
      basePenaltyMs, editPenaltyMs,
      adjTotalMs: Number.isFinite(totalMs) ? (totalMs + basePenaltyMs + editPenaltyMs) : null,
      laps: Number(laps) || 0,
      positionHint: Number(it.Position ?? it.Pos ?? it.Rank ?? it.Ranking ?? it.CarPosition) || 0,
      _pointsManual: undefined
    });
  };

  if (Array.isArray(json?.Result)) json.Result.forEach(pushGeneric);
  if (rows.length === 0 && Array.isArray(json?.Results)) json.Results.forEach(pushGeneric);
  if (rows.length === 0 && Array.isArray(json?.LeaderboardLines)) {
    json.LeaderboardLines.forEach(line => pushGeneric({
      DriverName: (line.CurrentDriver && (line.CurrentDriver.DriverName || `${line.CurrentDriver.FirstName || ""} ${line.CurrentDriver.LastName || ""}`.trim())) || line.DriverName,
      TeamName: line.TeamName, CarModel: line.CarModel || line.Car,
      BestLap: (line.BestLap && (line.BestLap.LapTime || line.BestLap.Value)) || line.BestLap,
      TotalTime: (line.Timing && (line.Timing.TotalTime || line.Timing.Time)) || line.TotalTime,
      Position: line.Position || line.CarPosition,
      Laps: (line.Timing && (line.Timing.Laps || line.Timing.CompletedLaps)) || line.Laps
    }));
  }
  if (rows.length === 0 && Array.isArray(json?.Cars)) json.Cars.forEach(pushGeneric);

  recomputePositions(rows);
  return rows;
}

/* ---------- Barèmes points ESTACUP ---------- */
const ESTACUP_POINTS = {
  sprint: {
    split1: [25, 22, 20, 18, 16, 14, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    split2: [6, 5, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1]
  },
  main: {
    split1: [50, 46, 42, 38, 34, 30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    split2: [12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 2, 2, 1, 1, 1]
  }
};
function getDefaultPoints(isSprint, split, position) {
  const effectiveSplit = (ImportState.splitCount === 1) ? 1 : split;
  const table = isSprint
    ? (effectiveSplit === 1 ? ESTACUP_POINTS.sprint.split1 : ESTACUP_POINTS.sprint.split2)
    : (effectiveSplit === 1 ? ESTACUP_POINTS.main.split1 : ESTACUP_POINTS.main.split2);
  return table[position - 1] || 0;
}

/* ---------- Aperçu + Drag & Drop inter-groupes ---------- */
function renderPreviewTables() {
  const block = $("previewBlock"); const root = $("resultsPreview"); if (!block || !root) return;

  const titleBase = buildBaseName();
  const makeTitle = (label) => String(`${titleBase} • ${label}`).replace(/\bFinale\b/i, "Principale");

  const makeTable = (title, rows) => {
    if (!rows || rows.length === 0) return "";
    recomputePositions(rows);

    const isSprint = /Sprint/i.test(title);
    const splitNum = /S2/i.test(title) ? 2 : 1;
    const isEstacup = ($("isEstacup")?.value === "yes");

    let html = `<div class="course-box" style="margin-top:10px">
      <h4 style="margin-top:0">${escapeHtml(title)}</h4>
      <div style="overflow:auto"><table class="race-table">
      <thead><tr>
      <th>#</th><th>Nom</th><th>Prénom</th><th>Équipe</th><th>Voiture</th>
      <th>Points</th><th>Best lap</th><th>Laps</th><th>Gap leader</th>
      <th>Pénalité JSON</th><th>Pénalité (s)</th><th></th><th>Total pénalité</th>
      </tr></thead>`;

    const groups = new Map();
    rows.forEach((r, idx) => {
      const g = r._effLaps || 0;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ r, idx });
    });
    const sortedGroups = [...groups.keys()].sort((a, b) => b - a);

    sortedGroups.forEach(g => {
      html += `<tbody data-group="${g}">`;
      groups.get(g).forEach(({ r, idx }) => {
        const mapKey = buildKey(r.lastName || "", r.firstName || "");
        const map = ImportState.nameMap.get(mapKey);
        const mappedUid = map?.uid || null;
        let team = r.team || "", carBrand = r.carBrand || "";
        if (mappedUid) {
          const user = ImportState.usersCache.find(u => u.id === mappedUid);
          if (user) {
            if (!team && user.teamName) team = user.teamName;
            if (!carBrand && user.carChoice) {
              const normalized = normalizeCarName(user.carChoice);
              carBrand = carBrandFromName(normalized);
            }
          }
        }

        const defaultPts = isEstacup ? getDefaultPoints(isSprint, splitNum, r.position) : 0;
        const pointsVal = Number.isFinite(r._pointsManual) ? r._pointsManual : defaultPts;

        html += `<tr data-idx="${idx}" style="cursor:move" draggable="true">
          <td>${r.position}</td>
          <td>${escapeHtml(r.lastName || "")}</td>
          <td>${escapeHtml(r.firstName || "")}</td>
          <td>${escapeHtml(team)}</td>
          <td>${escapeHtml(carBrand)}</td>
          <td><input class="points-input" type="number" step="1" min="0" style="width:80px;text-align:right" value="${pointsVal}"></td>
          <td>${formatMs(r.bestLapMs)}</td>
          <td>${r._effLaps ?? r.laps ?? "—"}</td>
          <td>${r._gapText || "—"}</td>
          <td>${Number(r.basePenaltyMs) > 0 ? ("+" + formatMs(r.basePenaltyMs)) : "—"}</td>
          <td>
            <input class="pen-edit" type="number" step="0.001" min="0" value="${(r.editPenaltyMs || 0) / 1000}"
                   style="width:90px;text-align:right" title="Pénalité additionnelle (en secondes)">
          </td>
          <td><button class="pen-apply">Appliquer</button></td>
          <td>${Number(r.basePenaltyMs + (r.editPenaltyMs || 0)) > 0 ? ("+" + formatMs(r.basePenaltyMs + (r.editPenaltyMs || 0))) : "—"}</td>
        </tr>`;
      });
      html += `</tbody>`;
    });

    html += `</table></div></div>`;
    return html;
  };

  let html = "";
  if (ImportState.parsed.S1.sprint.length) html += makeTable(`${makeTitle("Sprint S1")}`, ImportState.parsed.S1.sprint);
  if (ImportState.parsed.S1.main.length) html += makeTable(`${makeTitle("Principale S1")}`, ImportState.parsed.S1.main);
  if (ImportState.splitCount === 2 && ImportState.parsed.S2.sprint.length) html += makeTable(`${makeTitle("Sprint S2")}`, ImportState.parsed.S2.sprint);
  if (ImportState.splitCount === 2 && ImportState.parsed.S2.main.length) html += makeTable(`${makeTitle("Principale S2")}`, ImportState.parsed.S2.main);
  if (!html) html = `<p class="muted">Importer au moins un résultat pour afficher l’aperçu.</p>`;

  root.innerHTML = html; block.style.display = "block";

  // Drag & Drop inter-groupes + gestion pénas + écouteurs "points"
  root.querySelectorAll(".course-box").forEach((box) => {
    const title = box.querySelector("h4")?.textContent || "";
    let rowsRef = null;
    if (/Sprint S1/i.test(title)) rowsRef = ImportState.parsed.S1.sprint;
    else if (/Principale S1/i.test(title)) rowsRef = ImportState.parsed.S1.main;
    else if (/Sprint S2/i.test(title)) rowsRef = ImportState.parsed.S2.sprint;
    else if (/Principale S2/i.test(title)) rowsRef = ImportState.parsed.S2.main;
    if (!rowsRef) return;

    enableDragAndDropForBox(box, rowsRef);

    box.querySelectorAll("tbody tr").forEach((tr) => {
      const ridx = Number(tr.getAttribute("data-idx"));
      const inputPen = tr.querySelector(".pen-edit");
      const btnPen = tr.querySelector(".pen-apply");
      const ptsInput = tr.querySelector(".points-input");
      if (!rowsRef[ridx]) return;

      if (ptsInput) {
        ptsInput.addEventListener("input", () => {
          const val = Number(ptsInput.value);
          rowsRef[ridx]._pointsManual = Number.isFinite(val) ? val : undefined;
        });
      }

      if (inputPen && btnPen) {
        btnPen.addEventListener("click", () => {
          const sec = parseFloat(inputPen.value);
          rowsRef[ridx].editPenaltyMs = Number.isFinite(sec) && sec >= 0 ? Math.round(sec * 1000) : 0;
          recomputePositions(rowsRef);
          renderPreviewTables();
        });
      }
    });
  });
}

/* ---------- Drag & Drop helpers ---------- */
function reindexManualOrderForGroup(rows, effLaps) {
  const group = rows.filter(r => (r._effLaps || 0) === effLaps);
  group.forEach((r, i) => { r.manualOrder = i; });
}
function enableDragAndDropForBox(box, rowsRef) {
  box.querySelectorAll('tbody[data-group]').forEach(tbody => {
    tbody.addEventListener('dragover', (e) => { e.preventDefault(); });

    tbody.querySelectorAll('tr[draggable="true"]').forEach((tr) => {
      tr.addEventListener('dragstart', (e) => {
        const ridx = Number(tr.getAttribute('data-idx'));
        e.dataTransfer.setData('text/plain', String(ridx));
        tr.classList.add('dragging');
      });
      tr.addEventListener('dragend', () => { tr.classList.remove('dragging'); });
    });

    tbody.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromRidx = Number(e.dataTransfer.getData('text/plain'));
      if (!Number.isFinite(fromRidx) || !rowsRef[fromRidx]) return;
      const movingRow = rowsRef[fromRidx];

      const targetGroup = Number(tbody.dataset.group || 0);

      const allTargetTr = Array.from(tbody.querySelectorAll('tr'))
        .filter(tr => {
          const ridx = Number(tr.getAttribute('data-idx'));
          return Number.isFinite(ridx) && rowsRef[ridx];
        });

      const targetTr = e.target.closest('tr');
      let toDomIdx = allTargetTr.indexOf(targetTr);
      if (toDomIdx < 0) toDomIdx = allTargetTr.length;

      const targetRows = allTargetTr.map(tr => rowsRef[Number(tr.getAttribute('data-idx'))]);

      const prevIdxInTarget = targetRows.indexOf(movingRow);
      if (prevIdxInTarget >= 0) {
        targetRows.splice(prevIdxInTarget, 1);
        if (toDomIdx > prevIdxInTarget) toDomIdx--;
      }

      movingRow._overrideGroup = targetGroup;

      targetRows.splice(toDomIdx, 0, movingRow);
      targetRows.filter(Boolean).forEach((r, i) => { r.manualOrder = i; });

      const oldEff = movingRow._effLaps;
      recomputePositions(rowsRef);

      if (Number.isFinite(oldEff) && oldEff !== targetGroup) {
        reindexManualOrderForGroup(rowsRef, oldEff);
      }
      renderPreviewTables();
    });
  });
}

/* ---------- Sauvegarde import (1 doc/manche) ---------- */
function keyIsSprint(key) { return /_sprint$/i.test(key); }
function keySplit(key) { return /S2_/i.test(key) ? 2 : 1; }

async function handleAnalyzeJson() {
  const A = (v) => Array.isArray(v) ? v : (v ? [v] : []);

  ImportState.isEstacup = $("isEstacup")?.value === "yes";
  ImportState.roundText = $("estcRoundText")?.value?.trim() || "";
  ImportState.circuit = $("raceCircuit")?.value?.trim() || "";
  ImportState.date = $("raceDate")?.valueAsDate || new Date();
  ImportState.splitCount = parseInt($("splitCount")?.value, 10) || 1;

  const jSprintS1 = await readFileAsJson(ImportState.files.sprintS1).catch(() => null);
  const jMainS1 = await readFileAsJson(ImportState.files.mainS1).catch(() => null);
  const jSprintS2 = (ImportState.splitCount === 2) ? await readFileAsJson(ImportState.files.sprintS2).catch(() => null) : null;
  const jMainS2 = (ImportState.splitCount === 2) ? await readFileAsJson(ImportState.files.mainS2).catch(() => null) : null;
  // Tours bruts RealPenalty pour les graphes du dashboard
  ImportState.lapData = {
    S1_sprint: Array.isArray(jSprintS1?.Laps) ? jSprintS1.Laps : [],
    S1_main : Array.isArray(jMainS1?.Laps)   ? jMainS1.Laps   : [],
    S2_sprint: Array.isArray(jSprintS2?.Laps) ? jSprintS2.Laps : [],
    S2_main : Array.isArray(jMainS2?.Laps)   ? jMainS2.Laps   : []
  };

  const s1s = extractResultsGeneric(jSprintS1) || [];
  const s1m = extractResultsGeneric(jMainS1) || [];
  const s2s = extractResultsGeneric(jSprintS2) || [];
  const s2m = extractResultsGeneric(jMainS2) || [];

  ImportState.parsed.S1 = { sprint: A(s1s), main: A(s1m) };
  ImportState.parsed.S2 = { sprint: A(s2s), main: A(s2m) };

  ImportState.nameMap.clear();
  ImportState.unmatched = [];

  const allImported = []
    .concat(ImportState.parsed.S1.sprint || [],
      ImportState.parsed.S1.main || [],
      ImportState.parsed.S2.sprint || [],
      ImportState.parsed.S2.main || []);

  const seen = new Set();
  for (const r of allImported) {
    if (!r) continue;
    const key = `${(r.lastName || "").toLowerCase()} ${(r.firstName || "").toLowerCase()}`.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const match = suggestUserFor(r.lastName, r.firstName);
    if (match) ImportState.nameMap.set(key, { uid: match.id, suggested: true });
    else ImportState.unmatched.push({ key, lastName: r.lastName, firstName: r.firstName });
  }

  renderMatchingUI();
  renderPreviewTables();
}
function suggestUserFor(lastName, firstName) {
  const ln = normLower(lastName), fn = normLower(firstName);
  let hit = ImportState.usersCache.find(u => u._k === buildKey(lastName, firstName)); if (hit) return hit;
  hit = ImportState.usersCache.find(u => normLower(u.lastName) === ln); if (hit) return hit;
  hit = ImportState.usersCache.find(u => normLower(u.lastName).startsWith(ln)); if (hit) return hit;
  hit = ImportState.usersCache.find(u => normLower(u.lastName).includes(ln)); if (hit) return hit;
  hit = ImportState.usersCache.find(u => normLower(u.lastName).includes(ln) && normLower(u.firstName).charAt(0) === fn.charAt(0)); if (hit) return hit;
  return null;
}
function renderMatchingUI() {
  const block = $("matchBlock");
  const list = $("matchList");
  if (!block || !list) return;

  if (ImportState.unmatched.length === 0) {
    block.style.display = "none";
    list.innerHTML = "";
    return;
  }

  block.style.display = "block";
  list.innerHTML = "";

  const sorted = ImportState.usersCache
    .slice()
    .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));

  for (const u of ImportState.unmatched) {
    const div = document.createElement("div");
    div.style.marginBottom = "10px";

    const label = document.createElement("label");
    label.innerHTML = `<strong>${escapeHtml(u.lastName || "")} ${escapeHtml(u.firstName || "")}</strong> — sélectionner le pilote correspondant :`;

    const sel = document.createElement("select");
    sel.className = "match-select";
    sel.dataset.key = u.key;

    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "-- Aucun / laisser non assigné --";
    sel.appendChild(opt0);

    sorted.forEach(p => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `${stripAccents(p.lastName || "").toUpperCase()} ${p.firstName || ""} (${p.email || "?"})`;
      sel.appendChild(o);
    });

    div.appendChild(label);
    div.appendChild(sel);
    list.appendChild(div);
  }
}
function applyMatchingSelections() {
  document.querySelectorAll(".match-select").forEach(sel => {
    const key = sel.dataset.key;
    const uid = sel.value || null;
    if (uid) ImportState.nameMap.set(key, { uid, suggested: false });
  });
  renderPreviewTables();
  alert("Correspondances appliquées.");
}
async function saveImportedResults() {
  const baseName = buildBaseName();
  const raceDate = $("raceDate")?.valueAsDate || new Date();

  if (!baseName) {
    alert("Contexte course incomplet.");
    return;
  }

  const races = [];
  if (ImportState.parsed.S1.sprint.length) {
    races.push({
      key: "S1_sprint",
      label: "Sprint S1",
      rows: ImportState.parsed.S1.sprint
    });
  }
  if (ImportState.parsed.S1.main.length) {
    races.push({
      key: "S1_main",
      label: "Principale S1",
      rows: ImportState.parsed.S1.main
    });
  }
  if (ImportState.splitCount === 2 && ImportState.parsed.S2.sprint.length) {
    races.push({
      key: "S2_sprint",
      label: "Sprint S2",
      rows: ImportState.parsed.S2.sprint
    });
  }
  if (ImportState.splitCount === 2 && ImportState.parsed.S2.main.length) {
    races.push({
      key: "S2_main",
      label: "Principale S2",
      rows: ImportState.parsed.S2.main
    });
  }

  if (!races.length) {
    alert("Aucune manche à enregistrer.");
    return;
  }

  const baseTs = Date.now();
  let incr = 0;

  for (const race of races) {
    const { key, label, rows } = race;
    if (!rows || !rows.length) continue;

    // Recalcule proprement positions / gaps / pénalités
    recomputePositions(rows);

    const isSprint = keyIsSprint(key);
    const splitNum = (ImportState.splitCount === 1) ? 1 : keySplit(key);
    const rawLapsForRace = Array.isArray(ImportState.lapData?.[key])
      ? ImportState.lapData[key]
      : [];

    // Associer chaque ligne à un uid + infos pilote
    const withUid = [];
    for (const r of rows) {
      const nameKey = buildKey(r.lastName || "", r.firstName || "");
      const map = ImportState.nameMap.get(nameKey);
      const uid = map?.uid || null;
      if (!uid) continue;

      const user = ImportState.usersCache.find(u => u.id === uid);
      const fullName = `${user?.firstName || r.firstName || ""} ${user?.lastName || r.lastName || ""}`.trim();

      const team = user?.teamName || r.team || "";
      const car  = carBrandFromName(
        normalizeCarName(user?.carChoice || r.car || "")
      );

      const defaultPts = getDefaultPoints(isSprint, splitNum, r.position);
      const points = Number.isFinite(r._pointsManual)
        ? r._pointsManual
        : (ImportState.isEstacup ? defaultPts : 0);

      const bestLapMs   = Number.isFinite(r.bestLapMs) ? r.bestLapMs : null;
      const totalMsRaw  = Number.isFinite(r.totalMs)   ? r.totalMs   : null;
      const penaltyMs   = (r.basePenaltyMs || 0) + (r.editPenaltyMs || 0);
      const totalMsAdj  = Number.isFinite(totalMsRaw) ? (totalMsRaw + penaltyMs) : null;

      withUid.push({
        uid,
        name: fullName || uid,
        position: r.position,
        team,
        car,
        bestLapMs,
        totalMs: totalMsAdj,
        totalMsRaw,
        penaltyMs,
        laps: r._effLaps ?? r.laps ?? null,
        status: Number.isFinite(totalMsRaw) ? (r.status || "OK") : "UNCLASSIFIED",
        points
      });
    }

    if (!withUid.length) {
      console.warn("Aucun pilote mappé pour", label);
      continue;
    }

    // Id unique partagé entre doc "courses" et "raceHistory"
    const raceId = `${baseTs + (incr++)}_${key}`;
    const displayName = `${baseName} • ${label}`.replace(/\bFinale\b/i, "Principale");
    const lapData = rawLapsForRace.length ? { laps: rawLapsForRace } : null;

    // 1) Historique de course dans users/{uid}/raceHistory/{raceId}
    for (const p of withUid) {
      await setDoc(doc(db, "users", p.uid, "raceHistory", raceId), {
        name: displayName,
        date: raceDate,
        position: p.position,
        team: p.team || null,
        car: p.car || null,
        bestLapMs: p.bestLapMs ?? null,
        totalMs: p.totalMs ?? null,
        totalMsRaw: p.totalMsRaw ?? null,
        penaltyMs: p.penaltyMs ?? 0,
        laps: p.laps ?? null,
        status: p.status || "OK",
        points: p.points ?? 0,
        track: ImportState.circuit || null,
        split: splitNum,
        isSprint,
        estacup: ImportState.isEstacup === true
      });
    }

    // 2) Document global de course dans "courses"
    await setDoc(doc(db, "courses", raceId), {
      id: raceId,
      name: displayName,
      date: raceDate,
      estacup: ImportState.isEstacup === true,
      isEstacup: ImportState.isEstacup === true,
      split: splitNum,
      round: ImportState.roundText || null,
      track: ImportState.circuit || null,
      isSprint,
      participants: withUid.map(p => ({
        uid: p.uid,
        name: p.name,
        position: p.position,
        team: p.team,
        car: p.car,
        bestLapMs: p.bestLapMs,
        totalMs: p.totalMs,
        penaltyMs: p.penaltyMs,
        laps: p.laps,
        points: p.points,
        status: p.status
      })),
      ...(lapData ? { lapData } : {}),
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Cache local pour l’éditeur
    courseMap.set(raceId, {
      id: raceId,
      name: displayName,
      date: raceDate,
      participants: withUid.map(p => ({
        uid: p.uid,
        name: p.name,
        position: p.position
      }))
    });
  }

  // Recalcul global de l’ELO à partir de toutes les courses
  await recalcAllEloFromCourses();

  alert("Import terminé et résultats enregistrés (1 doc par manche).");
  const matchBlock = $("matchBlock");
  const previewBlock = $("previewBlock");
  if (matchBlock) matchBlock.style.display = "none";
  if (previewBlock) previewBlock.style.display = "none";
  ImportState.nameMap.clear();
  ImportState.unmatched = [];

  await loadCourses();
  await loadIncidentHistory();
}


function buildCourseHeader() {
  const baseName = buildBaseName();
  const raceDate = $("raceDate")?.valueAsDate || new Date();
  return { displayName: baseName, raceDate };
}
function buildBaseName() {
  const isEstacup = $("isEstacup")?.value === "yes";
  const circuit = $("raceCircuit")?.value?.trim() || "";
  if (isEstacup) {
    const roundText = $("estcRoundText")?.value?.trim();
    if (!roundText || !circuit) return "";
    return `ESTACUP • Round ${roundText} • ${circuit}`;
  } else {
    const name = $("raceName")?.value?.trim();
    if (!name || !circuit) return "";
    return `${name} • ${circuit}`;
  }
}

/* ============================================================================
   COURSES — LISTE REPLIABLE + MODE ÉDITEUR EN REMPLACEMENT
============================================================================ */
function ensureEditorScreen() {
  // conteneur plein écran pour l’éditeur (remplace la liste)
  let scr = $("courseEditorScreen");
  if (!scr) {
    scr = document.createElement("div");
    scr.id = "courseEditorScreen";
    scr.style.display = "none";
    const section = document.getElementById("section-courses") || document.body;
    section.appendChild(scr);
  }
  return scr;
}
function enterEditorMode() {
  const listWrap = document.getElementById("courseListWrap") || document.getElementById("courseList")?.parentElement || null;
  if (listWrap) listWrap.style.display = "none";
  ensureEditorScreen().style.display = "block";
}
function exitEditorMode() {
  const listWrap = document.getElementById("courseListWrap") || document.getElementById("courseList")?.parentElement || null;
  if (listWrap) listWrap.style.display = "";
  const scr = ensureEditorScreen();
  scr.style.display = "none";
  scr.innerHTML = "";
}
async function loadCourses() {
  const courseList = document.getElementById("courseList");
  const raceSelect = document.getElementById("incidentRaceSelect");
  if (courseList) courseList.innerHTML = "";
  if (raceSelect) raceSelect.innerHTML = "";

  const snap = await getDocs(collection(db, "courses"));
  const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const da = a.date?.seconds ? new Date(a.date.seconds * 1000) : new Date(a.date || 0);
      const dbb = b.date?.seconds ? new Date(b.date.seconds * 1000) : new Date(b.date || 0);
      return da - dbb;
    })
    .reverse();

  courseMap = new Map();
  for (const course of docs) {
    courseMap.set(course.id, course);
    if (raceSelect) {
      const opt = document.createElement("option");
      opt.value = course.id;
      const dateTxt = (course.date?.seconds ? new Date(course.date.seconds * 1000) : new Date(course.date || Date.now())).toLocaleDateString("fr-FR");
      opt.textContent = `${dateTxt} — ${course.name || "Course"}`;
      raceSelect.appendChild(opt);
    }
  }

  if (!courseList) return;
  if (docs.length === 0) { courseList.innerHTML = "<p>Aucune course.</p>"; return; }
  courseList.innerHTML = "";

  // wrapper pour pouvoir masquer/afficher la liste facilement
  if (!document.getElementById("courseListWrap")) {
    const wrap = document.createElement("div");
    wrap.id = "courseListWrap";
    courseList.parentElement?.insertBefore(wrap, courseList);
    wrap.appendChild(courseList);
  }

  // rendu repliable
  docs.forEach((course) => {
    const dateTxt = (course.date?.seconds ? new Date(course.date.seconds * 1000) : new Date(course.date || Date.now())).toLocaleDateString("fr-FR");
    const box = document.createElement("div");
    box.className = "course-box";

    const header = document.createElement("div");
    header.className = "course-header";
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.cursor = "pointer";
    header.innerHTML = `<h4 style="margin:0">${dateTxt} - ${escapeHtml(course.name || "Course")}</h4>
      <span class="chevron" aria-hidden="true" style="user-select:none">▸</span>`;

    const details = document.createElement("div");
    details.className = "course-details";
    details.style.display = "none";
    details.innerHTML = `
      <ul style="margin-top:8px">${(course.participants || [])
        .map((p) => `<li>${escapeHtml(p.name || p.uid)} — ${p.position ?? "?"}ᵉ (${p.points ?? 0} pts)</li>`)
        .join("")}</ul>
      <div class="actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="edit-course" data-id="${course.id}">✏️ Éditer</button>
        <button class="delete-course" data-id="${course.id}">🗑️ Supprimer</button>
      </div>`;

    header.addEventListener("click", () => {
      const open = details.style.display !== "none";
      details.style.display = open ? "none" : "block";
      const chev = header.querySelector(".chevron");
      if (chev) chev.textContent = open ? "▸" : "▾";
    });

    box.appendChild(header);
    box.appendChild(details);
    courseList.appendChild(box);
  });

  // supprimer
  document.querySelectorAll(".delete-course").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const courseId = btn.dataset.id;
      if (!confirm("Confirmer la suppression de cette course ?")) return;

      await deleteDoc(doc(db, "courses", courseId));

      // nettoyer raceHistory
      const usersSnap = await getDocs(collection(db, "users"));
      for (const user of usersSnap.docs) {
        const userId = user.id;
        const ref = doc(db, "users", userId, "raceHistory", courseId);
        const rh = await getDoc(ref);
        if (rh.exists()) await deleteDoc(ref);
      }
      await recalcAllEloFromCourses();
      await loadCourses(); await loadIncidentHistory();
      alert("Course supprimée et ELO recalculés.");
    });
  });

  // éditer → mode remplacement
  document.querySelectorAll(".edit-course").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openCourseEditor(btn.dataset.id, { replaceList: true });
    });
  });
}

/* ---------- Recalc ELO global ---------- */
async function recalcAllEloFromCourses() {
  const coursesSnap = await getDocs(collection(db, "courses"));
  const courses = coursesSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const da = a.date?.seconds ? new Date(a.date.seconds * 1000) : new Date(a.date || 0);
      const db = b.date?.seconds ? new Date(b.date.seconds * 1000) : new Date(b.date || 0);
      return da - db;
    });
  const usersSnap = await getDocs(collection(db, "users"));
  const elo = new Map(); usersSnap.forEach(u => elo.set(u.id, 1000));
  for (const c of courses) {
    const parts = (c.participants || []).filter(p => p && p.uid).map(p => ({ uid: p.uid, position: p.position ?? 9999, name: p.name }));
    if (parts.length < 2) continue;
    const ratingsMap = {}; parts.forEach(p => { ratingsMap[p.uid] = elo.get(p.uid) ?? 1000; });
    const newRatings = computeEloUpdates(parts, ratingsMap, 32);
    parts.forEach(p => elo.set(p.uid, newRatings[p.uid]));
  }
  for (const [uid, r] of elo.entries()) await updateDoc(doc(db, "users", uid), { eloRating: Math.round(r) });
}

/* ============================================================================
   ÉDITEUR DE COURSE — maintenant en “plein écran” à la place de la liste
============================================================================ */
function msToEditable(ms) {
  if (!Number.isFinite(ms)) return "";
  const h = Math.floor(ms/3600000);
  const m = Math.floor((ms%3600000)/60000);
  const s = (ms%60000)/1000;
  const sFixed = s.toFixed(3).padStart(6,"0");
  if (h>0) return `${h}:${String(m).padStart(2,"0")}:${sFixed}`;
  return `${m}:${sFixed}`;
}
async function openCourseEditor(courseId, opts = { replaceList: false }) {
  const c = courseMap.get(courseId) || (await getDoc(doc(db,"courses",courseId)).then(s=>s.exists()?s.data():null));
  if (!c) {
    if (opts.replaceList) {
      enterEditorMode();
      ensureEditorScreen().innerHTML = `<div class="course-box"><p>Course introuvable.</p><button id="backToListBtn">⟵ Retour à la liste</button></div>`;
      $("backToListBtn")?.addEventListener("click", exitEditorMode);
    } else {
      const panel = ensureCourseEditorShell(); panel.innerHTML = "<p>Course introuvable.</p>";
    }
    return;
  }

  // mode remplacement ?
  let root;
  if (opts.replaceList) {
    enterEditorMode();
    root = ensureEditorScreen();
  } else {
    root = ensureCourseEditorShell();
  }

  // users pour ajout
  const usersSnap = await getDocs(collection(db, "users"));
  const users = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const byId = new Map(users.map(u=>[u.id,u]));
  const optionsUsers = users
    .sort((a,b)=>(`${a.lastName||""} ${a.firstName||""}`).localeCompare(`${b.lastName||""} ${b.firstName||""}`))
    .map(u => `<option value="${u.id}">${escapeHtml(`${u.lastName||""} ${u.firstName||""}`.trim() || u.email || u.id)}</option>`)
    .join("");

  const parts = (c.participants||[]).slice().sort((a,b)=>(a.position||999)-(b.position||999));

  root.innerHTML = `
    <div class="course-box">
      <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap">
        <h3 style="margin:0">Édition — ${escapeHtml(c.name||"Course")} <small style="opacity:.7">(${courseId})</small></h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="saveCourseBtn" style="font-weight:600">💾 Enregistrer</button>
          <button id="closeEditorBtn">${opts.replaceList ? "⟵ Retour à la liste" : "Fermer l’éditeur"}</button>
        </div>
      </div>
      <p style="margin:.5rem 0">Date: ${toDateVal(c.date)?.toLocaleString?.("fr-FR") || "—"} • Split: ${c.split||1} • Estacup: ${c.estacup? "Oui":"Non"}</p>
      <div style="overflow:auto">
        <table class="race-table" id="editTable">
          <thead>
            <tr>
              <th>#</th><th>Pilote</th><th>UID</th><th>Équipe</th><th>Voiture</th>
              <th>BestLap (mm:ss.mmm)</th><th>Total (mm:ss.mmm)</th><th>+Pena (s)</th><th>Tours</th><th>Statut</th><th>Points</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${parts.map((p,i)=>{
              const u = byId.get(p.uid)||{};
              return `<tr data-uid="${p.uid}">
                <td><input class="ed-pos" type="number" min="1" value="${p.position||i+1}" style="width:64px;text-align:right"></td>
                <td>${escapeHtml(p.name || `${u.firstName||""} ${u.lastName||""}`.trim() || p.uid)}</td>
                <td><small>${escapeHtml(p.uid)}</small></td>
                <td><input class="ed-team" value="${escapeHtml(p.team||u.teamName||"")}" placeholder="Équipe" style="min-width:120px"></td>
                <td><input class="ed-car" value="${escapeHtml(p.car||u.carChoice||"")}" placeholder="Voiture" style="min-width:120px"></td>
                <td><input class="ed-best" value="${msToEditable(p.bestLapMs)}" placeholder="m:ss.mmm" style="width:120px;text-align:right"></td>
                <td><input class="ed-total" value="${msToEditable(p.totalMs)}" placeholder="m:ss.mmm" style="width:120px;text-align:right"></td>
                <td><input class="ed-pen" type="number" step="0.001" min="0" value="${(p.penaltyMs||0)/1000}" style="width:90px;text-align:right"></td>
                <td><input class="ed-laps" type="number" min="0" value="${p.laps ?? ""}" style="width:80px;text-align:right"></td>
                <td>
                  <select class="ed-status">
                    <option value="OK" ${p.status==="OK"?"selected":""}>OK</option>
                    <option value="DNF" ${p.status==="DNF"?"selected":""}>DNF</option>
                    <option value="DSQ" ${p.status==="DSQ"?"selected":""}>DSQ</option>
                    <option value="UNCLASSIFIED" ${p.status==="UNCLASSIFIED"?"selected":""}>UNCLASSIFIED</option>
                  </select>
                </td>
                <td><input class="ed-pts" type="number" step="1" min="0" value="${p.points ?? 0}" style="width:80px;text-align:right"></td>
                <td><button class="row-del">Retirer</button></td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>

      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px">
        <label>Ajouter un pilote :</label>
        <select id="addPilotSelect"><option value="">-- choisir --</option>${optionsUsers}</select>
        <button id="addPilotBtn">➕ Ajouter</button>
      </div>
      <p class="muted" style="margin-top:8px">Astuce : modifie les positions (#). À la sauvegarde, les lignes sont triées par position.</p>
    </div>
  `;

  // remove row
  root.querySelectorAll(".row-del").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const tr = btn.closest("tr");
      tr?.parentElement?.removeChild(tr);
    });
  });

  // add pilot
  root.querySelector("#addPilotBtn")?.addEventListener("click", ()=>{
    const sel = root.querySelector("#addPilotSelect");
    const uid = sel?.value || "";
    if (!uid) return;
    if (root.querySelector(`#editTable tbody tr[data-uid="${uid}"]`)) { alert("Pilote déjà présent."); return; }
    const u = byId.get(uid) || {};
    const name = `${u.firstName||""} ${u.lastName||""}`.trim() || u.email || uid;
    const tbody = root.querySelector("#editTable tbody");
    const tr = document.createElement("tr");
    tr.dataset.uid = uid;
    tr.innerHTML = `
      <td><input class="ed-pos" type="number" min="1" value="${(tbody.children.length+1)}" style="width:64px;text-align:right"></td>
      <td>${escapeHtml(name)}</td>
      <td><small>${escapeHtml(uid)}</small></td>
      <td><input class="ed-team" value="${escapeHtml(u.teamName||"")}" placeholder="Équipe" style="min-width:120px"></td>
      <td><input class="ed-car" value="${escapeHtml(u.carChoice||"")}" placeholder="Voiture" style="min-width:120px"></td>
      <td><input class="ed-best" value="" placeholder="m:ss.mmm" style="width:120px;text-align:right"></td>
      <td><input class="ed-total" value="" placeholder="m:ss.mmm" style="width:120px;text-align:right"></td>
      <td><input class="ed-pen" type="number" step="0.001" min="0" value="0" style="width:90px;text-align:right"></td>
      <td><input class="ed-laps" type="number" min="0" value="" style="width:80px;text-align:right"></td>
      <td>
        <select class="ed-status">
          <option value="OK" selected>OK</option>
          <option value="DNF">DNF</option>
          <option value="DSQ">DSQ</option>
          <option value="UNCLASSIFIED">UNCLASSIFIED</option>
        </select>
      </td>
      <td><input class="ed-pts" type="number" step="1" min="0" value="0" style="width:80px;text-align:right"></td>
      <td><button class="row-del">Retirer</button></td>
    `;
    tbody.appendChild(tr);
    tr.querySelector(".row-del").addEventListener("click", ()=>{ tr.remove(); });
  });

  // close/back
  root.querySelector("#closeEditorBtn")?.addEventListener("click", ()=>{
    if (opts.replaceList) exitEditorMode();
    else root.innerHTML = "";
  });

  // save
  root.querySelector("#saveCourseBtn")?.addEventListener("click", async ()=>{
    try {
      const tbody = root.querySelector("#editTable tbody");
      const rows = Array.from(tbody.querySelectorAll("tr"));
      if (rows.length === 0) {
        if (!confirm("Aucun participant — cela videra la course. Continuer ?")) return;
      }

      const participants = rows.map(tr=>{
        const uid = tr.dataset.uid;
        const pos = Number(tr.querySelector(".ed-pos")?.value || 9999);
        const team = tr.querySelector(".ed-team")?.value?.trim() || "";
        const car  = tr.querySelector(".ed-car")?.value?.trim() || "";
        const best = parseTimeLooseToMs(tr.querySelector(".ed-best")?.value);
        const total= parseTimeLooseToMs(tr.querySelector(".ed-total")?.value);
        const penS = parseFloat(tr.querySelector(".ed-pen")?.value || "0");
        const laps = tr.querySelector(".ed-laps")?.value;
        const status = tr.querySelector(".ed-status")?.value || "OK";
        const pts  = Number(tr.querySelector(".ed-pts")?.value || 0);
        const u = users.find(x=>x.id===uid) || {};
        const name = (c.participants||[]).find(p=>p.uid===uid)?.name || `${u.firstName||""} ${u.lastName||""}`.trim() || u.email || uid;
        return {
          uid,
          name,
          position: Number.isFinite(pos)?pos:9999,
          team,
          car,
          bestLapMs: Number.isFinite(best)?best:null,
          totalMs: Number.isFinite(total)?total:null,
          penaltyMs: Number.isFinite(penS) && penS>=0 ? Math.round(penS*1000) : 0,
          laps: laps!=="" ? Number(laps) : null,
          points: Number.isFinite(pts)?pts:0,
          status
        };
      })
      .filter(p=>p && p.uid)
      .sort((a,b)=> (a.position||9999)-(b.position||9999))
      .map((p,i)=> ({ ...p, position: i+1 }));

      const previous = (c.participants||[]).map(p=>p.uid);
      const nowUIDs = new Set(participants.map(p=>p.uid));

      await updateDoc(doc(db,"courses",courseId), { participants });

      for (const uid of previous) {
        if (!nowUIDs.has(uid)) {
          const ref = doc(db, "users", uid, "raceHistory", courseId);
          const rh = await getDoc(ref);
          if (rh.exists()) await deleteDoc(ref);
        }
      }
      for (const p of participants) {
        await setDoc(doc(db,"users",p.uid,"raceHistory",courseId), {
          name: c.name || "Course",
          date: c.date || new Date(),
          position: p.position,
          team: p.team || null,
          car: p.car || null,
          bestLapMs: p.bestLapMs ?? null,
          totalMs: p.totalMs ?? null,
          totalMsRaw: null,
          penaltyMs: p.penaltyMs ?? 0,
          laps: p.laps ?? null,
          status: p.status || "OK",
          points: p.points ?? 0
        });
      }

      await recalcAllEloFromCourses();

      alert("Résultats mis à jour.");
      await loadCourses();
      openCourseEditor(courseId, opts); // rester en mode éditeur
    } catch (e) {
      console.error(e);
      alert("Erreur lors de l’enregistrement des modifications.");
    }
  });
}

// fallback éditeur en bas de page (si jamais)
function ensureCourseEditorShell() {
  let panel = document.getElementById("courseEditPanel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "courseEditPanel";
    panel.className = "course-box";
    panel.style.marginTop = "16px";
    document.getElementById("courseList")?.parentElement?.appendChild(panel);
  }
  return panel;
}

/* ---------------- Historique incidents / Réclamations ---------------- */
async function loadIncidentHistory() {
  const box = document.getElementById("incidentHistory");
  if (!box) return;
  box.innerHTML = "<p>Chargement…</p>";

  // petit utilitaire
  const escapeHtmlLocal = (s) => (s||"").toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const toDateValLocal = (v) => v?.seconds ? new Date(v.seconds*1000) : (v ? new Date(v) : null);
  const nameByUid = (uid) => {
    const p = (ImportState.usersCache || []).find(x => x.id === uid);
    return p ? `${p.firstName} ${p.lastName}`.trim() : uid || "";
  };

  try {
    // Map des courses: id -> libellé
    const coursesSnap = await getDocs(collection(db, "courses"));
    const courseById = new Map();
    coursesSnap.forEach(c => {
      const d = c.data() || {};
      const when = d.date?.seconds ? new Date(d.date.seconds*1000) : (d.date ? new Date(d.date) : null);
      const whenTxt = when ? when.toLocaleDateString("fr-FR") : "";
      courseById.set(c.id, `${d.name || "Course"}${whenTxt ? ` (${whenTxt})` : ""}`);
    });

    // Récup incidents
    const incSnap = await getDocs(collection(db, "incidents"));
    const rows = [];
    incSnap.forEach(docu => {
      const x = docu.data() || {};
      rows.push({
        id: docu.id,
        date: toDateValLocal(x.date || x.createdAt || x.time) || null,
        courseId: x.courseId || x.raceId || null,
        description: x.description || x.note || x.reason || "",
        pilotes: Array.isArray(x.pilotes) ? x.pilotes.map(p => ({
          uid: p.uid,
          name: p.name || nameByUid(p.uid),
          before: Number.isFinite(p.before) ? p.before : null,
          after: Number.isFinite(p.after) ? p.after : null
        })) : [],
        createdByUid: x.createdByUid || null,
        createdByName: x.createdByName || ""
      });
    });
    rows.sort((a,b)=> (b.date?.getTime?.()||0) - (a.date?.getTime?.()||0));

    const me = auth.currentUser?.uid || null;
    const mine = rows.filter(r => r.createdByUid && me && r.createdByUid === me);

    function renderEditable(i) {
      const d = i.date ? i.date.toLocaleString("fr-FR") : "—";
      const courseLabel = i.courseId ? (courseById.get(i.courseId) || i.courseId) : "—";
      const who = i.createdByName ? ` — <span style="opacity:.7">par ${escapeHtmlLocal(i.createdByName)}</span>` : "";

      // lignes pilotes éditables (on ne modifie que "after" côté UI)
      const pilotsHtml = i.pilotes.map((p, idx) => {
        const delta = (Number.isFinite(p.before) && Number.isFinite(p.after)) ? (p.after - p.before) : 0;
        const deltaTxt = Number.isFinite(delta) ? ` (${delta>0?"+":""}${delta})` : "";
        return `
          <li style="margin:4px 0">
            <strong>${escapeHtmlLocal(p.name || nameByUid(p.uid))}</strong>
            — <span class="muted">avant:</span> ${p.before ?? "—"}
            → <span class="muted">après:</span>
            <input type="number" value="${p.after ?? ""}" data-idx="${idx}" data-id="${i.id}" style="width:90px;text-align:center" />
            <span style="opacity:.7">${deltaTxt}</span>
          </li>`;
      }).join("");

      return `
        <div class="course-box" data-id="${i.id}">
          <div class="muted" style="margin-bottom:6px"><strong>${d}</strong>${who}</div>
          <label class="muted">Course</label>
          <div style="margin-bottom:6px">
            <select class="hist-course">
              <option value="">—</option>
              ${Array.from(courseById.entries()).map(([cid,label]) =>
                `<option value="${cid}" ${cid===i.courseId?'selected':''}>${escapeHtmlLocal(label)}</option>`).join("")}
            </select>
          </div>
          <label class="muted">Description</label>
          <textarea class="hist-desc" rows="3" style="width:100%;margin-bottom:6px">${escapeHtmlLocal(i.description)}</textarea>
          <div><strong>Pilotes impactés</strong></div>
          <ul style="margin:6px 0 0 16px">${pilotsHtml}</ul>

          <div style="display:flex;gap:8px;margin-top:10px">
            <button type="button" class="hist-save">💾 Enregistrer</button>
            <button type="button" class="hist-del danger">🗑️ Supprimer</button>
          </div>
        </div>`;
    }

    let html = `<h4>Vos incidents enregistrés</h4>`;
    html += mine.length ? mine.map(renderEditable).join("") : `<p class="muted">Aucun incident saisi par vous pour l’instant.</p>`;
    html += `<details style="margin-top:16px"><summary style="cursor:pointer">Afficher tous les incidents</summary>`;
    html += rows.filter(r => !mine.includes(r)).map(renderEditable).join("") || `<p class="muted">Aucun autre incident.</p>`;
    html += `</details>`;
    box.innerHTML = html;

    // Handlers EDIT / DELETE
    box.querySelectorAll(".course-box").forEach(el => {
      const id = el.dataset.id;
      const descEl = el.querySelector(".hist-desc");
      const courseEl = el.querySelector(".hist-course");

      el.querySelector(".hist-save")?.addEventListener("click", async () => {
        // collecter les valeurs modifiées
        const inputs = [...el.querySelectorAll('input[type="number"][data-id="'+id+'"]')];
        const pilotes = inputs.map(inp => {
          const idx = +inp.dataset.idx;
          const p0 = (rows.find(r => r.id === id)?.pilotes || [])[idx];
          const after = parseInt(inp.value,10);
          return { uid: p0.uid, name: p0.name, before: p0.before, after: Number.isFinite(after) ? after : p0.after };
        });

        // MAJ doc
        await updateDoc(doc(db,"incidents",id), {
          description: descEl.value.trim(),
          courseId: courseEl.value || null,
          pilotes
        });

        // Appliquer les points “après” aux users
        for (const p of pilotes) {
          if (Number.isFinite(p.after)) {
            await updateDoc(doc(db,"users",p.uid), { licensePoints: p.after });
          }
        }
        alert("Incident mis à jour.");
        await loadIncidentHistory();
      });

      el.querySelector(".hist-del")?.addEventListener("click", async () => {
        if (!confirm("Supprimer cet incident ?")) return;
        await deleteDoc(doc(db,"incidents",id));
        el.remove();
      });
    });
  } catch (e) {
    console.error(e);
    box.innerHTML = "<p>Erreur lors du chargement de l’historique.</p>";
  }
}


/* ======= RÉCLAMATIONS : inclut anciennes envoyées par admins + legacy ======= */
async function loadReclamations() {
  const box = document.getElementById("reclamationsBox");
  if (!box) return;

  // Toolbar + container
  box.innerHTML = `
    <div id="reclamToolbar" class="toolbar" style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
      <select id="reclamFilter">
        <option value="all">Toutes</option>
        <option value="user">Reçues (pilotes)</option>
        <option value="admin">Envoyées par admin</option>
      </select>
      <input id="reclamSearch" type="search" placeholder="Rechercher… (message, statut, pilote)" style="flex:1;min-width:220px" />
      <button type="button" id="reclamRefresh">Actualiser</button>
    </div>
    <div id="reclamList" class="cards"></div>
  `;

  const listEl = document.getElementById("reclamList");
  const filterEl = document.getElementById("reclamFilter");
  const searchEl = document.getElementById("reclamSearch");
  const refreshEl = document.getElementById("reclamRefresh");

  let all = [];

  function toDateValLocal(v) {
    if (!v) return null;
    if (v?.seconds) return new Date(v.seconds * 1000);
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
  const normLowerLocal = (s) => (s || "").toString().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
  const escapeHtmlLocal = (s) => (s||"").toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function normalizeRow(d, id, roleHint = "") {
    const row = { ...(d || {}) };
    row._id = id;

    // date (création de la réclamation)
    row._created =
      toDateValLocal(row.date) || toDateValLocal(row.createdAt) || toDateValLocal(row.sentAt) ||
      toDateValLocal(row.time) || toDateValLocal(row.timestamp) || null;

    // qui a écrit ?
    const flagAdmin = row.isAdmin === true || row.fromAdmin === true || row.admin === true ||
                      row.senderRole === "admin" || row.createdBy === "admin" || roleHint === "admin";
    const flagUser  = row.senderRole === "user" || row.createdBy === "user" || row.authorRole === "user";
    row._authorRole = flagAdmin ? "admin" : (row.authorRole || (flagUser ? "user" : ""));

    // statuts
    row.status = row.status || row.state || row.etat || "open";

    // identifiants utiles
    row.uid      = row.uid || row.userId || row.authorUid || row.pilotUid || row.driverUid || null; // plaignant
    row.pilotUid = row.pilotUid || row.uid || row.userId || row.driverUid || null;                  // cible éventuelle
    row.courseId = row.courseId || row.raceId || row.eventId || null;

    // notes admin
    row.adminNotes = row.adminNotes || row.notes || row.comment || "";

    // champs saisis côté pilote (legacy)
    row.courseText  = row.courseText  || row.raceName || row.course || "";
    row.pilotsText  = row.pilotsText  || row.pilots  || "";
    row.momentText  = row.momentText  || row.moment  || "";
    row.description = row.description || row.reason  || row.text || row.body || row.content || "";

    // nouveaux champs réclamation (V2)
    const rawRaceDate = row.raceDate || row.courseDate || row.dateCourse || row.race_date;
    row._raceDate = toDateValLocal(rawRaceDate);
    if (row.split === undefined || row.split === null) {
      row.split = row.splitNum ?? row.splitNumber ?? row.split_text ?? null;
    }
    row.youtubeUrl = row.youtubeUrl || row.videoUrl || row.link || row.video || row.youtube || "";

    // message synthèse (pour l’aperçu carte)
    if (!row.message || !row.message.trim()) {
      const parts = [];
      if (row._raceDate) parts.push(`Date: ${dateOnlyStr(row._raceDate)}`);
      if (row.split != null) parts.push(`Split ${row.split}`);
      if (row.courseText) parts.push(`Course: ${row.courseText}`);
      if (row.pilotsText) parts.push(`Pilote(s): ${row.pilotsText}`);
      if (row.momentText) parts.push(`Moment: ${row.momentText}`);
      if (row.description) parts.push(row.description);
      if (row.youtubeUrl) parts.push(`YouTube: ${row.youtubeUrl}`);
      row.message = parts.join(" • ");
    }

    return row;
  }

  async function fetchCollection(name, roleHint = "") {
    try {
      const snap = await getDocs(collection(db, name));
      return snap.docs.map(d => normalizeRow(d.data(), d.id, roleHint));
    } catch {
      return [];
    }
  }

  async function fetchAll() {
    const main          = await fetchCollection("reclamations", "");
    const adminA        = await fetchCollection("admin_reclamations", "admin");
    const adminB        = await fetchCollection("reclamations_admin", "admin");
    const legacyClaims  = await fetchCollection("claims", "");
    const legacyTickets = await fetchCollection("tickets", "");
    all = [...main, ...adminA, ...adminB, ...legacyClaims, ...legacyTickets]
      .sort((a, b) => (b._created?.getTime?.() || 0) - (a._created?.getTime?.() || 0));
  }

  function statusLabel(s) {
    const v = (s || "").toLowerCase();
    if (["in_progress","progress","en_cours"].includes(v)) return "En cours";
    if (["closed","close","fermee","résolue","resolved"].includes(v)) return "Close";
    return "Ouverte";
  }

  function pilotNameById(uid) {
    const p = (ImportState.usersCache || []).find(x => x.id === uid);
    return p ? `${p.firstName} ${p.lastName}`.trim() : "";
  }

  function dateStr(d) {
    if (!d) return "—";
    const dd = new Date(d);
    const y  = dd.getFullYear();
    const m  = String(dd.getMonth() + 1).padStart(2, "0");
    const da = String(dd.getDate()).padStart(2, "0");
    const hh = String(dd.getHours()).padStart(2, "0");
    const mi = String(dd.getMinutes()).padStart(2, "0");
    return `${da}/${m}/${y} ${hh}h${mi}`;
  }

  function dateOnlyStr(d) {
    if (!d) return "—";
    const dd = new Date(d);
    const y  = dd.getFullYear();
    const m  = String(dd.getMonth() + 1).padStart(2, "0");
    const da = String(dd.getDate()).padStart(2, "0");
    return `${da}/${m}/${y}`;
  }

  function applyFilters() {
    const q = normLowerLocal(searchEl.value);
    const mode = filterEl.value;
    let rows = all.slice();
    if (mode === "user")  rows = rows.filter(r => r._authorRole !== "admin");
    if (mode === "admin") rows = rows.filter(r => r._authorRole === "admin");
    if (q) rows = rows.filter(r => {
      const pile = [
        r.message, r.status, pilotNameById(r.uid), pilotNameById(r.pilotUid),
        r.adminNotes, r.courseText, r.pilotsText, r.momentText, r.description,
        r.youtubeUrl, r.split, dateOnlyStr(r._raceDate)
      ].join(" ");
      return normLowerLocal(pile).includes(q);
    });
    renderList(rows);
  }

  function renderList(rows) {
    listEl.innerHTML = "";
    if (!rows.length) {
      listEl.innerHTML = '<p class="muted">Aucune réclamation.</p>';
      return;
    }
    for (const r of rows) {
      const card = document.createElement("div");
      card.className = "card";
      card.style.cursor = "pointer";
      card.style.marginBottom = "8px";
      const author = pilotNameById(r.uid) || "Inconnu";
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:center">
          <div>
            <div style="font-weight:600">${escapeHtmlLocal(r.message).slice(0,140)}${r.message.length>140?'…':''}</div>
            <div class="muted" style="margin-top:4px">${escapeHtmlLocal(author)} • ${escapeHtmlLocal(statusLabel(r.status))}</div>
          </div>
          <div class="muted">${escapeHtmlLocal(dateStr(r._created))}</div>
        </div>
      `;
      card.addEventListener("click", () => openDetailCard(r));
      listEl.appendChild(card);
    }
  }

  function courseOptionsHtml(selectedId) {
    // options de courses préchargées dans courseMap (via loadCourses)
    const keys = Array.from(courseMap?.keys?.() || []);
    const opts = ['<option value="">— Course —</option>'];
    for (const id of keys) {
      const c = courseMap.get(id);
      const d = (c?.date?.seconds ? new Date(c.date.seconds * 1000) : new Date(c?.date || Date.now())).toLocaleDateString("fr-FR");
      const line = `${d} — ${c?.name || "Course"}`;
      opts.push(`<option value="${id}" ${id===selectedId?'selected':''}>${escapeHtmlLocal(line)}</option>`);
    }
    return opts.join("");
  }

  function openDetailCard(row) {
    const author = pilotNameById(row.uid) || pilotNameById(row.pilotUid) || row.authorName || row.author || row._authorRole || "";
    const html = `
      <div class="card" style="padding:12px">
        <button type="button" id="reclamBack" class="muted" style="margin-bottom:12px">← Retour</button>

        <div class="muted" style="margin-bottom:6px"><strong>Réclamation #${escapeHtmlLocal(row._id)}</strong> — ${escapeHtmlLocal(dateStr(row._created))}</div>

        <label style="display:block;margin-bottom:6px;font-weight:600">Message</label>
<div class="muted" style="background:#1113; padding:8px; border-radius:8px; margin-bottom:12px">
  <div><strong>Date de la course :</strong> ${escapeHtmlLocal(dateOnlyStr(row._raceDate))}</div>
  <div><strong>Split :</strong> ${row.split != null ? escapeHtmlLocal("Split " + row.split) : "—"}</div>
  <div><strong>Description :</strong> ${escapeHtmlLocal(row.description || "—")}</div>
  <div><strong>Vidéo :</strong> ${
    row.youtubeUrl
      ? `<a href="${escapeHtmlLocal(row.youtubeUrl)}" target="_blank" rel="noopener">Ouvrir la vidéo</a>`
      : "—"
  }</div>
</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div>
            <label class="muted">Pilote concerné</label>
            <select id="reclamPilot" data-pilots="alpha"></select>
          </div>
          <div>
            <label class="muted">Course liée</label>
            <select id="reclamCourse">${courseOptionsHtml(row.courseId || "")}</select>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
          <div>
            <label class="muted">Statut</label>
            <select id="reclamStatus">
              <option value="open">Ouverte</option>
              <option value="in_progress">En cours</option>
              <option value="closed">Close</option>
            </select>
          </div>
          <div>
            <label class="muted">Auteur</label>
            <input type="text" id="reclamAuthor" disabled value="${escapeHtmlLocal(author)}" />
          </div>
        </div>

        <div style="margin-top:12px">
          <label class="muted" style="display:block">Notes admin</label>
          <textarea id="reclamNotes" rows="4" style="width:100%"></textarea>
        </div>

        <div style="display:flex;gap:8px;margin-top:12px">
          <button type="button" id="reclamSave">Enregistrer</button>
          <button type="button" id="reclamDelete" class="danger">Supprimer</button>
        </div>
      </div>
    `;
    listEl.innerHTML = html;

    // alimenter select pilotes (A→Z)
    const pilotSel = document.getElementById("reclamPilot");
    pilotSel.setAttribute("data-pilots","alpha");
    pilotSel.innerHTML = '<option value="">-- Pilote --</option>';
    (ImportState.usersCache || []).forEach(p => {
      const o = document.createElement("option");
      const label = `${p.firstName} ${p.lastName}`.trim() || p.email || p.id;
      o.value = p.id; o.textContent = label; pilotSel.appendChild(o);
    });
    if (row.pilotUid) pilotSel.value = row.pilotUid;

    // autres champs
    document.getElementById("reclamStatus").value = (row.status || "open");
    document.getElementById("reclamNotes").value = row.adminNotes || "";

    // handlers
    document.getElementById("reclamBack").addEventListener("click", applyFilters);
    document.getElementById("reclamSave").addEventListener("click", async () => {
      const payload = {
        pilotUid: pilotSel.value || null,
        courseId: (document.getElementById("reclamCourse").value || "") || null,
        status: document.getElementById("reclamStatus").value || "open",
        adminNotes: document.getElementById("reclamNotes").value || "",
        updatedAt: new Date()
      };
      // sauvegarder dans la collection qui contient l'item
      const guessColl = row._id.includes("/") ? row._id.split("/")[0] : null;
      try {
        await updateDoc(doc(db, guessColl ? guessColl : "reclamations", row._id.replace(/^.*\//, "")), payload);
      } catch (e) {
        await updateDoc(doc(db, "reclamations", row._id), payload);
      }
      await fetchAll(); applyFilters();
    });
    document.getElementById("reclamDelete").addEventListener("click", async () => {
      if (!confirm("Supprimer cette réclamation ?")) return;
      try {
        const guessColl = row._id.includes("/") ? row._id.split("/")[0] : null;
        await deleteDoc(doc(db, guessColl ? guessColl : "reclamations", row._id.replace(/^.*\//, "")));
      } catch (e) {
        await deleteDoc(doc(db, "reclamations", row._id));
      }
      await fetchAll(); applyFilters();
    });
  }

  refreshEl.addEventListener("click", async () => { await fetchAll(); applyFilters(); });
  filterEl.addEventListener("change", applyFilters);
  searchEl.addEventListener("input", applyFilters);

  // premier chargement
  await fetchAll();
  applyFilters();
}


/* ---------------- ESTACUP : listing & édition inscriptions ---------------- */
async function loadEstacupSignups() {
  const list = document.getElementById("estacupList");
  if (!list) return;
  list.innerHTML = "<p>Chargement…</p>";

  const snap = await getDocs(collection(db, "estacup_signups"));
  const usersSnap = await getDocs(collection(db, "users"));

  const usersById = new Map();
  usersSnap.forEach(u => usersById.set(u.id, u.data()));

  const carCount = new Map();

  if (snap.empty) {
    list.innerHTML = "<p>Aucune inscription.</p>";
    const carSummaryElEmpty = document.getElementById("estacupCarSummary");
    if (carSummaryElEmpty) {
      carSummaryElEmpty.textContent = "Aucune voiture sélectionnée pour l'instant.";
    }
    return;
  }

  const pending = [];
  const validated = [];
  snap.forEach(docu => {
    const d = docu.data();
    (d.validated ? validated : pending).push({ id: docu.id, d });

    const u = usersById.get(d.uid) || {};
    const rawCar = d.carChoice || u.carChoice || "";
    if (rawCar) {
      const normalized = normalizeCarName(rawCar);
      const key = normalized || rawCar;
      carCount.set(key, (carCount.get(key) || 0) + 1);
    }
  });

  // Résumé voitures avec affichage en "pills" triées du plus choisi au moins choisi
  const carSummaryEl = document.getElementById("estacupCarSummary");
  if (carSummaryEl) {
    if (carCount.size === 0) {
      carSummaryEl.textContent = "Aucune voiture sélectionnée pour l'instant.";
    } else {
      const itemsHtml = [...carCount.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fr", { sensitivity: "base" }))
        .map(([name, count]) => `
          <div class="car-summary-item">
            <span class="car-summary-label">${escapeHtml(name)}</span>
            <span class="car-summary-count">×${count}</span>
          </div>`).join("");
      carSummaryEl.innerHTML = `<div class="car-summary-grid">${itemsHtml}</div>`;
    }
  }

  const sortSel = document.getElementById("estacupSort");
  const mode = sortSel?.value || "arrival";

  const timeKey = (d) =>
    (toDateVal(d.validatedAt) || toDateVal(d.updatedAt) || toDateVal(d.createdAt) || new Date(0)).getTime();

  const lastUpdateDate = (d) =>
    toDateVal(d.updatedAt) || toDateVal(d.validatedAt) || toDateVal(d.createdAt) || null;

  const lastUpdateKey = (d) => {
    const dt = lastUpdateDate(d);
    return dt ? dt.getTime() : 0;
  };

  const formatLastUpdate = (d) => {
    const dt = lastUpdateDate(d);
    if (!dt) return "—";
    return dt.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
  };

  const byArrival = (a, b) => timeKey(b.d) - timeKey(a.d);
  const byUpdated = (a, b) => lastUpdateKey(b.d) - lastUpdateKey(a.d);
  const byName = (a, b) => {
    const la = `${a.d.lastName || ""}`.toLowerCase();
    const lb = `${b.d.lastName || ""}`.toLowerCase();
    if (la !== lb) return la.localeCompare(lb);
    const fa = `${a.d.firstName || ""}`.toLowerCase();
    const fb = `${b.d.firstName || ""}`.toLowerCase();
    return fa.localeCompare(fb);
  };
  const byNumber = (a, b) => (Number(a.d.raceNumber ?? 9999) - Number(b.d.raceNumber ?? 9999));

  const applySort = (arr) => {
    switch (mode) {
      case "updated":
        arr.sort(byUpdated); break;
      case "name":
        arr.sort(byName);   break;
      case "number":
        arr.sort(byNumber); break;
      default:
        arr.sort(byArrival);
    }
  };

  applySort(pending);
  applySort(validated);
  sortSel?.addEventListener("change", () => loadEstacupSignups());

  const cardHtml = (id, d) => {
    const u = usersById.get(d.uid) || {};
    const fullName = `${u.firstName || d.firstName || ""} ${u.lastName || d.lastName || ""}`.trim() || d.uid;

    const mSafety  = Number.isFinite(u.licensePoints) ? u.licensePoints : (d.licensePoints ?? 10);
    const mRating  = Number.isFinite(u.eloRating) ? u.eloRating : (d.eloRating ?? 1000);

    const rawLicense = u.licenseClass || d.licenseClass || "Rookie";
    const lcNorm = String(rawLicense || "").toLowerCase();
    const mLicense = lcNorm.includes("chall") ? "Challenger"
                     : lcNorm.includes("pro") ? "Pro"
                     : "Rookie";
    const licCss = mLicense.toLowerCase();

    const liveryChoice = d.liveryChoice || "Livrée perso";
    const liveryDone   = d.liveryDone === true;

    const colors = d.liveryColors || {};

    const lastUpdateText = formatLastUpdate(d);

    return `
      <div class="course-box" data-id="${id}" data-uid="${d.uid}">
        <div class="estacup-card-header">
          <h4>${fullName}</h4>
          <label class="livery-pill">
            <input type="checkbox" class="edit-liveryDone" ${liveryDone ? "checked" : ""} />
            Livrée réalisée
          </label>
        </div>

        <div class="muted" style="margin-bottom:4px">Inscription</div>
        <div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));align-items:center">
          <input class="edit-first" value="${d.firstName || ""}" placeholder="Prénom" />
          <input class="edit-last"  value="${d.lastName || ""}"  placeholder="Nom" />
          <input class="edit-age"   type="number" value="${d.age || ""}"    placeholder="Âge" />
          <input class="edit-email" value="${d.email || ""}"  placeholder="Email" />
          <input class="edit-steam" value="${d.steamId || ""}" placeholder="SteamID64 (765… 17 chiffres)" />
          <input class="edit-team"  value="${d.teamName || ""}" placeholder="Équipe" />
          <input class="edit-car"   value="${d.carChoice || ""}" placeholder="Voiture" />
          <input class="edit-number" type="number" min="1" max="999" value="${d.raceNumber ?? ""}" placeholder="N° de course (1-999)" />
          <select class="edit-livery">
            <option value="Livrée perso" ${liveryChoice === "Livrée perso" ? "selected" : ""}>Livrée perso</option>
            <option value="Livrée semi-perso" ${liveryChoice === "Livrée semi-perso" ? "selected" : ""}>Livrée semi-perso</option>
            <option value="Livrée MEKA" ${liveryChoice === "Livrée MEKA" ? "selected" : ""}>Livrée MEKA</option>
          </select>
          <div class="colors" ${liveryChoice !== "Livrée semi-perso" ? "style='display:none'" : ""}>
            <input type="color" class="edit-color1" value="${colors.color1 || "#000000"}" />
            <input type="color" class="edit-color2" value="${colors.color2 || "#01234A"}" />
            <input type="color" class="edit-color3" value="${colors.color3 || "#6BDAEC"}" />
          </div>
        </div>

        <div style="margin-top:10px;padding-top:8px;border-top:1px dashed #1f2937">
          <div class="muted" style="margin-bottom:4px">Licence</div>
          <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center">
            <span>M Safety : <strong>${mSafety}</strong></span>
            <span>M Rating : <strong>${mRating}</strong></span>
            <span>Licence :
              <select class="edit-licenseClass license-pill license-pill-${licCss}">
                <option value="Rookie" ${mLicense === "Rookie" ? "selected" : ""}>Rookie</option>
                <option value="Challenger" ${mLicense === "Challenger" ? "selected" : ""}>Challenger</option>
                <option value="Pro" ${mLicense === "Pro" ? "selected" : ""}>Pro</option>
              </select>
            </span>
          </div>
        </div>

        <div class="muted" style="margin-top:6px">Dernière mise à jour : ${escapeHtml(lastUpdateText)}</div>

        <p style="margin-top:10px">Statut : ${d.validated ? "✅ Validé" : "⏳ En attente"}</p>
        <div class="actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          ${d.validated ? "" : `<button class="validate-signup" data-id="${id}">✅ Valider</button>`}
          <button class="save-signup" data-id="${id}">💾 Enregistrer</button>
          <button class="delete-signup" data-id="${id}">🗑️ Supprimer</button>
        </div>
      </div>
    `;
  };

  list.innerHTML = `
    <section style="margin-bottom:20px">
      <h3>⏳ En attente (${pending.length})</h3>
      <div id="estacupListPending" style="display:flex;flex-direction:column;gap:12px"></div>
    </section>
    <section>
      <h3>✅ Validées (${validated.length})</h3>
      <div id="estacupListValidated" style="display:flex;flex-direction:column;gap:12px"></div>
    </section>
  `;

  const pendingRoot = document.getElementById("estacupListPending");
  const validatedRoot = document.getElementById("estacupListValidated");

  pending.forEach(({ id, d }) => pendingRoot.insertAdjacentHTML("beforeend", cardHtml(id, d)));
  validated.forEach(({ id, d }) => validatedRoot.insertAdjacentHTML("beforeend", cardHtml(id, d)));

  // handlers
  list.querySelectorAll(".save-signup").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const card = btn.closest(".course-box");

      const steamId = (card.querySelector(".edit-steam").value || "").trim();
      if (steamId && !/^765\d{14}$/.test(steamId)) {
        alert("⚠️ SteamID64 invalide. Il doit faire 17 chiffres et commencer par 765.");
        return;
      }

      const licenseClassInput = card.querySelector(".edit-licenseClass");
      const licenseClass = licenseClassInput ? (licenseClassInput.value || "").trim() : "";

      const payload = {
        firstName: card.querySelector(".edit-first").value.trim(),
        lastName:  card.querySelector(".edit-last").value.trim(),
        age:       Number(card.querySelector(".edit-age").value) || null,
        email:     card.querySelector(".edit-email").value.trim(),
        steamId:   steamId,
        teamName:  card.querySelector(".edit-team").value.trim(),
        carChoice: card.querySelector(".edit-car").value.trim(),
        raceNumber: Number(card.querySelector(".edit-number").value) || null,
        liveryChoice: card.querySelector(".edit-livery").value,
        liveryColors: null,
        liveryDone: card.querySelector(".edit-liveryDone")?.checked === true,
        licenseClass: licenseClass || null,
        updatedAt: new Date()
      };

      if (payload.liveryChoice === "Livrée semi-perso") {
        payload.liveryColors = {
          color1: card.querySelector(".edit-color1").value,
          color2: card.querySelector(".edit-color2").value,
          color3: card.querySelector(".edit-color3").value
        };
      }

      await updateDoc(doc(db, "estacup_signups", id), payload);

      const uid = card.dataset.uid;
      if (uid && licenseClass) {
        try {
          await updateDoc(doc(db, "users", uid), { licenseClass });
        } catch (e) {
          console.warn("Impossible de mettre à jour la licence du pilote", e);
        }
      }

      alert("Inscription mise à jour.");
      loadEstacupSignups();
    });
  });

  list.querySelectorAll(".edit-livery").forEach(sel => {
    sel.addEventListener("change", (e) => {
      const card = e.target.closest(".course-box");
      const colors = card.querySelector(".colors");
      if (e.target.value === "Livrée semi-perso") {
        colors.style.display = "block";
      } else {
        colors.style.display = "none";
      }
    });
  });

  // couleur de la licence (Rookie / Challenger / Pro)
  list.querySelectorAll(".edit-licenseClass").forEach(sel => {
    const applyClass = (el) => {
      el.classList.remove("license-pill-rookie","license-pill-challenger","license-pill-pro");
      const v = (el.value || "").toLowerCase();
      if (v === "rookie") el.classList.add("license-pill-rookie");
      else if (v === "challenger") el.classList.add("license-pill-challenger");
      else if (v === "pro") el.classList.add("license-pill-pro");
    };
    applyClass(sel);
    sel.addEventListener("change", () => applyClass(sel));
  });

  list.querySelectorAll(".validate-signup").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      await updateDoc(doc(db, "estacup_signups", id), { validated: true, validatedAt: new Date() });
      loadEstacupSignups();
    });
  });

  list.querySelectorAll(".delete-signup").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (confirm("Supprimer cette inscription ?")) {
        await deleteDoc(doc(db, "estacup_signups", id));
        loadEstacupSignups();
      }
    });
  });
}

/* =======================================================================
   👇 AJOUT — VOTES (admin) : lecture et agrégation estacup_votes
   Compat : q3/q5 (ancien) OU round3/round5 (nouveau Dashboard)
======================================================================= */
function normVote(val) {
  if (!val) return "";
  return String(val).trim().toLowerCase().replace(/[^a-z]/g,"");
}
function isShanghai(v){ const s=normVote(v); return s.startsWith("shang") || s.includes("shanghai"); }
function isSepang(v){ const s=normVote(v); return s.includes("sepang"); }
function isBahrain(v){ const s=normVote(v); return s.includes("bahrain"); }
function isLosail(v){ const s=normVote(v); return s.includes("losail") || s.includes("qatar"); }

function setVoteRow(prefix, aCnt, bCnt) {
  const total = aCnt + bCnt;
  const aPct = total ? Math.round((aCnt/total)*100) : 0;
  const bPct = total ? 100 - aPct : 0;

  const aCntEl = document.getElementById(`${prefix}_a_cnt`); 
  const bCntEl = document.getElementById(`${prefix}_b_cnt`);
  const aPctEl = document.getElementById(`${prefix}_a_pct`); 
  const bPctEl = document.getElementById(`${prefix}_b_pct`);
  const aBarEl = document.getElementById(`${prefix}_a_bar`);
  const bBarEl = document.getElementById(`${prefix}_b_bar`);
  const totEl  = document.getElementById(`${prefix}_total`);

  if (aCntEl) aCntEl.textContent = String(aCnt);
  if (bCntEl) bCntEl.textContent = String(bCnt);
  if (aPctEl) aPctEl.textContent = `${aPct}%`;
  if (bPctEl) bPctEl.textContent = `${bPct}%`;
  if (aBarEl) aBarEl.style.width = `${aPct}%`;
  if (bBarEl) bBarEl.style.width = `${bPct}%`;
  if (totEl)  totEl.textContent  = `Total : ${total}`;
}

async function loadVotesResults() {
  const q3 = { a:0, b:0 };  // a=Shanghai, b=Sepang
  const q5 = { a:0, b:0 };  // a=Bahrain,  b=Losail

  const snap = await getDocs(collection(db, "estacup_votes"));
  for (const d of snap.docs) {
    const v = d.data() || {};
    // ✅ compat : nouveau (round3/round5) prioritaire, sinon ancien (q3/q5)
    const r3 = (v.round3 !== undefined && v.round3 !== null) ? v.round3 : v.q3;
    const r5 = (v.round5 !== undefined && v.round5 !== null) ? v.round5 : v.q5;

    if (r3 !== undefined && r3 !== null) {
      if (isShanghai(r3)) q3.a++;
      else if (isSepang(r3)) q3.b++;
    }
    if (r5 !== undefined && r5 !== null) {
      if (isBahrain(r5)) q5.a++;
      else if (isLosail(r5)) q5.b++;
    }
  }

  setVoteRow("q3", q3.a, q3.b);
  setVoteRow("q5", q5.a, q5.b);
}

/* ---------------- Expose + Auto-load ---------------- */
window.loadCourses = loadCourses;

document.addEventListener("DOMContentLoaded", () => {
  if (
    document.querySelector("#section-courses") &&
    !document.querySelector("#section-courses").classList.contains("hidden")
  ) {
    loadCourses();
  }
});
