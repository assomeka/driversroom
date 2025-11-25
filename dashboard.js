// dashboard.js — Driver's Room : navigation + Résultats + Stats + ESTACUP
// Corrigé : lit bien les points saisis par l'admin + équipes depuis participants, raceHistory ou estacup_signups
// Ajout : colonne "Podiums" (seulement Split 1) dans le classement pilotes ESTACUP ; les victoires/podiums du Split 2 ne comptent pas.
// MAJ 2025-10-06 : lecture directe de penaltyMs ; classement équipes : enlève "manches comptées", ajoute Victoires/Podiums (Split 1 uniquement)
// MAJ 2025-10-06-d : 🧹 Supprime totalement les graphes (fonctions + appels + markup)
// MAJ 2025-10-06-fixEstacupOnly : les classements ESTACUP ne comptent que les courses avec estacup === true
// MAJ 2025-10-06-prioManualPoints : le dashboard affiche en priorité participants[].points (saisie admin)
// MAJ 2025-10-15 : Sous-menu "Vote Circuit" + 2 questions (Round 3 & Round 5) + validation unique + drapeaux (flag-icons) + stockage Firestore estacup_votes
// MAJ 2025-10-15-bis : Classement Équipes — ignore "(Sans équipe)" + loader animé pendant calcul (pilotes & équipes)
// MAJ 2025-10-30-fix-steamid : formulaire inscription redemande SteamID, tolère URL/ID64, enregistre steamId & steamID64.
// MAJ 2025-10-30-fix-display : suppression des backslashes dans les templates (plus de ${...} affichés en clair) + fix escapeHtml('>').

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  collection,
  getDocs,
  query,
  where,
  updateDoc,
  addDoc,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ======================== Firebase ======================== */
const firebaseConfig = {
  apiKey: "AIzaSyDJ7uhvc31nyRB4bh9bVtkagaUksXG1fOo",
  authDomain: "estacupbymeka.firebaseapp.com",
  projectId: "estacupbymeka",
  storageBucket: "estacupbymeka.appspot.com",
  messagingSenderId: "1065406380441",
  appId: "1:1065406380441:web:55005f7d29290040c13b08"
};
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

/* ======================== Utils ======================== */
const $ = (id) => document.getElementById(id);
const isNum = (x) => typeof x === "number" && isFinite(x);
const clamp = (x,min,max)=>Math.max(min,Math.min(max,x));
function toDate(value) {
  if (!value) return null;
  if (value?.seconds && typeof value.seconds === "number") return new Date(value.seconds * 1000);
  if (typeof value?.toDate === "function") { try { return value.toDate(); } catch {} }
  const d = new Date(value);
  return isNaN(d) ? null : d;
}
function formatDateFR(v) {
  const d = toDate(v);
  return d ? d.toLocaleDateString("fr-FR") : "";
}
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function msToClock(ms) {
  if (!isNum(ms)) return String(ms ?? "");
  const sign = ms < 0 ? "-" : "";
  const a = Math.abs(ms);
  const h = Math.floor(a / 3600000);
  const m = Math.floor((a % 3600000) / 60000);
  const s = Math.floor((a % 60000) / 1000);
  const ms3 = String(Math.floor(a % 1000)).padStart(3, "0");
  if (h > 0) return `${sign}${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${ms3}`;
  return `${sign}${m}:${String(s).padStart(2,"0")}.${ms3}`;
}
function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
}
/* Loader HTML */
const loaderHtml = (txt="Chargement…") => `<div class="loading-inline"><div class="spinner"></div><div>${escapeHtml(txt)}</div></div>`;

/* === SteamID helpers (tolérants) === */
function extractSteam64(input) {
  const m = String(input || "").match(/765\d{14}/);
  return m ? m[0] : "";
}

/* ======================== État global / caches ======================== */
let currentUid   = null;
let lastUserData = null;

/** Cache inscriptions : uid -> {teamName, raceNumber, carChoice} */
const signupCache = new Map();
/** Cache raceHistory : `${uid}::${raceId}` -> {points, team} */
const raceHistoryCache = new Map();

/* === Préchargement inscription ESTACUP (utile pour les équipes manquantes) === */
async function ensureSignupCache() {
  if (signupCache.size > 0) return;
  try {
    const snap = await getDocs(collection(db, "estacup_signups"));
    snap.forEach(d => {
      const x = d.data() || {};
      if (!x.uid) return;
      signupCache.set(x.uid, {
        teamName: (x.teamName || "").toString(),
        raceNumber: x.raceNumber,
        carChoice: x.carChoice
      });
    });
  } catch (e) {
    console.warn("Signup cache error:", e);
  }
}

/* === Accès raceHistory ciblé (pour récupérer points/équipe saisis côté pilote) === */
async function getRaceHistoryEntry(uid, raceId) {
  const key = `${uid}::${raceId}`;
  if (raceHistoryCache.has(key)) return raceHistoryCache.get(key);
  try {
    const rs = await getDoc(doc(db, "users", uid, "raceHistory", raceId));
    if (rs.exists()) {
      const r = rs.data() || {};
      const out = {
        points: toFiniteNumber(firstDefined(
          r.points, r.score, r.pts, r.estacupPoints, r.estacup?.points,
          r.classification?.points, r.result?.points
        )),
        team: (firstDefined(
          r.team, r.teamName, r.equipe, r.estacupTeam, r.estacup?.team
        ) || "").toString()
      };
      raceHistoryCache.set(key, out);
      return out;
    }
  } catch (e) {
    console.warn("raceHistory read error:", uid, raceId, e);
  }
  const out = { points: null, team: "" };
  raceHistoryCache.set(key, out);
  return out;
}
function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ======================== Navigation ======================== */
function setupNavigation(isAdmin = false) {
  const goToAdmin = $("goToAdmin");
  if (isAdmin && goToAdmin) goToAdmin.classList.remove("hidden");
  goToAdmin?.addEventListener("click", () => (window.location.href = "admin.html"));

  const buttons  = document.querySelectorAll('.menu button[data-section]');
  const sections = document.querySelectorAll('.section');

  function showSection(key) {
    sections.forEach(s => s.classList.add("hidden"));
    const el = document.getElementById(`section-${key}`);
    if (el) el.classList.remove("hidden");

    if (key === "results"  && currentUid) loadResults(currentUid);
    if (key === "erating"  && currentUid) loadMRating(currentUid);
    if (key === "esafety"  && currentUid) loadMSafety(currentUid);
    if (key === "estacup"  && lastUserData) {
      setupEstacupSubnav();
      showEstacupSub("inscription");
      setupMekaQuestionnaire(lastUserData);
      loadEstacupEngages();
      loadReclamHistory();
    }
  }

  buttons.forEach(btn => btn.addEventListener("click", () => showSection(btn.getAttribute("data-section"))));
  showSection("infos");
}

