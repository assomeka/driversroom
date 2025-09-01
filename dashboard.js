// dashboard.js — Driver's Room : navigation + Résultats + Stats + ESTACUP
// + M-Rating (valeur + classement + best/worst via replay des courses)
// + M-Safety (cartes jolies avec titres)

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
  addDoc
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
function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
}

/* ======================== État ======================== */
let currentUid   = null;
let lastUserData = null;
/** courseId -> array<{uid,name,position}> */
const raceIndex = new Map();

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

  setupNavigation(data.admin === true);

  await loadResults(currentUid);
  await loadPilotStats(currentUid);
});

/* ======================== Résultats + classements ======================== */
async function loadResults(uid) {
  const ul = $("raceHistory");
  if (!ul) return;
  try {
    ul.innerHTML = "<li>Chargement…</li>";

    const snap = await getDocs(collection(db, "users", uid, "raceHistory"));
    if (snap.empty) { ul.innerHTML = "<li>Aucun résultat pour l’instant.</li>"; return; }

    const rows = [];
    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));

    // tri du plus récent au plus ancien
    rows.sort((a, b) => {
      const da = toDate(a.date) ?? new Date(a.date || 0);
      const db = toDate(b.date) ?? new Date(b.date || 0);
      return db - da;
    });

    const targetIds = new Set(rows.map(r => r.id));
    const countMap  = {};
    raceIndex.clear();

    // Constituer les classements en parcourant tous les utilisateurs
    const usersSnap = await getDocs(collection(db, "users"));
    for (const u of usersSnap.docs) {
      const udata = u.data();
      const name  = `${udata.firstName ?? ""} ${udata.lastName ?? ""}`.trim() || "(Sans nom)";
      const rhSnap = await getDocs(collection(db, "users", u.id, "raceHistory"));
      rhSnap.forEach(rh => {
        const r = { id: rh.id, ...rh.data() };
        if (!targetIds.has(r.id)) return;
        countMap[r.id] = (countMap[r.id] || 0) + 1;

        const list = raceIndex.get(r.id) || [];
        const pos  = Number(r.position) || 9999;

        list.push({ uid: u.id, name, position: pos });
        raceIndex.set(r.id, list);
      });
    }

    ul.innerHTML = "";
    for (const r of rows) {
      const d     = formatDateFR(r.date) || r.date || "";
      const total = countMap[r.id] || 1;
      const pos   = (r.position ?? "?");

      const li = document.createElement("li");
      li.className = "race-item";

      const btn = document.createElement("button");
      btn.className = "race-btn";
      btn.textContent = `${d} – ${r.name || "Course"} : ${pos}/${total}`;
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

async function renderRaceClassification(raceId, container, raceMeta) {
  try {
    const arr = (raceIndex.get(raceId) || []).slice().sort((a, b) => a.position - b.position);
    if (arr.length === 0) {
      container.innerHTML = "<em>Pas d’informations de classement disponibles.</em>";
      return;
    }

    const title = escapeHtml(raceMeta?.name || "Course");
    let html = `<strong>Classement — ${title}</strong>`;
    html += `<table class="race-table"><thead><tr><th>#</th><th>Pilote</th></tr></thead><tbody>`;
    for (const item of arr) {
      html += `<tr><td>${item.position}</td><td>${escapeHtml(item.name)}</td></tr>`;
    }
    html += `</tbody></table>`;
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

/* ======================== ELO helper (même que côté admin) ======================== */
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

/* ======================== M-Rating (classement + best/worst robustes) ======================== */
async function loadMRating(uid) {
  const bestEl   = $("eloBest");
  const worstEl  = $("eloWorst");
  const rankLine = $("eloRankLine");

  // 1) Valeur actuelle
  let current = 1000;
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) {
      const d = snap.data();
      current = Number(d.eloRating ?? 1000);
      $("eloRating").textContent = current;
    }
  } catch {}

  /* ---- A. Déterminer les pilotes ACTIFS (>= 1 course) à partir des 'courses' ---- */
  const coursesSnap = await getDocs(collection(db, "courses"));
  const courses = coursesSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const da = a.date?.seconds ? new Date(a.date.seconds * 1000) : new Date(a.date || 0);
      const db = b.date?.seconds ? new Date(b.date.seconds * 1000) : new Date(b.date || 0);
      return da - db; // ascendant
    });

  const activeSet = new Set();
  courses.forEach(c => (c.participants || []).forEach(p => p?.uid && activeSet.add(p.uid)));
  const activeUids = Array.from(activeSet);

  /* ---- B. Classement global parmi ces actifs (tri sur eloRating actuel) ---- */
  try {
    const usersSnap = await getDocs(collection(db, "users"));
    const active = [];
    usersSnap.forEach(u => {
      const d = u.data() || {};
      if (!activeSet.has(u.id)) return;      // seulement ceux qui ont au moins 1 course
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

  /* ---- C. Record personnel & plus faible valeur via REPLAY des courses ---- */
  // On rejoue toutes les courses dans l’ordre avec la même formule que l’admin.
  // On ne garde que la trajectoire du pilote courant.
  const elo = new Map();              // uid -> elo courant (init 1000)
  activeUids.forEach(u => elo.set(u, 1000));
  const myTrace = [];                 // valeurs du pilote après chacune de ses courses

  for (const c of courses) {
    const parts = (c.participants || [])
      .filter(p => p && p.uid)
      .map(p => ({ uid: p.uid, position: Number(p.position ?? 9999), name: p.name || "" }));
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

/* ======================== M-Safety (cartes) ======================== */
async function loadMSafety(uid) {
  const box = $("esafetyIncidents");
  if (!box) return;
  box.innerHTML = "<p>Chargement…</p>";

  try {
    // Charger les noms de courses
    const coursesSnap = await getDocs(collection(db, "courses"));
    const courseMap = new Map();
    coursesSnap.forEach(c => {
      const d = c.data();
      const dateTxt = formatDateFR(d.date) || "";
      courseMap.set(c.id, `${d.name || "Course"}${dateTxt ? ` (${dateTxt})` : ""}`);
    });

    // Récup incidents (compat: sous-collection et collection globale)
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

    // Rendu avec titres
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

/* ======================== Sous-menu ESTACUP ======================== */
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
    reclam:      $("estacup-sub-reclam")
  };
  Object.values(blocks).forEach(b => b && b.classList.add("hidden"));
  if (blocks[key]) blocks[key].classList.remove("hidden");
}

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

  // Doc existant par uid (ID aléatoire)
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
      <div class="toolbar" style="margin-top:8px">
        <button id="btnEditSignup">✏️ Modifier mon inscription</button>
      </div>
    `;
    container.appendChild(box);
    $("btnEditSignup")?.addEventListener("click", () => loadEstacupForm(userData, true));
    return;
  }

  const DEFAULT_COLORS = { color1: "#000000", color2: "#01234A", color3: "#6BDAEC" };

  // âge auto depuis DOB (si disponible)
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

    <input type="text" id="steamId"
           inputmode="numeric"
           pattern="^765[0-9]{14}$"
           value="${escapeHtml(existing?.steamId || '')}"
           placeholder="SteamID64 (17 chiffres, commence par 765…)"
           required>
    <small style="color:#94a3b8;margin-top:-6px;display:block;">
      Exemple : 7656119XXXXXXXXXX — (SteamID64). Tu peux le retrouver sur steamid.io
    </small>

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

    <div id="colors" style="margin-top:8px;${existing?.liveryChoice==="Livrée semi-perso"?"":"display:none"}">
      <label>Couleur 1</label><input type="color" id="c1" value="${initColors.color1}">
      <label>Couleur 2</label><input type="color" id="c2" value="${initColors.color2}">
      <label>Couleur 3</label><input type="color" id="c3" value="${initColors.color3}">
    </div>

    <button type="submit">💾 Enregistrer mon inscription</button>
  `;
  container.appendChild(form);

  // preview voiture
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

  // livery → couleurs
  const liverySelect = form.querySelector("#livery");
  const colors = form.querySelector("#colors");
  liverySelect.addEventListener("change", () => {
    const showColors = liverySelect.value === "Livrée semi-perso";
    colors.style.display = showColors ? "block" : "none";
  });

  // numéros pris
  const takenNumbers = form.querySelector("#takenNumbers");
  const nSnap = await getDocs(collection(db, "estacup_signups"));
  const taken = new Set();
  nSnap.forEach(d => { const n = d.data().raceNumber; if (n) taken.add(n); });
  takenNumbers.innerHTML = `Numéros déjà pris : ${[...taken].sort((a,b)=>a-b).join(", ") || "—"}`;

  // submit
  form.addEventListener("submit", async e => {
    e.preventDefault();

    const raceNumber = parseInt(form.querySelector("#raceNumber").value, 10);
    if (taken.has(raceNumber) && raceNumber !== existing?.raceNumber) {
      alert("⚠️ Ce numéro est déjà pris, merci d’en choisir un autre.");
      return;
    }

    const steamId = form.querySelector("#steamId").value.trim();
    if (!/^765\d{14}$/.test(steamId)) {
      alert("⚠️ SteamID64 invalide. Il doit faire 17 chiffres et commencer par 765.");
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
      steamId, // 👈 nouveau champ
      validated: false
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

    if (existing) {
      const ref = doc(db, "estacup_signups", existingId);
      await updateDoc(ref, { ...payload, validated: false, uid: auth.currentUser.uid });
    } else {
      await addDoc(collection(db, "estacup_signups"), { ...payload, validated: false, uid: auth.currentUser.uid });
    }

    alert("Inscription ESTACUP enregistrée !");
    loadEstacupEngages();
    loadEstacupForm(userData, false);
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
          Équipe : ${escapeHtml(d.teamName || "")} | Voiture : ${escapeHtml(d.carChoice || "")}
        </div>
        ${src ? `<img src="${src}" alt="${escapeHtml(d.carChoice || "")}" class="car-thumb">` : ""}
      </div>
    `;
    container.appendChild(box);
  });
}


$("submitReclam")?.addEventListener("click", async () => {
  const courseText = $("reclamCourse")?.value?.trim();
  const pilotsText = $("reclamPilotsText")?.value?.trim();
  const momentText = $("reclamMoment")?.value?.trim();
  const desc       = $("reclamDesc")?.value?.trim();
  if (!courseText || !desc) { alert("Merci de renseigner au moins la course et la description."); return; }
  try {
    await addDoc(collection(db, "reclamations"), {
      courseText, pilotsText, momentText, description: desc,
      uid: currentUid, date: new Date(), status: "pending"
    });
    $("reclamCourse").value = "";
    $("reclamPilotsText").value = "";
    $("reclamMoment").value = "";
    $("reclamDesc").value = "";
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
    if (mine.length === 0) { box.innerHTML = "<p class='muted-note'>Aucune réclamation envoyée.</p>"; return; }
    mine.sort((a,b)=> (toDate(b.date)??0) - (toDate(a.date)??0));
    let html = "";
    for (const r of mine) {
      html += `<div class="course-box">
        <p><strong>${(toDate(r.date)||new Date()).toLocaleString("fr-FR")}</strong> — <em>${r.status || "pending"}</em></p>
        <p><strong>Course :</strong> ${escapeHtml(r.courseText || "-")}</p>
        <p><strong>Pilote(s) :</strong> ${escapeHtml(r.pilotsText || "-")}</p>
        <p><strong>Moment :</strong> ${escapeHtml(r.momentText || "-")}</p>
        <p>${escapeHtml(r.description || "")}</p>
      </div>`;
    }
    box.innerHTML = html;
  } catch (e) {
    console.error(e);
    box.innerHTML = "<p>Erreur lors du chargement des réclamations.</p>";
  }
}
