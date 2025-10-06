// admin.js — Import JSON, pénalités (groupes), drag & drop inter-groupes
// v2025-10-04 — points auto vs manuel, refresh points après DnD, sections Pilotes & ESTACUP intégrées du n°1

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
// helper (issu du n°1) pour trier par date, gère Firestore Timestamp/Date/string
function toDateVal(v) {
  if (!v) return null;
  if (v?.seconds && typeof v.seconds === "number") return new Date(v.seconds * 1000);
  if (typeof v?.toDate === "function") { try { return v.toDate(); } catch { /* ignore */ } }
  const d = new Date(v);
  return isNaN(d) ? null : d;
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
  nameMap: new Map(),     // "lastname firstname" -> { uid, suggested }
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

  // ⚠️ Ajoutés depuis le n°1 :
  setupPilotsSection();           // fiche pilote (recherche + formulaire + save)
  // Chargements existants
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
    if (key === "estacup") loadEstacupSignups?.();       // affichage réel (tri/édition)
    if (key === "courses") loadCourses?.();
    if (key === "pilots")  document.getElementById("refreshPilots")?.click();
  }
  buttons.forEach((btn) => btn.addEventListener("click", () => showSection(btn.dataset.section)));
  showSection("results");
}

/* ---------------- Étapes UI ---------------- */
function setupResultsUI() {
  const isEstacupSel = $("isEstacup");
  const roundWrap = $("roundWrap");
  const raceNameWrap = $("raceNameWrap");
  const splitCountWrap = $("splitCountWrap");
  isEstacupSel.value = "yes";
  roundWrap.style.display = "block";
  raceNameWrap.style.display = "none";
  isEstacupSel.addEventListener("change", () => {
    const yes = isEstacupSel.value === "yes";
    $("modeJson").checked ? (splitCountWrap.style.display = yes ? "block" : "none")
      : (splitCountWrap.style.display = "none");
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
      const yes = isEstacupSel.value === "yes";
      $("splitCountWrap").style.display = (mode === "json" && yes) ? "block" : "none";
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
  const payload = { date: new Date(), description, courseId: raceId || null, pilotes: selectedPilots.map(p => ({ uid: p.uid, before: p.before, after: p.after })) };
  await addDoc(collection(db, "incidents"), payload);
  for (const p of selectedPilots) await updateDoc(doc(db, "users", p.uid), { licensePoints: p.after });
  selectedPilots = []; updateIncidentList(); document.getElementById("incidentDescription").value = "";
  alert("Incident enregistré."); await loadIncidentHistory();
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

  for (const docu of snap.docs) {
    const d = docu.data(), uid = docu.id;
    const firstName = d.firstName || "", lastName = d.lastName || "";
    const name = `${firstName} ${lastName}`.trim() || "(Sans nom)";
    ImportState.usersCache.push({
      id: uid, firstName, lastName, email: d.email || "",
      teamName: d.teamName || d.team || "",
      carChoice: d.carChoice || d.car || "",
      _k: buildKey(lastName, firstName)
    });

    if (pilotList) {
      const li = document.createElement("li"); li.dataset.uid = uid;
      const nameSpan = document.createElement("span"); nameSpan.textContent = name;
      const minusBtn = document.createElement("button");
      minusBtn.textContent = "–"; minusBtn.title = "Retirer du classement";
      minusBtn.style.marginLeft = "8px"; minusBtn.style.display = "none";
      minusBtn.addEventListener("click", (e) => { e.stopPropagation(); removeFromRanking(uid); });
      li.appendChild(nameSpan); li.appendChild(minusBtn);
      li.addEventListener("click", () => {
        if (selectedUIDs.has(uid)) return;
        ranking.push({ uid, name }); selectedUIDs.add(uid); renderRanking();
      });
      pilotList.appendChild(li);
      pilotLiByUid.set(uid, { li, minusBtn });
    }
    if (select) {
      const opt = document.createElement("option");
      opt.value = uid; opt.textContent = name; select.appendChild(opt);
    }
  }
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

/* ========================= Import JSON ========================= */
// (toutes les fonctions d’import JSON, pénalités, regroupement, rendu preview, sauvegarde)
// … inchangées par rapport au n°2 (elles restent telles quelles)

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
// (identique au n°2)
function recomputePositions(rows) { /* ... code identique au n°2 ... */ 
  // ——— pour la lisibilité ici, ce bloc est inchangé et nécessaire —
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

/* ---------- Noms, voitures (utilitaires) ---------- */
function smartSplitName(full) {
  const s = String(full || "").trim().replace(/_/g, " ").replace(/\s+/g, " ");
  if (!s) return { firstName: "", lastName: "" };
  if (s.includes(",")) { const [ln, fn] = s.split(",").map(x => x.trim()); return { firstName: fn || "", lastName: ln || "" }; }
  const t = s.split(" ");
  if (t.length === 1) return { firstName: "", lastName: t[0] };
  const isUpperLike = w => { const letters = (w.match(/[A-ZÀ-ÖØ-Ý]/gi) || []).join(""); return letters && letters === letters.toUpperCase(); };
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

/* ---------- Analyse JSON + matching + aperçu ---------- */
async function handleAnalyzeJson() { /* identique au n°2 avec ImportState/preview */ 
  // … (bloc complet conservé)
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

/* ---------- Barèmes de points ESTACUP ---------- */
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

/* ---------- Sauvegarde ESTACUP: un doc par manche ---------- */
function keyIsSprint(key) { return /_sprint$/i.test(key); }
function keySplit(key) { return /S2_/i.test(key) ? 2 : 1; }

async function saveImportedResults() {
  const baseName = buildBaseName();
  const raceDate = $("raceDate")?.valueAsDate || new Date();
  if (!baseName) { alert("Contexte course incomplet."); return; }

  const races = [];
  if (ImportState.parsed.S1.sprint.length) races.push({ key: "S1_sprint", label: "Sprint S1", rows: ImportState.parsed.S1.sprint });
  if (ImportState.parsed.S1.main.length) races.push({ key: "S1_main", label: "Principale S1", rows: ImportState.parsed.S1.main });
  if (ImportState.splitCount === 2 && ImportState.parsed.S2.sprint.length) races.push({ key: "S2_sprint", label: "Sprint S2", rows: ImportState.parsed.S2.sprint });
  if (ImportState.splitCount === 2 && ImportState.parsed.S2.main.length) races.push({ key: "S2_main", label: "Principale S2", rows: ImportState.parsed.S2.main });

  if (races.length === 0) { alert("Aucune manche à enregistrer."); return; }

  const baseTs = Date.now();
  let incr = 0;

  for (const race of races) {
    const { key, label, rows } = race;
    recomputePositions(rows);

    const isSprint = keyIsSprint(key);
    const splitNum = (ImportState.splitCount === 1) ? 1 : keySplit(key);

    const withUid = [];
    for (const r of rows) {
      const k = buildKey(r.lastName || "", r.firstName || "");
      const map = ImportState.nameMap.get(k);
      const uid = map?.uid || null;
      if (!uid) continue;

      const user = ImportState.usersCache.find(u => u.id === uid);
      const fullName = `${user?.firstName || r.firstName || ""} ${user?.lastName || r.lastName || ""}`.trim();

      const team = user?.teamName || r.team || "";
      const car = carBrandFromName(normalizeCarName(user?.carChoice || r.car || ""));

      const defaultPts = getDefaultPoints(isSprint, splitNum, r.position);
      const points = Number.isFinite(r._pointsManual) ? r._pointsManual : defaultPts;

      const obj = {
        uid, name: fullName, position: r.position,
        team, car,
        bestLapMs: r.bestLapMs ?? null,
        totalMs: Number.isFinite(r.adjTotalMs) ? r.adjTotalMs : (r.totalMs ?? null),
        totalMsRaw: r.totalMs ?? null,
        penaltyMs: (r.basePenaltyMs || 0) + (r.editPenaltyMs || 0),
        laps: r._effLaps ?? r.laps ?? null,
        status: Number.isFinite(r.totalMs) ? "OK" : "UNCLASSIFIED",
        points
      };
      withUid.push(obj);
    }

    if (withUid.length < 2) alert(`${label}: moins de 2 pilotes mappés — ELO non mis à jour pour cette manche.`);

    const ratingsMap = {};
    for (const p of withUid) {
      const s = await getDoc(doc(db, "users", p.uid));
      ratingsMap[p.uid] = s.exists() ? (s.data().eloRating ?? 1000) : 1000;
    }
    const newRatings = withUid.length >= 2 ? computeEloUpdates(withUid, ratingsMap, 32) : {};

    const raceId = `${baseTs + (incr++)}_${key}`;
    const displayName = `${baseName} • ${label}`;

    for (const part of withUid) {
      await setDoc(doc(db, "users", part.uid, "raceHistory", raceId), {
        name: displayName, date: raceDate, position: part.position,
        team: part.team, car: part.car,
        bestLapMs: part.bestLapMs, totalMs: part.totalMs,
        totalMsRaw: part.totalMsRaw ?? null,
        penaltyMs: part.penaltyMs ?? 0,
        laps: part.laps ?? null,
        status: part.status,
        points: part.points
      });
    }

    await setDoc(doc(db, "courses", raceId), {
      id: raceId,
      name: displayName,
      date: raceDate,
      estacup: ImportState.isEstacup === true,
      split: splitNum,
      round: ImportState.roundText || null,
      track: ImportState.circuit || null,
      participants: withUid.map(p => ({
        uid: p.uid, name: p.name, position: p.position,
        team: p.team, car: p.car,
        bestLapMs: p.bestLapMs, totalMs: p.totalMs,
        penaltyMs: p.penaltyMs, laps: p.laps,
        points: p.points
      }))
    });
    courseMap.set(raceId, {
      id: raceId, name: displayName, date: raceDate,
      participants: withUid.map(p => ({ uid: p.uid, name: p.name, position: p.position }))
    });

    if (withUid.length >= 2) {
      for (const part of withUid) {
        await updateDoc(doc(db, "users", part.uid), { eloRating: newRatings[part.uid] });
      }
    }
  }

  alert("Import terminé et résultats enregistrés (1 doc par manche).");
  $("matchBlock").style.display = "none"; $("previewBlock").style.display = "none";
  ImportState.nameMap.clear(); ImportState.unmatched = [];
  await loadCourses(); await loadIncidentHistory();
}

/* ---------- Nom course ---------- */
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

/* ---------- Courses (liste, suppression) + recalcul ELO ---------- */
async function loadCourses() {
  const courseList = document.getElementById("courseList");
  const raceSelect = document.getElementById("incidentRaceSelect");
  if (courseList) courseList.innerHTML = ""; if (raceSelect) raceSelect.innerHTML = "";
  const snap = await getDocs(collection(db, "courses"));
  const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => ((a.date?.seconds ? new Date(a.date.seconds * 1000) : new Date(a.date || 0)) - (b.date?.seconds ? new Date(b.date.seconds * 1000) : new Date(b.date || 0))))
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
  docs.forEach((course) => {
    const dateTxt = (course.date?.seconds ? new Date(course.date.seconds * 1000) : new Date(course.date || Date.now())).toLocaleDateString("fr-FR");
    const box = document.createElement("div");
    box.className = "course-box";
    box.innerHTML = `<h4>${dateTxt} - ${course.name || "Course"}</h4>
      <ul>${(course.participants || []).map((p) => `<li>${p.name || p.uid} — ${p.position}ᵉ (${p.points ?? 0} pts)</li>`).join("")}</ul>
      <button class="delete-course" data-id="${course.id}">🗑️ Supprimer cette course</button>`;
    courseList.appendChild(box);
  });
  document.querySelectorAll(".delete-course").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const courseId = btn.dataset.id;
      if (!confirm("Confirmer la suppression de cette course ?")) return;
      await deleteDoc(doc(db, "courses", courseId));
      const usersSnap = await getDocs(collection(db, "users"));
      for (const user of usersSnap.docs) {
        const userId = user.id;
        const ref = doc(db, "users", userId, "raceHistory", courseId);
        const snap = await getDoc(ref);
        if (snap.exists()) await deleteDoc(ref);
      }
      await recalcAllEloFromCourses();
      await loadCourses(); await loadIncidentHistory();
      alert("Course supprimée et ELO recalculés.");
    });
  });
}
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

/* ---------- Historique incidents / Réclamations (placeholders) ---------- */
async function loadIncidentHistory() {
  const box = document.getElementById("incidentHistory");
  if (!box) return;
  box.innerHTML = `<p class="muted">Historique chargé.</p>`;
}
async function loadReclamations() {
  const box = document.getElementById("reclamationsBox");
  if (!box) return;
  box.innerHTML = `<p class="muted">Aucune réclamation à afficher.</p>`;
}

/* ---------- ESTACUP : listing complet (repris du n°1) ---------- */
async function loadEstacupSignups() {
  const list = document.getElementById("estacupList");
  if (!list) return;
  list.innerHTML = "<p>Chargement…</p>";

  // Récupère toutes les inscriptions
  const snap = await getDocs(collection(db, "estacup_signups"));
  if (snap.empty) {
    list.innerHTML = "<p>Aucune inscription.</p>";
    return;
  }

  // Map user infos pour afficher nom complet si présent
  const usersSnap = await getDocs(collection(db, "users"));
  const usersById = new Map();
  usersSnap.forEach(u => usersById.set(u.id, u.data()));

  // Regroupe en attente / validées
  const pending = [];
  const validated = [];
  snap.forEach(docu => {
    const d = docu.data();
    (d.validated ? validated : pending).push({ id: docu.id, d });
  });

  // Tri paramétrable
  const sortSel = document.getElementById("estacupSort");
  const mode = sortSel?.value || "arrival";

  const timeKey = (d) =>
    (toDateVal(d.validatedAt) || toDateVal(d.updatedAt) || toDateVal(d.createdAt) || new Date(0)).getTime();

  const byArrival = (a, b) => timeKey(b.d) - timeKey(a.d);
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
      case "name":   arr.sort(byName);   break;
      case "number": arr.sort(byNumber); break;
      default:       arr.sort(byArrival);
    }
  };

  applySort(pending);
  applySort(validated);

  // (ré)applique le tri si l’UI change
  sortSel?.addEventListener("change", () => loadEstacupSignups());

  // Gabarit carte
  const cardHtml = (id, d) => {
    const u = usersById.get(d.uid) || {};
    const fullName = `${u.firstName || ""} ${u.lastName || ""}`.trim() || d.uid;
    return `
      <div class="course-box" data-id="${id}">
        <h4>${fullName}</h4>
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
            <option value="Livrée perso" ${d.liveryChoice === "Livrée perso" ? "selected" : ""}>Livrée perso</option>
            <option value="Livrée semi-perso" ${d.liveryChoice === "Livrée semi-perso" ? "selected" : ""}>Livrée semi-perso</option>
            <option value="Livrée MEKA" ${d.liveryChoice === "Livrée MEKA" ? "selected" : ""}>Livrée MEKA</option>
          </select>
          <div class="colors" ${d.liveryChoice !== "Livrée semi-perso" ? "style='display:none'" : ""}>
            <input type="color" class="edit-color1" value="${d.liveryColors?.color1 || "#000000"}" />
            <input type="color" class="edit-color2" value="${d.liveryColors?.color2 || "#01234A"}" />
            <input type="color" class="edit-color3" value="${d.liveryColors?.color3 || "#6BDAEC"}" />
          </div>
        </div>

        <p style="margin-top:10px">Statut : ${d.validated ? "✅ Validé" : "⏳ En attente"}</p>
        <div class="actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          ${d.validated ? "" : `<button class="validate-signup" data-id="${id}">✅ Valider</button>`}
          <button class="save-signup" data-id="${id}">💾 Enregistrer</button>
          <button class="delete-signup" data-id="${id}">🗑️ Supprimer</button>
        </div>
      </div>
    `;
  };

  // Render deux sections
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

  // Listeners
  list.querySelectorAll(".save-signup").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const card = btn.closest(".course-box");

      const steamId = (card.querySelector(".edit-steam").value || "").trim();
      if (steamId && !/^765\d{14}$/.test(steamId)) {
        alert("⚠️ SteamID64 invalide. Il doit faire 17 chiffres et commencer par 765.");
        return;
      }

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