$("logout")?.addEventListener("click", () => signOut(auth).then(() => (window.location.href = "login.html")));

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "login.html"; return; }

  let userSnap = await getDoc(doc(db, "users", user.uid));
  if (!userSnap.exists()) {
    const map = await getDoc(doc(db, "authMap", user.uid));
    if (map.exists()) userSnap = await getDoc(doc(db, "users", map.data().pilotUid));
  }
  if (!userSnap.exists()) { alert("Profil introuvable."); return; }

  const data = userSnap.data();
  currentUid   = userSnap.id;
  lastUserData = data;

  $("fullName").textContent      = `${data.firstName ?? ""} ${data.lastName ?? ""}`.trim() || "—";
  $("licenseId").textContent     = data.licenceId || data.licenseId || "-";
  $("eloRating").textContent     = data.eloRating ?? 1000;
  $("licensePoints").textContent = data.licensePoints ?? 10;
  $("licenseClass").textContent  = data.licenseClass || "Rookie";
  $("dob").textContent           = formatDateFR(firstDefined(data.dob, data.birthDate, data.birthday, data.dateNaissance, data.naissance)) || "Non renseignée";
  $("steamIdLine").textContent   = data.steamID64 || data.steamId || "—";

  setupNavigation(data.admin === true);

  await ensureSignupCache();
  await loadResults(currentUid);
  await loadPilotStats(currentUid);
});

/* ======================== Lecture champs (robuste) ======================== */
function pick(obj, paths) {
  for (const p of paths) {
    const val = getByPath(obj, p);
    if (val !== undefined && val !== null && val !== "") return val;
  }
  return undefined;
}
function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split(".");
  let cur = obj;
  for (const k of parts) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, k)) {
      cur = cur[k];
    } else {
      return undefined;
    }
  }
  return cur;
}
function anyNumberMs(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (isFinite(n)) return n > 5000 ? n : n * 1000;
  }
  return null;
}
function splitNameParts(p) {
  const first = (pick(p, ["firstName","prenom","givenName","driver.firstName","pilot.firstName"]) ?? "").toString().trim();
  const last  = (pick(p, ["lastName","nom","familyName","driver.lastName","pilot.lastName"])   ?? "").toString().trim();
  if (first || last) return { first, last };
  const full = (pick(p, ["name","driver.name","pilot.name"]) ?? "").toString().trim();
  if (!full) return { first: "", last: "" };
  const parts = full.split(/\s+/);
  if (parts.length === 1) return { first: "", last: parts[0] };
  return { first: parts.slice(0, -1).join(" "), last: parts.slice(-1)[0] };
}
function pickCar(p) {
  return String(pick(p, ["car","carModel","voiture","vehicle","model","carChoice","car.label","car.name"]) ?? "");
}
function pickBestLapMs(p) {
  const direct = pick(p, [
    "bestLapMs","bestLap","bestLapTime","lapBest","best","best_time",
    "stats.bestLapMs","stats.bestLap","laps.best","laps.bestMs"
  ]);
  return anyNumberMs(direct);
}
function pickTotalTimeMs(p) {
  const direct = pick(p, [
    "adjTotalMs","totalMs","total_time_ms",
    "totalTime","raceTime","timeTotal","finishTime",
    "stats.adjTotalMs","stats.totalMs","stats.totalTime"
  ]);
  return anyNumberMs(direct);
}
function pickGapLeaderMsDirect(p) {
  const direct = pick(p, ["gapToLeader","gap_leader","gapLeader","gap","stats.gapLeader"]);
  return anyNumberMs(direct);
}

/* === PÉNALITÉS : ajout lecture directe penaltyMs (flat) === */
function pickPenaltyMs(p) {
  let total = 0;
  total += anyNumberMs(pick(p, ["basePenaltyMs","penalties.baseMs","stats.basePenaltyMs"])) || 0;
  total += anyNumberMs(pick(p, ["editPenaltyMs","penalties.editMs","stats.editPenaltyMs"])) || 0;
  total += anyNumberMs(pick(p, ["penaltyMs","penalty_ms","penaltyMS","stats.penaltyMs"])) || 0;
  total += anyNumberMs(pick(p, ["penaltyTime","penaltiesTime","addedTime","added_time","timePenalty"])) || 0;
  const pens = pick(p, ["penalties","stats.penalties"]);
  if (Array.isArray(pens)) for (const pen of pens) total += anyNumberMs(pen?.time, pen?.duration, pen?.addedTime, pen?.ms) || 0;
  return total || null;
}

/* === Chemins étendus pour POINTS posés par l'admin === */
function pickPointsLocal(p) {
  const v = firstDefined(
    pick(p, ["points","score","pts","stats.points"]),
    pick(p, ["result.points","classification.points","estacup.points"]),
    pick(p, ["adminPoints","pointsAdmin","manualPoints","overrides.points"]),
    pick(p, ["estacupPoints","estacup_points"])
  );
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
/* === Chemins étendus pour ÉQUIPE posée par l'admin === */
function pickTeamLocal(p) {
  const t = firstDefined(
    pick(p, ["team","teamName","equipe","stats.team","driver.team","pilot.team"]),
    pick(p, ["estacup.team","estacupTeam","classification.team","result.team"])
  );
  return (t ?? "").toString();
}

function pickUid(p) {
  return (p.uid || p.id || p.steamId || p.driverId || p.pilotId || p.accountId || p.name || "").toString();
}

/* === Résolveurs unifiés (participant -> points/équipe), avec fallback raceHistory + signup === */
async function resolvePoints(uid, courseId, participant) {
  if (participant && typeof participant.points === "number" && isFinite(participant.points)) {
    return participant.points;
  }
  const local = pickPointsLocal(participant);
  if (local !== null) return local;

  const rh = await getRaceHistoryEntry(uid, courseId);
  if (rh.points !== null) return rh.points;

  return 0;
}
async function resolveTeam(uid, courseId, participant) {
  const local = (pickTeamLocal(participant) || "").trim();
  if (local) return local;
  const rh = await getRaceHistoryEntry(uid, courseId);
  if ((rh.team || "").trim()) return rh.team.trim();
  const sign = signupCache.get(uid);
  if (sign && (sign.teamName || "").trim()) return sign.teamName.trim();
  return "(Sans équipe)";
}

/* -------- Gap leader intelligible (temps ou tours) -------- */
function computeGapLeaderText(p, leader) {
  const direct = pickGapLeaderMsDirect(p);
  if (direct != null) return direct === 0 ? "Leader" : "+" + msToClock(direct);

  const leaderLaps = Number(pick(leader, ["laps","lapCount","stats.laps"]));
  const myLaps     = Number(pick(p,      ["laps","lapCount","stats.laps"]));
  if (Number.isFinite(leaderLaps) && Number.isFinite(myLaps) && myLaps < leaderLaps) {
    const diff = leaderLaps - myLaps;
    return `+${diff} tour${diff > 1 ? "s" : ""}`;
  }

  const leadMs = pickTotalTimeMs(leader);
  const meMs   = pickTotalTimeMs(p);
  if (leadMs != null && meMs != null) {
    const raw = meMs - leadMs;
    return raw <= 0 ? "Leader" : "+" + msToClock(raw);
  }
  return "—";
}

/* ======================== Résultats ======================== */
async function loadResults(uid) {
  const ul = $("raceHistory");
  if (!ul) return;
  try {
    ul.innerHTML = "<li>Chargement…</li>";

    const snap = await getDocs(collection(db, "users", uid, "raceHistory"));
    if (snap.empty) { ul.innerHTML = "<li>Aucun résultat pour l’instant.</li>"; return; }

    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
    rows.sort((a, b) => {
      const da = toDate(a.date) ?? new Date(a.date || 0);
      const db = toDate(b.date) ?? new Date(b.date || 0);
      return db - da;
    });

    ul.innerHTML = "";
    for (const r of rows) {
      const d     = formatDateFR(r.date) || r.date || "";
      const title = [d, (r.name || r.race || r.track || "Course")].filter(Boolean).join(" – ");

      const li = document.createElement("li");
      li.className = "race-item";

      const btn = document.createElement("button");
      btn.className = "race-btn";
      btn.textContent = `${title}`;
      btn.setAttribute("data-raceid", r.id);

      const details = document.createElement("div");
      details.id = `cls-${r.id}`;
      details.className = "race-classification";
      details.style.display = "none";
      details.innerHTML = "<em>Chargement…</em>";

      btn.addEventListener("click", async () => {
        const shown = details.style.display !== "none";
        if (shown) { details.style.display = "none"; return; }
        await renderRaceClassification(r.id, details, r);
        details.style.display = "block";
      });

      li.appendChild(btn);
      li.appendChild(details);
      ul.appendChild(li);
    }
  } catch (e) {
    console.error(e);
    ul.innerHTML = `<li>Erreur de chargement des résultats.</li>`;
  }
}

/**
 * Table EXACTE : Nom | Prénom | Voiture | Best lap | Gap leader | Pena | Points
 */
async function renderRaceClassification(raceId, container, raceMeta) {
  try {
    const courseDoc = await getDoc(doc(db, "courses", raceId));
    if (!courseDoc.exists()) {
      container.innerHTML = "<em>Pas de JSON admin pour cette course.</em>";
      return;
    }

    await ensureSignupCache();

    const c = courseDoc.data() || {};
    const participants = Array.isArray(c.participants) ? c.participants.slice() : [];
    if (participants.length === 0) {
      container.innerHTML = "<em>Aucun participant dans le JSON admin.</em>";
      return;
    }

    // Tri par position
    participants.sort((a, b) => {
      const pa = Number(pick(a, ["position","stats.position"])) || 999999;
      const pb = Number(pick(b, ["position","stats.position"])) || 999999;
      return pa - pb;
    });
    const leader = participants.find(p => Number(pick(p,["position","stats.position"])) === 1) || participants[0];

    const title = escapeHtml(c.name || raceMeta?.name || "Course");
    const dateTxt = formatDateFR(c.date) || formatDateFR(raceMeta?.date) || "";
    const trackTxt = escapeHtml((c.track || c.circuit || raceMeta?.track || "").replace(/\s*\(.*?\)\s*/g,"")); // supprime éventuels (GT3 nuit/...)
    const headerMeta = [
      dateTxt && `📅 ${dateTxt}`,
      trackTxt && `🏁 ${trackTxt}`,
      c.split && `🅂 Split ${escapeHtml(String(c.split))}`,
      c.round && `🔢 Round ${escapeHtml(String(c.round))}`
    ].filter(Boolean).join(" • ");

    let html = `<strong>Classement — ${title}</strong>`;
    if (headerMeta) html += `<div class="muted-note" style="margin:6px 0 10px 0">${headerMeta}</div>`;

    html += `<div style="overflow:auto"><table class="race-table fixed-cols"><thead><tr>
      <th>Nom</th>
      <th>Prénom</th>
      <th>Voiture</th>
      <th>Best lap</th>
      <th>Gap leader</th>
      <th>Pena</th>
      <th>Points</th>
    </tr></thead><tbody>`;

    for (const p of participants) {
      const { first, last } = splitNameParts(p);
      const uid = pickUid(p);
      const car       = pickCar(p);
      const bestMs    = pickBestLapMs(p);
      const gapText   = computeGapLeaderText(p, leader);
      const penMs     = pickPenaltyMs(p);
      const points    = await resolvePoints(uid, raceId, p);

      html += `<tr>
        <td>${escapeHtml((last||"").toString().toUpperCase())}</td>
        <td>${escapeHtml(first)}</td>
        <td>${escapeHtml(car)}</td>
        <td>${bestMs != null ? msToClock(bestMs) : "—"}</td>
        <td>${escapeHtml(gapText)}</td>
        <td>${penMs  != null ? msToClock(penMs) : "—"}</td>
        <td>${Number.isFinite(points) ? points : 0}</td>
      </tr>`;
    }
    html += `</tbody></table></div>`;

    container.innerHTML = html;
  } catch (e) {
    console.error(e);
    container.innerHTML = "<em>Erreur lors du chargement du classement.</em>";
  }
}

/* ======================== Stats pilote ======================== */
async function loadPilotStats(uid) {
  const startsEl = $("statStarts");
  const bestEl   = $("statBest");
  const winsEl   = $("statWins");
  const top3El   = $("statTop3");
  const top5El   = $("statTop5");
  const top10El  = $("statTop10");
  const avgEl    = $("statAvg");

  try {
    const snap = await getDocs(collection(db, "users", uid, "raceHistory"));
    if (snap.empty) {
      if (startsEl) startsEl.textContent = "0";
      if (bestEl)   bestEl.textContent = "—";
      if (winsEl)   winsEl.textContent = "0";
      if (top3El)   top3El.textContent = "0";
      if (top5El)   top5El.textContent = "0";
      if (top10El)  top10El.textContent = "0";
      if (avgEl)    avgEl.textContent = "—";
      return;
    }

    const positions = [];
    snap.forEach(d => {
      const p = Number(d.data().position);
      if (!Number.isNaN(p) && p > 0) positions.push(p);
    });

    const starts = positions.length;
    const best   = positions.length ? Math.min(...positions) : null;
    const wins   = positions.filter(p => p === 1).length;
    const top3   = positions.filter(p => p <= 3).length;
    const top5   = positions.filter(p => p <= 5).length;
    const top10  = positions.filter(p => p <= 10).length;
    const avg    = positions.length ? (positions.reduce((a,b)=>a+b,0) / positions.length) : null;

    if (startsEl) startsEl.textContent = String(starts);
    if (bestEl)   bestEl.textContent   = best !== null ? `${best}ᵉ` : "—";
    if (winsEl)   winsEl.textContent   = String(wins);
    if (top3El)   top3El.textContent   = String(top3);
    if (top5El)   top5El.textContent   = String(top5);
    if (top10El)  top10El.textContent  = String(top10);
    if (avgEl)    avgEl.textContent    = avg !== null ? `${avg.toFixed(1)}ᵉ` : "—";
  } catch (e) {
    console.error(e);
  }
}

/* ======================== ELO ======================== */
function computeEloUpdates(rankingArr, ratingsMap, K = 32) {
  const N = rankingArr.length;
  if (N < 2) {
    const res = {};
    rankingArr.forEach(p => res[p.uid] = ratingsMap[p.uid] ?? 1000);
    return res;
  }
  const pos = {};
  rankingArr.forEach((p, i) => { pos[p.uid] = (p.position ?? (i + 1)); });

  const K_eff = K / (N - 1);
  const delta = {};
  rankingArr.forEach(p => delta[p.uid] = 0);

  for (let i = 0; i < N; i++) {
    const ui = rankingArr[i].uid;
    const Ri = ratingsMap[ui] ?? 1000;
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const uj = rankingArr[j].uid;
      const Rj = ratingsMap[uj] ?? 1000;

      let Sij = 0.5;
      if (pos[ui] < pos[uj]) Sij = 1;
      if (pos[ui] > pos[uj]) Sij = 0;

      const Eij = 1 / (1 + Math.pow(10, (Rj - Ri) / 400));
      delta[ui] += K_eff * (Sij - Eij);
    }
  }

  const out = {};
  rankingArr.forEach(p => {
    const base = ratingsMap[p.uid] ?? 1000;
    out[p.uid] = Math.round(base + delta[p.uid]);
  });
  return out;
}

async function loadMRating(uid) {
  const bestEl   = $("eloBest");
  const worstEl  = $("eloWorst");
  const rankLine = $("eloRankLine");

  let current = 1000;
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) {
      const d = snap.data();
      current = Number(d.eloRating ?? 1000);
      $("eloRating").textContent = current;
    }
  } catch {}

  const coursesSnap = await getDocs(collection(db, "courses"));
  const courses = coursesSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const da = toDate(a.date) ?? new Date(a.date || 0);
      const db = toDate(b.date) ?? new Date(b.date || 0);
      return da - db;
    });

  const activeSet = new Set();
  courses.forEach(c => (c.participants || []).forEach(p => p?.uid && activeSet.add(p.uid)));
  try {
    const usersSnap = await getDocs(collection(db, "users"));
    const active = [];
    usersSnap.forEach(u => {
      const d = u.data() || {};
      if (!activeSet.has(u.id)) return;
      const val = Number(d.eloRating);
      active.push({ id: u.id, elo: Number.isNaN(val) ? 1000 : val });
    });
    active.sort((a,b) => b.elo - a.elo);

    const idx = active.findIndex(x => x.id === uid);
    const rank = idx >= 0 ? idx + 1 : null;
    const total = active.length;
    rankLine.textContent = rank ? `${rank}ᵉ sur ${total} pilotes actifs` : `— sur ${total} pilotes actifs`;
  } catch (e) {
    console.error(e);
    rankLine.textContent = "—";
  }

  const elo = new Map();
  [...activeSet].forEach(u => elo.set(u, 1000));
  const myTrace = [];

  for (const c of courses) {
    const parts = (c.participants || [])
      .filter(p => p && p.uid)
      .map(p => ({ uid: p.uid, position: Number(p.position ?? (1/0)), name: p.name || "" }));
    if (parts.length < 2) continue;

    const ratingsMap = {};
    parts.forEach(p => { ratingsMap[p.uid] = elo.get(p.uid) ?? 1000; });
    const newRatings = computeEloUpdates(parts, ratingsMap, 32);
    parts.forEach(p => {
      const nr = newRatings[p.uid];
      elo.set(p.uid, Number.isFinite(nr) ? nr : (elo.get(p.uid) ?? 1000));
    });

    const me = parts.find(p => p.uid === uid);
    if (me) myTrace.push(elo.get(uid));
  }

  const best  = myTrace.length ? Math.max(...myTrace) : current;
  const worst = myTrace.length ? Math.min(...myTrace) : current;
  if (bestEl)  bestEl.textContent  = String(best);
  if (worstEl) worstEl.textContent = String(worst);
}

/* ======================== M-Safety ======================== */
async function loadMSafety(uid) {
  const box = $("esafetyIncidents");
  if (!box) return;
  box.innerHTML = "<p>Chargement…</p>";

  try {
    const coursesSnap = await getDocs(collection(db, "courses"));
    const courseMap = new Map();
    coursesSnap.forEach(c => {
      const d = c.data();
      const dateTxt = formatDateFR(d.date) || "";
      courseMap.set(c.id, `${d.name || "Course"}${dateTxt ? ` (${dateTxt})` : ""}`);
    });

    const gathered = [];
    try {
      const sub = await getDocs(collection(db, "users", uid, "incidents"));
      sub.forEach(d => gathered.push({ id: d.id, ...d.data() }));
    } catch {}
    try {
      const top = await getDocs(collection(db, "incidents"));
      top.forEach(d => {
        const x = d.data();
        const inPilotes = Array.isArray(x.pilotes) && x.pilotes.some(p => p?.uid === uid);
        if (inPilotes || x.uid === uid || x.pilotUid === uid || x.driverUid === uid || (Array.isArray(x.uids) && x.uids.includes(uid))) {
          gathered.push({ id: d.id, ...x });
        }
      });
    } catch {}

    if (gathered.length === 0) { box.innerHTML = "<p>Aucun incident enregistré pour l’instant.</p>"; return; }

    const norm = gathered.map(r => {
      const date = toDate(r.date || r.timestamp || r.createdAt || r.time);
      const rawCourse = r.course || r.courseText || r.race || r.raceName || r.raceId || r.courseId || "";
      const course =
        (r.courseId && courseMap.get(r.courseId)) ||
        (String(rawCourse) && courseMap.get(String(rawCourse))) ||
        String(rawCourse || "-");
      const description = r.description || r.note || r.reason || r.motif || "";
      let impact = null;
      if (Array.isArray(r.pilotes)) {
        const me = r.pilotes.find(p => p?.uid === uid);
        if (me && isNum(me.before) && isNum(me.after)) impact = me.after - me.before;
      }
      if (!isNum(impact)) {
        let alt = r.safetyDelta ?? r.licenseDelta ?? r.pointsDelta ?? r.delta;
        if (!isNum(alt) && isNum(r.penaltyPoints)) alt = -Math.abs(r.penaltyPoints);
        if (isNum(alt)) impact = alt;
      }
      return {
        date: date || null,
        course,
        description,
        decision: r.decision || r.status || r.state || "",
        impact
      };
    }).sort((a,b)=> (b.date?.getTime?.() || 0) - (a.date?.getTime?.() || 0));

    let html = `<h4>Vos incidents</h4>`;
    for (const it of norm) {
      const d = it.date ? it.date.toLocaleString("fr-FR") : "—";
      const impactTxt = isNum(it.impact) ? (it.impact > 0 ? `+${it.impact}` : `${it.impact}`) : "—";
      const impCls = isNum(it.impact) ? (it.impact < 0 ? "impact-bad" : "impact-good") : "";
      html += `
        <div class="course-box">
          <p><strong> Date et heure de la décision</strong><br>${d}</p>
          <p><strong> Course</strong><br>${escapeHtml(it.course || "—")}</p>
          <p><strong> Description de l'incident</strong><br>${escapeHtml(it.description || "—")}</p>
          <p><strong> Incidence M-Safety</strong><br><span class="${impCls}">${impactTxt}</span></p>
        </div>
      `;
    }
    box.innerHTML = html;
  } catch (e) {
    console.error(e);
    box.innerHTML = "<p>Erreur lors du chargement des incidents.</p>";
  }
}

/* ======================== ESTACUP : sous-menu & classements ======================== */
function setupEstacupSubnav() {
  const subnav = $("estacupSubnav");
  if (!subnav) return;
  const subs = document.querySelectorAll("#estacupSubnav .estc-sub-btn");
  subs.forEach(btn => { btn.onclick = () => showEstacupSub(btn.dataset.sub); });
}
function showEstacupSub(key) {
  const blocks = {
    inscription: $("estacup-sub-inscription"),
    engages:     $("estacup-sub-engages"),
    votecircuit: $("estacup-sub-votecircuit"),
    reclam:      $("estacup-sub-reclam"),
    rankpilots:  $("estacup-sub-rankpilots"),
    rankteams:   $("estacup-sub-rankteams"),
  };
  Object.values(blocks).forEach(b => b && b.classList.add("hidden"));
  if (blocks[key]) blocks[key].classList.remove("hidden");
  if (key === "votecircuit") renderVoteCircuit();
  if (key === "rankpilots")  loadEstacupPilotStandings();
  if (key === "rankteams")   loadEstacupTeamStandings();
}

/* ===== VOTE CIRCUIT (2 questions, drapeaux, validation unique) ===== */
async function renderVoteCircuit() {
  const host = $("voteCircuitHost");
  if (!host || !currentUid) return;

  host.innerHTML = `<div class="course-box"><p class="loading">Chargement du vote…</p></div>`;

  // Définitions : noms simples + codes pays (flag-icons)
  const questions = [
    {
      key: "round3",
      title: "Round 3",
      options: [
        { value: "shanghai", label: "Shanghaï", cc: "cn" },
        { value: "sepang",   label: "Sepang",   cc: "my" }
      ]
    },
    {
      key: "round5",
      title: "Round 5",
      options: [
        { value: "bahrain", label: "Bahrain", cc: "bh" },
        { value: "losail",  label: "Losail",  cc: "qa" }
      ]
    }
  ];

  // Lire vote existant
  const voteRef = doc(db, "estacup_votes", currentUid);
  const snap = await getDoc(voteRef);
  const existing = snap.exists() ? snap.data() : null;
  const locked = existing?.locked === true;

  const selected = {
    round3: existing?.round3 ?? null,
    round5: existing?.round5 ?? null
  };

  // Rendu
  const makeCard = (q) => {
    const selectedValue = selected[q.key];
    const opts = q.options.map(o => {
      const id = `vote_${q.key}_${o.value}`;
      const checked = selectedValue === o.value ? "checked" : "";
      const disabled = locked ? "disabled" : "";
      return `
        <label class="vote-option" for="${id}">
          <input type="radio" name="${q.key}" id="${id}" value="${o.value}" ${checked} ${disabled} />
          <div class="vote-pill">
            <span class="fi fi-${o.cc} vote-flag" aria-hidden="true"></span>
            <strong>${escapeHtml(o.label)}</strong>
          </div>
        </label>
      `;
    }).join("");

    return `
      <div class="vote-card">
        <div class="vote-title">${escapeHtml(q.title)}</div>
        <div class="vote-options">${opts}</div>
      </div>
    `;
  };

  const cards = questions.map(makeCard).join("");

  const actions = locked
    ? `<p class="muted-note">✅ Votre vote a été validé. Il n’est plus modifiable.</p>`
    : `<button id="btnValidateVote" class="btn-validate">✅ Valider mon vote</button>`;

  host.innerHTML = `
    <div class="vote-grid">
      ${cards}
    </div>
    <div class="vote-actions">
      ${actions}
      <p class="muted-note" style="margin-top:8px;">Un seul envoi : vous répondez aux 2 questions et vous validez une fois. Après validation, vous ne pourrez plus modifier.</p>
    </div>
  `;

  if (!locked) {
    // écouteurs radio
    questions.forEach(q => {
      const radios = host.querySelectorAll(`input[name="${q.key}"]`);
      radios.forEach(r => r.addEventListener("change", () => {
        selected[q.key] = r.value;
      }));
    });

    // validation
    $("btnValidateVote")?.addEventListener("click", async () => {
      if (!selected.round3 || !selected.round5) {
        alert("Merci de répondre aux deux questions avant de valider.");
        return;
      }
      try {
        await setDoc(voteRef, {
          uid: currentUid,
          round3: selected.round3,
          round5: selected.round5,
          locked: true,
          updatedAt: new Date()
        });
        alert("Votre vote est enregistré et verrouillé. Merci !");
        renderVoteCircuit(); // rerender en mode locked
      } catch (e) {
        console.error(e);
        alert("Erreur lors de l’enregistrement du vote.");
      }
    });
  }
}

/* ======================== Formulaires ESTACUP (inscription) ======================== */
function setupMekaQuestionnaire(userData) {
  const select = $("mekaPaid");
  const nextStep = $("mekaNextStep");
  const formContainer = $("estacupFormContainer");
  if (!select) return;

  nextStep.innerHTML = "";
  formContainer.classList.add("hidden");
  formContainer.innerHTML = "";

  select.onchange = () => {
    nextStep.innerHTML = "";
    formContainer.classList.add("hidden");
    formContainer.innerHTML = "";

    if (select.value === "yes") {
      formContainer.classList.remove("hidden");
      loadEstacupForm(userData);
    } else if (select.value === "no") {
      nextStep.innerHTML = `
        <p style="margin-top:10px;">
          Vous devez choisir une option pour participer à l’ESTACUP :<br><br>
          <a href="https://www.helloasso.com/associations/meka/adhesions/inscription-meka-2025-2026" target="_blank" style="color:#38bdf8;text-decoration:underline;display:block;margin-bottom:6px;">
            👉 Payer la cotisation MEKA (l’inscription ESTACUP sera gratuite)
          </a>
          <a href="https://www.helloasso.com/associations/meka/evenements/inscription-estacup-saison-9" target="_blank" style="color:#38bdf8;text-decoration:underline;display:block;">
            👉 Payer 5 € pour participer uniquement à l’ESTACUP
          </a>
        </p>
      `;
    }
  };
}

async function loadEstacupForm(userData, editing = false) {
  const container = $("estacupFormContainer");
  if (!container) return;
  container.innerHTML = "";

  let existing = null, existingId = null;
  const qs = await getDocs(query(collection(db, "estacup_signups"), where("uid", "==", auth.currentUser.uid)));
  if (!qs.empty) { existing = qs.docs[0].data(); existingId = qs.docs[0].id; }

  if (existing && !editing) {
    const status = existing.validated ? "✅ Validée" : "⏳ En attente";
    const box = document.createElement("div");
    box.className = "course-box";
    box.innerHTML = `
      <p><strong>Vous êtes déjà inscrit.</strong></p>
      <p>Statut : <span class="status ${existing.validated ? "ok" : "wait"}">${status}</span></p>
      <p>Voiture : <b>${escapeHtml(existing.carChoice || "-")}</b> • N° : <b>${existing.raceNumber ?? "-"}</b></p>
      <p>Steam ID : <b>${escapeHtml(existing.steamID64 || existing.steamId || "-")}</b></p>
      <div class="toolbar" style="margin-top:8px">
        <button id="btnEditSignup">✏️ Modifier mon inscription</button>
      </div>
    `;
    container.appendChild(box);
    $("btnEditSignup")?.addEventListener("click", () => loadEstacupForm(userData, true));
    return;
  }

  const DEFAULT_COLORS = { color1: "#000000", color2: "#01234A", color3: "#6BDAEC" };

  let age = existing?.age || "";
  const baseDob = firstDefined(userData.dob, userData.birthDate, userData.birthday, userData.dateNaissance, userData.naissance);
  const birth = toDate(baseDob);
  if (!age && birth) {
    const now = new Date();
    age = now.getFullYear() - birth.getFullYear();
    const m = now.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  }

  const cars = [
    "Acura NSX GT3 EVO 2","Audi R8 LMS GT3 EVO II","BMW M4 GT3","Ferrari 296 GT3","Ford Mustang GT3",
    "Lamborghini Huracan GT3 EVO2","Lexus RC F GT3","McLaren 720S GT3 EVO","Mercedes-AMG GT3 EVO","Porsche 911 GT3 R"
  ];
  const initColors = (existing?.liveryChoice === "Livrée semi-perso" && existing?.liveryColors) ? existing.liveryColors : DEFAULT_COLORS;

  const form = document.createElement("form");
  form.innerHTML = `
    <input type="text" id="first" value="${escapeHtml(existing?.firstName || userData.firstName || "")}" placeholder="Prénom" required>
    <input type="text" id="last" value="${escapeHtml(existing?.lastName || userData.lastName || "")}" placeholder="Nom" required>
    <input type="number" id="age" value="${age ?? ""}" placeholder="Âge" required>
    <input type="email" id="email" value="${escapeHtml(existing?.email || userData.email || '')}" placeholder="Email" required>

    <input type="text" id="team" value="${escapeHtml(existing?.teamName || '')}" placeholder="Équipe (ou espace)">
    <input type="number" id="raceNumber" min="1" max="999" value="${existing?.raceNumber ?? ''}" placeholder="Numéro de course (1-999)" required>
    <div id="takenNumbers" class="taken-numbers"></div>

    <select id="car" required>
      <option value="">-- Sélectionne ta voiture --</option>
      ${cars.map(c => `<option value="${c}" ${existing?.carChoice === c ? "selected" : ""}>${c}</option>`).join("")}
    </select>

    <div class="car-preview"><img id="carPreview" alt="Prévisualisation" style="max-width:100%;display:${existing?.carChoice ? 'block':'none'}"></div>

    <select id="livery">
      <option value="">-- Type de livrée --</option>
      <option value="Livrée perso" ${existing?.liveryChoice==="Livrée perso"?"selected":""}>Livrée perso (voir modalités dans le règlement)</option>
      <option value="Livrée semi-perso" ${existing?.liveryChoice==="Livrée semi-perso"?"selected":""}>Livrée semi-perso</option>
      <option value="Livrée MEKA" ${existing?.liveryChoice==="Livrée MEKA"?"selected":""}>Livrée MEKA</option>
    </select>

    <!-- Steam ID demandé ici -->
    <input type="text" id="steam" value="${escapeHtml(existing?.steamID64 || existing?.steamId || userData.steamID64 || userData.steamId || '')}" placeholder="Steam ID64 (765…) ou URL de profil" required>

    <div id="colors" style="margin-top:8px;${existing?.liveryChoice==="Livrée semi-perso"?"":"display:none"}">
      <label>Couleur 1</label><input type="color" id="c1" value="${initColors.color1}">
      <label>Couleur 2</label><input type="color" id="c2" value="${initColors.color2}">
      <label>Couleur 3</label><input type="color" id="c3" value="${initColors.color3}">
    </div>

    <button type="submit">💾 Enregistrer mon inscription</button>
  `;
  container.appendChild(form);

  const carSelect = form.querySelector("#car");
  const carPreview = form.querySelector("#carPreview");
  const mapCarImg = {
    "Acura NSX GT3 EVO 2":"cars/acura.png","Audi R8 LMS GT3 EVO II":"cars/audi.png","BMW M4 GT3":"cars/bmw.png",
    "Ferrari 296 GT3":"cars/ferrari.png","Ford Mustang GT3":"cars/ford.png","Lamborghini Huracan GT3 EVO2":"cars/lamborghini.png",
    "Lexus RC F GT3":"cars/lexus.png","McLaren 720S GT3 EVO":"cars/mclaren.png","Mercedes-AMG GT3 EVO":"cars/mercedes.png",
    "Porsche 911 GT3 R":"cars/porsche.png"
  };
  const setCarPreview = () => {
    const src = mapCarImg[carSelect.value] || "";
    if (src) { carPreview.src = src; carPreview.style.display = "block"; } else { carPreview.style.display = "none"; }
  };
  setCarPreview();
  carSelect.addEventListener("change", setCarPreview);

  const liverySelect = form.querySelector("#livery");
  const colors = form.querySelector("#colors");
  liverySelect.addEventListener("change", () => {
    const showColors = liverySelect.value === "Livrée semi-perso";
    colors.style.display = showColors ? "block" : "none";
  });

  const takenNumbers = form.querySelector("#takenNumbers");
  const nSnap = await getDocs(collection(db, "estacup_signups"));
  const taken = new Set();
  nSnap.forEach(d => { const n = d.data().raceNumber; if (n) taken.add(n); });
  takenNumbers.innerHTML = `Numéros déjà pris : ${[...taken].sort((a,b)=>a-b).join(", ") || "—"}`;

  form.addEventListener("submit", async e => {
    e.preventDefault();

    const raceNumber = parseInt(form.querySelector("#raceNumber").value, 10);
    if (taken.has(raceNumber) && raceNumber !== existing?.raceNumber) {
      alert("⚠️ Ce numéro est déjà pris, merci d’en choisir un autre.");
      return;
    }

    // Steam ID : accepte URL ou ID64 (765…)
    const steamRaw = form.querySelector("#steam").value.trim();
    const steam64  = extractSteam64(steamRaw);
    if (!steam64) {
      alert("Merci de renseigner votre Steam ID64 (17 chiffres commençant par 765) ou une URL de profil Steam valide contenant l’ID64.");
      return;
    }

    const payload = {
      uid: auth.currentUser.uid,
      firstName: form.querySelector("#first").value.trim(),
      lastName: form.querySelector("#last").value.trim(),
      age: parseInt(form.querySelector("#age").value, 10),
      email: form.querySelector("#email").value.trim(),
      teamName: form.querySelector("#team").value.trim() || " ",
      carChoice: form.querySelector("#car").value,
      liveryChoice: liverySelect.value,
      raceNumber,
      validated: false,
      steamId: steam64,
      steamID64: steam64,
      steamInput: steamRaw
    };

    if (payload.liveryChoice === "Livrée semi-perso") {
      const DEFAULT_COLORS = { color1: "#000000", color2: "#01234A", color3: "#6BDAEC" };
      payload.liveryColors = {
        color1: form.querySelector("#c1").value || DEFAULT_COLORS.color1,
        color2: form.querySelector("#c2").value || DEFAULT_COLORS.color2,
        color3: form.querySelector("#c3").value || DEFAULT_COLORS.color3
      };
    } else {
      payload.liveryColors = null;
    }

    try {
      if (existing) {
        const ref = doc(db, "estacup_signups", existingId);
        await updateDoc(ref, { ...payload, validated: false, uid: auth.currentUser.uid });
      } else {
        await addDoc(collection(db, "estacup_signups"), { ...payload, validated: false, uid: auth.currentUser.uid });
      }
      // maj cache
      signupCache.set(auth.currentUser.uid, { teamName: payload.teamName, raceNumber: payload.raceNumber, carChoice: payload.carChoice });

      alert("Inscription ESTACUP enregistrée !");
      loadEstacupEngages();
      loadEstacupForm(userData, false);
      // affiche aussi dans Infos
      const steamLine = $("steamIdLine");
      if (steamLine && steam64) steamLine.textContent = steam64;
    } catch (err) {
      console.error(err);
      alert("Erreur lors de l’enregistrement. Réessayez.");
    }
  });
}

async function loadEstacupEngages() {
  const container = $("estacupEngages");
  if (!container) return;
  container.innerHTML = "<p>Chargement...</p>";

  const snap = await getDocs(collection(db, "estacup_signups"));
  const valid = snap.docs.filter(d => d.data().validated);

  if (valid.length === 0) { container.innerHTML = "<p>Aucun inscrit validé pour l'instant.</p>"; return; }

  container.innerHTML = "";
  valid.forEach(docu => {
    const d = docu.data();
    const mapCarImg = {
      "Acura NSX GT3 EVO 2":"cars/acura.png","Audi R8 LMS GT3 EVO II":"cars/audi.png","BMW M4 GT3":"cars/bmw.png",
      "Ferrari 296 GT3":"cars/ferrari.png","Ford Mustang GT3":"cars/ford.png","Lamborghini Huracan GT3 EVO2":"cars/lamborghini.png",
      "Lexus RC F GT3":"cars/lexus.png","McLaren 720S GT3 EVO":"cars/mclaren.png","Mercedes-AMG GT3 EVO":"cars/mercedes.png",
      "Porsche 911 GT3 R":"cars/porsche.png"
    };
    const src = mapCarImg[d.carChoice] || "";
    const box = document.createElement("div");
    box.className = "course-box engage-card";
    box.innerHTML = `
      <div class="engage-row">
        <div class="engage-text">
          <strong>${escapeHtml(`${d.firstName} ${d.lastName}`)}</strong><br>
          Numéro : ${d.raceNumber}<br>
          Équipe : ${escapeHtml(d.teamName || "")} | Voiture : ${escapeHtml(d.carChoice || "")}<br>
          Steam ID : ${escapeHtml(d.steamID64 || d.steamId || "-")}
        </div>
        ${src ? `<img src="${src}" alt="${escapeHtml(d.carChoice || "")}" class="car-thumb">` : ""}
      </div>
    `;
    container.appendChild(box);
  });
}

/* ======================== Réclamations ======================== */
$("submitReclam")?.addEventListener("click", async () => {
  const raceDateStr = $("reclamDate")?.value?.trim();
  const splitVal    = $("reclamSplit")?.value?.trim();
  const desc        = $("reclamDesc")?.value?.trim();
  const video       = $("reclamVideo")?.value?.trim();

  if (!raceDateStr || !splitVal || !desc || !video) {
    alert("Merci de remplir les 4 champs (date, split, description et lien YouTube).");
    return;
  }
  if (!/(youtu\.be|youtube\.com)/i.test(video)) {
    alert("Merci de renseigner un lien YouTube valide (youtube.com ou youtu.be).");
    return;
  }

  const raceDate = new Date(raceDateStr);
  if (!raceDate || isNaN(raceDate.getTime())) {
    alert("Date de course invalide.");
    return;
  }

  try {
    await addDoc(collection(db, "reclamations"), {
      raceDate,
      split: Number(splitVal),
      description: desc,
      youtubeUrl: video,
      uid: currentUid,
      date: new Date(),      // date d'envoi de la réclamation
      status: "pending"
    });

    $("reclamDate").value = "";
    $("reclamSplit").value = "";
    $("reclamDesc").value = "";
    $("reclamVideo").value = "";

    await loadReclamHistory();
    alert("Réclamation envoyée !");
  } catch (e) {
    console.error(e);
    alert("Erreur lors de l’envoi de la réclamation.");
  }
});

async function loadReclamHistory() {
  const box = $("reclamHistory");
  if (!box) return;
  try {
    const snap = await getDocs(collection(db, "reclamations"));
    const mine = [];
    snap.forEach(d => {
      const x = { id: d.id, ...d.data() };
      if (x.uid === currentUid) mine.push(x);
    });
    if (mine.length === 0) {
      box.innerHTML = "<p class='muted-note'>Aucune réclamation envoyée.</p>";
      return;
    }
    mine.sort((a,b)=> (toDate(b.date)??0) - (toDate(a.date)??0));

    let html = "";
    for (const r of mine) {
      const createdAt = toDate(r.date) || new Date();
      const raceDate  = toDate(r.raceDate);
      const raceDateStr = raceDate ? raceDate.toLocaleDateString("fr-FR") : "-";
      const splitLabel = r.split != null ? `Split ${r.split}` : (r.splitText || "-");
      const youtube = r.youtubeUrl || r.videoUrl || r.link || r.video || r.youtube || "";
      const hasNewFields = !!(raceDate || r.split != null || youtube);

      if (hasNewFields) {
        const safeDesc = escapeHtml(r.description || "");
        const safeStatus = escapeHtml(r.status || "pending");
        const safeRaceDate = escapeHtml(raceDateStr);
        const safeSplit = escapeHtml(splitLabel || "-");
        const safeUrl = escapeHtml(youtube);

        html += `<div class="course-box">
          <p><strong>${createdAt.toLocaleString("fr-FR")}</strong> — <em>${safeStatus}</em></p>
          <p><strong>Date de la course :</strong> ${safeRaceDate}</p>
          <p><strong>Split :</strong> ${safeSplit}</p>
          <p><strong>Description :</strong> ${safeDesc}</p>
          <p><strong>Vidéo :</strong> ${safeUrl ? `<a href="${safeUrl}" target="_blank" rel="noopener">Ouvrir la vidéo</a>` : "-"}</p>
        </div>`;
      } else {
        // fallback legacy (ancienne structure)
        html += `<div class="course-box">
          <p><strong>${(toDate(r.date)||new Date()).toLocaleString("fr-FR")}</strong> — <em>${escapeHtml(r.status || "pending")}</em></p>
          <p><strong>Course :</strong> ${escapeHtml(r.courseText || "-")}</p>
          <p><strong>Pilote(s) :</strong> ${escapeHtml(r.pilotsText || "-")}</p>
          <p><strong>Moment :</strong> ${escapeHtml(r.momentText || "-")}</p>
          <p>${escapeHtml(r.description || "")}</p>
        </div>`;
      }
    }
    box.innerHTML = html;
  } catch (e) {
    console.error(e);
    box.innerHTML = "<p>Erreur lors du chargement des réclamations.</p>";
  }
}

/* ======================== Classements ESTACUP ======================== */
function isEstacupCourse(c) {
  return c && c.estacup === true;
}
function normTeamName(t) {
  const s = (t||"").toString().trim();
  return s === "" ? "(Sans équipe)" : s;
}
async function fetchAllEstacupCoursesSorted() {
  const snap = await getDocs(collection(db, "courses"));
  const arr = [];
  snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
  const only = arr.filter(isEstacupCourse);
  only.sort((a, b) => {
    const da = toDate(a.date) ?? new Date(a.date || 0);
    const db = toDate(b.date) ?? new Date(b.date || 0);
    return da - db;
  });
  return only;
}

/* ---- Classement Pilotes ---- */
async function loadEstacupPilotStandings() {
  const host = $("estacupPilotStandings");
  if (!host) return;
  host.innerHTML = loaderHtml("Calcul en cours…"); // spinner

  try {
    await ensureSignupCache();
    const courses = await fetchAllEstacupCoursesSorted();
    const perPilot = new Map(); // uid -> {uid, first,last,name, team, points, starts, wins, podiums}

    for (const c of courses) {
      const parts = Array.isArray(c.participants) ? c.participants : [];
      const isSplit1 = Number(c.split) === 1 || c.split === undefined || c.split === null;

      for (const p of parts) {
        const uid  = pickUid(p);
        if (!uid) continue;
        const { first, last } = splitNameParts(p);
        const name = `${first} ${last}`.trim() || (p.name || "Pilote");
        const team = await resolveTeam(uid, c.id, p);
        const pts  = await resolvePoints(uid, c.id, p);

        if (!perPilot.has(uid)) perPilot.set(uid, { uid, first, last, name, team, points:0, starts:0, wins:0, podiums:0 });
        const row = perPilot.get(uid);

        row.points += pts;
        row.starts += 1;

        const pos = Number(p.position ?? p.stats?.position);
        if (isSplit1 && Number.isFinite(pos)) {
          if (pos === 1) row.wins += 1;
          if (pos >= 1 && pos <= 3) row.podiums += 1;
        }

        if (team && team !== "(Sans équipe)") row.team = team;
      }
    }

    const rows = [...perPilot.values()].sort((a,b)=>{
      if (b.points  !== a.points)  return b.points - a.points;
      if (b.wins    !== a.wins)    return b.wins   - a.wins;
      if (b.podiums !== a.podiums) return b.podiums - a.podiums;
      return (a.name||"").localeCompare(b.name||"");
    });

    if (rows.length === 0) {
      host.innerHTML = "<p class='muted-note'>Aucune manche ESTACUP trouvée.</p>";
      return;
    }

    let html = `<table class="table-standings"><thead><tr>
      <th>#</th><th>Pilote</th><th>Équipe</th><th>Points</th><th>Victoires</th><th>Podiums</th><th>Départs</th>
    </tr></thead><tbody>`;

    rows.forEach((r, i) => {
      const display = (r.last ? r.last.toUpperCase() : "") + (r.first ? ` ${r.first}` : (r.name ? ` ${r.name}`:""));
      html += `<tr>
        <td><span class="rank-badge">${i+1}</span></td>
        <td>${escapeHtml(display.trim() || r.uid)}</td>
        <td>${escapeHtml(r.team || "(Sans équipe)")}</td>
        <td><strong>${r.points}</strong></td>
        <td>${r.wins}</td>
        <td>${r.podiums}</td>
        <td>${r.starts}</td>
      </tr>`;
    });

    html += `</tbody></table>`;
    host.innerHTML = html;

  } catch (e) {
    console.error(e);
    host.innerHTML = "<p>Erreur lors du calcul du classement pilotes.</p>";
  }
}

/* ---- Classement Équipes ---- */
async function loadEstacupTeamStandings() {
  const host = $("estacupTeamStandings");
  if (!host) return;
  host.innerHTML = loaderHtml("Calcul en cours…"); // spinner

  try {
    await ensureSignupCache();
    const courses = await fetchAllEstacupCoursesSorted();
    const perTeam = new Map(); // team -> {team, points, wins, podiums}

    for (const c of courses) {
      const parts = Array.isArray(c.participants) ? c.participants : [];
      const byTeam = new Map();

      const isSplit1 = Number(c.split) === 1 || c.split === undefined || c.split === null;

      for (const p of parts) {
        const uid  = pickUid(p);
        if (!uid) continue;

        // Exclure les sans équipe dès la collecte
        const teamNameRaw = await resolveTeam(uid, c.id, p);
        const team = normTeamName(teamNameRaw);
        if (team === "(Sans équipe)") continue;

        const pts  = await resolvePoints(uid, c.id, p);
        const pos  = Number(p.position ?? p.stats?.position) || 9999;

        if (!byTeam.has(team)) byTeam.set(team, []);
        byTeam.get(team).push({ pts: Number.isFinite(pts) ? pts : 0, pos });
      }

      // agrégation course -> 2 meilleurs pilotes par équipe
      byTeam.forEach((arr, team) => {
        arr.sort((a,b)=> (b.pts !== a.pts) ? (b.pts - a.pts) : (a.pos - b.pos));
        const score = (arr[0]?.pts ?? 0) + (arr[1]?.pts ?? 0);

        if (!perTeam.has(team)) perTeam.set(team, { team, points:0, wins:0, podiums:0 });
        const agg = perTeam.get(team);
        agg.points += score;

        if (isSplit1) {
          arr.forEach(r => {
            if (Number.isFinite(r.pos)) {
              if (r.pos === 1) agg.wins += 1;
              if (r.pos >= 1 && r.pos <= 3) agg.podiums += 1;
            }
          });
        }
      });
    }

    const rows = [...perTeam.values()].sort((a,b)=>{
      if (b.points !== a.points) return b.points - a.points;
      if (b.wins   !== a.wins)   return b.wins   - a.wins;
      if (b.podiums!== a.podiums)return b.podiums- a.podiums;
      return (a.team||"").localeCompare(b.team||"");
    });

    if (rows.length === 0) {
      host.innerHTML = "<p class='muted-note'>Aucune équipe (hors “Sans équipe”) trouvée.</p>";
      return;
    }

    let html = `<table class="table-standings"><thead><tr>
      <th>#</th><th>Équipe</th><th>Points</th><th>Victoires</th><th>Podiums</th>
    </tr></thead><tbody>`;

    rows.forEach((r, i) => {
      html += `<tr>
        <td><span class="rank-badge">${i+1}</span></td>
        <td>${escapeHtml(r.team)}</td>
        <td><strong>${r.points}</strong></td>
        <td>${r.wins}</td>
        <td>${r.podiums}</td>
      </tr>`;
    });

    html += `</tbody></table>`;
    host.innerHTML = html;

  } catch (e) {
    console.error(e);
    host.innerHTML = "<p>Erreur lors du calcul du classement équipes.</p>";
  }
}

/* ======================== FIN ======================== */
