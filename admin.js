// ✅ admin.js — complet (avec ELO multi-joueurs + recalcul global + sélection/désélection pilotes)
// - Bouton “-” à côté des pilotes ajoutés dans la liste (undo rapide)
// - Anti-doublon : on ne peut pas ajouter deux fois le même pilote
// - Reste des fonctionnalités inchangées

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
  addDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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

let ranking = [];                // [{ uid, name }]
let selectedPilots = [];         // { uid, name, before, after }
let courseMap = new Map();       // courseId -> course doc

// 🔸 Nouveau : set des uid sélectionnés pour empêcher les doublons
const selectedUIDs = new Set();

// Référence rapide vers les <li> pilotes (pour afficher/masquer le bouton "-")
const pilotLiByUid = new Map();

onAuthStateChanged(auth, async (user) => {
  if (!user) return (window.location.href = "login.html");

  const snap = await getDoc(doc(db, "users", user.uid));
  if (!snap.exists() || snap.data().admin !== true) {
    document.body.innerHTML = "<p>Accès refusé</p>";
    return;
  }

  document.getElementById("adminOnly")?.classList.remove("hidden");
  const nameEl = document.getElementById("adminName");
  if (nameEl) nameEl.textContent = snap.data().firstName || "";

  ensureDriversRoomButton();
  ensureRedLogoutButton();
  setupPilotsSection();          // Gestion Pilotes

  setupNavigation();             // "Résultats" par défaut
  loadPilots();
  loadCourses();
  loadIncidentHistory();
  loadEstacupSignups();
  loadReclamations();
});

/* ---------------- Helpers UI ---------------- */
function ensureDriversRoomButton() {
  document.getElementById("goToDashboard")?.remove();
  const menu = document.querySelector(".admin-menu");
  if (!menu) return;
  if (document.getElementById("backToDriversRoom")) return;

  const btn = document.createElement("button");
  btn.id = "backToDriversRoom";
  btn.type = "button";
  btn.textContent = "Driver's Room";
  btn.addEventListener("click", () => (window.location.href = "dashboard.html"));
  menu.appendChild(btn);
}

function ensureRedLogoutButton() {
  const btn = document.getElementById("logout");
  if (!btn) return;
  btn.style.backgroundColor = "#e53935";
  btn.style.borderColor = "#e53935";
  btn.style.color = "#fff";
  btn.style.fontWeight = 600;
  btn.style.padding = "8px 12px";
  btn.style.borderRadius = "10px";
}

function setupNavigation() {
  const buttons = document.querySelectorAll(".admin-menu button");
  const sections = document.querySelectorAll(".admin-section");

  function showSection(key) {
    sections.forEach((s) => s.classList.add("hidden"));
    const el = document.getElementById(`section-${key}`);
    if (el) el.classList.remove("hidden");

    if (key === "incidents") {
      loadReclamations?.();
      loadIncidentHistory?.();
      loadCourses?.();
      loadPilots?.();
    }
    if (key === "estacup") loadEstacupSignups?.();
    if (key === "courses")  loadCourses?.();
    if (key === "pilots")   document.getElementById("refreshPilots")?.click();
  }

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => showSection(btn.dataset.section));
  });

  if (document.getElementById("section-results")) {
    showSection("results");
  } else if (buttons[0]) {
    buttons[0].click();
  }
}

/* ---------------- Classement (clic sur pilotes) ---------------- */
function renderRanking() {
  const ol = document.getElementById("rankingList");
  if (!ol) return;
  ol.innerHTML = "";
  ranking.forEach((p, idx) => {
    const li = document.createElement("li");
    li.textContent = `${idx + 1}. ${p.name}`;
    ol.appendChild(li);
  });

  // Mettre à jour l’état visuel des pilotes (bouton "-" visible si sélectionné)
  updatePilotListSelections();
}

// 🔹 Retire un pilote du classement (et met à jour l’UI)
function removeFromRanking(uid) {
  const idx = ranking.findIndex(r => r.uid === uid);
  if (idx !== -1) {
    ranking.splice(idx, 1);
    selectedUIDs.delete(uid);
    renderRanking();
  }
}

/* ---------------- NOUVEAU — Calcul ELO multi-joueurs ---------------- */
/**
 * Calcule les nouveaux ELO d’une course en comparant chaque pilote à tous les autres (duels implicites).
 * @param {Array<{uid:string, name?:string, position?:number}>} rankingArr  - classements (index 0 = 1er si position absente)
 * @param {Object<string, number>} ratingsMap                               - ELO actuels par uid
 * @param {number} K                                                        - facteur K global (32 recommandé)
 * @returns {Object<string, number>}                                        - nouveaux ELO par uid
 */
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

      let Sij = 0.5;                 // ex-aequo par défaut
      if (pos[ui] < pos[uj]) Sij = 1;
      if (pos[ui] > pos[uj]) Sij = 0;

      const Eij = 1 / (1 + Math.pow(10, (Rj - Ri) / 400));
      delta[ui] += K_eff * (Sij - Eij);
    }
  }

  const CLAMP = 9999; // mets 60 si tu veux limiter la variation max par course
  const out = {};
  rankingArr.forEach(p => {
    const base = ratingsMap[p.uid] ?? 1000;
    const d = Math.max(-CLAMP, Math.min(CLAMP, delta[p.uid]));
    out[p.uid] = Math.round(base + d);
  });
  return out;
}

/* ---------------- Résultats & ELO (avec nouvelle formule) ---------------- */
document.getElementById("submitResults")?.addEventListener("click", async () => {
  const raceName = document.getElementById("raceName")?.value.trim();
  const raceDateInput = document.getElementById("raceDate");
  const raceDate = raceDateInput?.valueAsDate || new Date();
  if (!raceName || ranking.length === 0) {
    alert("Nom de course et classement requis.");
    return;
  }

  const raceId = Date.now().toString();

  // 1) ELO actuels des participants
  const ratingsMap = {};
  for (const p of ranking) {
    const s = await getDoc(doc(db, "users", p.uid));
    ratingsMap[p.uid] = s.exists() ? (s.data().eloRating ?? 1000) : 1000;
  }

  // 2) Construire participants + positions
  const participants = ranking.map((p, i) => ({
    uid: p.uid,
    name: p.name,
    position: i + 1
  }));

  // 3) Calcul ELO
  const newRatings = computeEloUpdates(participants, ratingsMap, 32);

  // 4) Sauver l'historique pilote
  for (const part of participants) {
    const ref = doc(db, "users", part.uid, "raceHistory", raceId);
    await setDoc(ref, {
      name: raceName,
      date: raceDate,
      position: part.position
    });
  }

  // 5) Sauver la course globale (avec positions)
  await setDoc(doc(db, "courses", raceId), {
    id: raceId,
    name: raceName,
    date: raceDate,
    participants // [{uid,name,position}]
  });
  courseMap.set(raceId, { id: raceId, name: raceName, date: raceDate, participants });

  // 6) Appliquer les nouveaux ELO
  for (const part of participants) {
    await updateDoc(doc(db, "users", part.uid), { eloRating: newRatings[part.uid] });
  }

  alert("Résultats enregistrés !");
  ranking = [];
  selectedUIDs.clear();          // 🔸 Reset la sélection visuelle
  renderRanking();
  await loadCourses();
  await loadIncidentHistory();
});

/* ---------------- Pilotes (lecture / sélection pour incidents/classement) ---------------- */
async function loadPilots() {
  const pilotList = document.getElementById("pilotList");
  const select = document.getElementById("incidentPilotSelect");
  const snap = await getDocs(collection(db, "users"));

  if (pilotList) pilotList.innerHTML = "";
  if (select) {
    select.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "-- Sélectionner un pilote --";
    select.appendChild(opt0);
  }

  pilotLiByUid.clear();

  for (const docu of snap.docs) {
    const d = docu.data();
    const uid = docu.id;
    const name = `${d.firstName || ""} ${d.lastName || ""}`.trim() || "(Sans nom)";

    // --- Liste Résultats (gauche)
    if (pilotList) {
      const li = document.createElement("li");
      li.dataset.uid = uid;

      const nameSpan = document.createElement("span");
      nameSpan.textContent = name;

      const minusBtn = document.createElement("button");
      minusBtn.textContent = "–";
      minusBtn.title = "Retirer du classement";
      minusBtn.style.marginLeft = "8px";
      minusBtn.style.display = "none"; // visible uniquement si sélectionné
      minusBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFromRanking(uid);
      });

      li.appendChild(nameSpan);
      li.appendChild(minusBtn);

      // Clic pour AJOUTER (si non sélectionné)
      li.addEventListener("click", () => {
        if (selectedUIDs.has(uid)) return; // 🔒 empêche le double ajout
        ranking.push({ uid, name });
        selectedUIDs.add(uid);
        renderRanking(); // mettra à jour l’affichage du "-"
      });

      pilotList.appendChild(li);
      pilotLiByUid.set(uid, { li, minusBtn });
    }

    // --- Select incidents
    if (select) {
      const opt = document.createElement("option");
      opt.value = uid;
      opt.textContent = name;
      select.appendChild(opt);
    }
  }

  // Met à jour l’état initial (si on revient sur la page)
  updatePilotListSelections();
}

// 🔹 Affiche le bouton “-” et applique un style si le pilote est sélectionné
function updatePilotListSelections() {
  pilotLiByUid.forEach(({ li, minusBtn }, uid) => {
    const isSelected = selectedUIDs.has(uid);
    li.style.opacity = isSelected ? "0.8" : "1";
    li.style.fontWeight = isSelected ? "600" : "400";
    if (minusBtn) minusBtn.style.display = isSelected ? "inline-block" : "none";
  });
}

/* ---------------- Incidents (points de licence) ---------------- */
document.getElementById("addIncidentPilot")?.addEventListener("click", async () => {
  const select = document.getElementById("incidentPilotSelect");
  const uid = select?.value;
  if (!uid) return;

  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return;

  const d = snap.data();
  const name = `${d.firstName || ""} ${d.lastName || ""}`.trim() || uid;
  const before = d.licensePoints ?? 10;
  const after = before - 1;

  selectedPilots.push({ uid, name, before, after });
  updateIncidentList();
});

function updateIncidentList() {
  const list = document.getElementById("incidentList");
  if (!list) return;
  list.innerHTML = "";
  selectedPilots.forEach((p, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <strong>${p.name}</strong> — Avant : ${p.before} →
      <input type="number" value="${p.after}" data-i="${i}" style="width:100px;text-align:center;font-size:1.1em;padding:4px;" /> pts
      <button type="button" class="remove" data-i="${i}" title="Retirer">✖</button>
    `;
    list.appendChild(li);
  });

  list.querySelectorAll("input").forEach(inp => {
    inp.addEventListener("input", (e) => {
      const idx = parseInt(e.target.dataset.i, 10);
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val)) selectedPilots[idx].after = val;
    });
  });

  list.querySelectorAll(".remove").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.i, 10);
      selectedPilots.splice(idx, 1);
      updateIncidentList();
    });
  });
}

document.getElementById("submitIncident")?.addEventListener("click", async () => {
  const description = document.getElementById("incidentDescription")?.value.trim();
  const raceId = document.getElementById("incidentRaceSelect")?.value || null;

  if (!description || selectedPilots.length === 0) {
    alert("Description et au moins un pilote requis.");
    return;
  }

  const payload = {
    date: new Date(),
    description,
    courseId: raceId || null,
    pilotes: selectedPilots.map(p => ({ uid: p.uid, before: p.before, after: p.after }))
  };

  await addDoc(collection(db, "incidents"), payload);

  for (const p of selectedPilots) {
    await updateDoc(doc(db, "users", p.uid), { licensePoints: p.after });
  }

  selectedPilots = [];
  updateIncidentList();
  document.getElementById("incidentDescription").value = "";
  alert("Incident enregistré.");
  await loadIncidentHistory();
});

/* ---------------- Courses (liste + suppression) ---------------- */
async function loadCourses() {
  const courseList = document.getElementById("courseList");
  const raceSelect = document.getElementById("incidentRaceSelect");
  if (courseList) courseList.innerHTML = "";
  if (raceSelect) raceSelect.innerHTML = "";

  const snap = await getDocs(collection(db, "courses"));
  const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  docs.sort((a, b) => {
    const da = a.date?.seconds ? new Date(a.date.seconds * 1000) : new Date(a.date || 0);
    const db = b.date?.seconds ? new Date(b.date.seconds * 1000) : new Date(b.date || 0);
    return db - da;
  });

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

  if (courseList) {
    if (docs.length === 0) {
      courseList.innerHTML = "<p>Aucune course.</p>";
      return;
    }
    courseList.innerHTML = "";
    docs.forEach((course) => {
      const dateTxt = (course.date?.seconds ? new Date(course.date.seconds * 1000) : new Date(course.date || Date.now())).toLocaleDateString("fr-FR");
      const box = document.createElement("div");
      box.className = "course-box";
      box.innerHTML = `
        <h4>${dateTxt} - ${course.name || "Course"}</h4>
        <ul>${(course.participants || []).map((p) => `<li>${p.name || p.uid} — ${p.position}ᵉ</li>`).join("")}</ul>
        <button class="delete-course" data-id="${course.id}">🗑️ Supprimer cette course</button>
      `;
      courseList.appendChild(box);
    });

    document.querySelectorAll(".delete-course").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const courseId = btn.dataset.id;
        if (!confirm("Confirmer la suppression de cette course ?")) return;

        // 1) Effacer la course globale
        await deleteDoc(doc(db, "courses", courseId));

        // 2) Nettoyer l'historique de tous les pilotes pour cette course
        const usersSnap = await getDocs(collection(db, "users"));
        for (const user of usersSnap.docs) {
          const userId = user.id;
          const ref = doc(db, "users", userId, "raceHistory", courseId);
          const snap = await getDoc(ref);
          if (snap.exists()) {
            await deleteDoc(ref);
          }
        }

        // 3) Recalcul global cohérent (rejoue toutes les courses restantes)
        await recalculateAllEloFromCourses();

        // 4) Refresh UI
        await loadCourses();
        await loadIncidentHistory();
        alert("Course supprimée et ELO recalculés.");
      });
    });
  }
}

/* ---------------- Recalcul GLOBAL des ELO ---------------- */
async function recalculateAllEloFromCourses() {
  const coursesSnap = await getDocs(collection(db, "courses"));
  const courses = coursesSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const da = a.date?.seconds ? new Date(a.date.seconds * 1000) : new Date(a.date || 0);
      const db = b.date?.seconds ? new Date(b.date.seconds * 1000) : new Date(b.date || 0);
      return da - db; // plus anciennes -> plus récentes
    });

  const usersSnap = await getDocs(collection(db, "users"));
  const elo = new Map();
  usersSnap.forEach(u => elo.set(u.id, (u.data().eloRating ?? 1000)));

  // Réinitialiser à 1000 pour le recalcul
  usersSnap.forEach(u => elo.set(u.id, 1000));

  for (const c of courses) {
    const parts = (c.participants || [])
      .filter(p => p && p.uid)
      .map(p => ({ uid: p.uid, position: p.position ?? 9999, name: p.name }));

    if (parts.length < 2) continue;

    const ratingsMap = {};
    parts.forEach(p => { ratingsMap[p.uid] = elo.get(p.uid) ?? 1000; });

    const newRatings = computeEloUpdates(parts, ratingsMap, 32);
    parts.forEach(p => elo.set(p.uid, newRatings[p.uid]));
  }

  for (const [uid, r] of elo.entries()) {
    await updateDoc(doc(db, "users", uid), { eloRating: Math.round(r) });
  }
}

/* ---------------- Historique incidents ---------------- */
async function loadIncidentHistory() {
  const container = document.getElementById("incidentHistory");
  if (!container) return;
  container.innerHTML = "<p>Chargement…</p>";

  const snap = await getDocs(collection(db, "incidents"));
  if (snap.empty) { container.innerHTML = "<p>Aucun incident enregistré.</p>"; return; }

  const usersSnap = await getDocs(collection(db, "users"));
  const userMap = new Map();
  usersSnap.forEach(u => userMap.set(u.id, u.data()));

  container.innerHTML = "";
  for (const docu of snap.docs) {
    const d = docu.data();
    const courseName = d.courseId ? (courseMap.get(d.courseId)?.name || d.courseId) : "-";
    const pilotListHtml = await Promise.all(
      (d.pilotes || []).map(async (p) => {
        const u = userMap.get(p.uid);
        if (u) {
          const fullName = `${u.firstName || ""} ${u.lastName || ""}`.trim();
          return `<li>${fullName} : ${p.before} → ${p.after}</li>`;
        } else {
          return `<li>${p.uid} : ${p.before} → ${p.after}</li>`;
        }
      })
    );

    const div = document.createElement("div");
    div.className = "incident-entry";
    const when = d.date?.seconds ? new Date(d.date.seconds * 1000) : new Date(d.date || Date.now());
    div.innerHTML = `
      <p><strong>${when.toLocaleString()}</strong> - ${d.description || ""}</p>
      <p>Course : ${courseName || "-"}</p>
      <ul>${pilotListHtml.join("")}</ul>
      <button onclick="deleteIncident('${docu.id}')">🗑️ Supprimer</button>
    `;
    container.appendChild(div);
  }
}

window.deleteIncident = async function (id) {
  const ref = doc(db, "incidents", id);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const data = snap.data();
    if (data.pilotes) {
      for (const p of data.pilotes) {
        const userRef = doc(db, "users", p.uid);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
          const u = userSnap.data();
          const fixed = (u.licensePoints ?? 10) + (p.before - p.after);
          await updateDoc(userRef, { licensePoints: fixed });
        }
      }
    }
    await deleteDoc(ref);
    await loadIncidentHistory();
  }
};

/* ---------------- Réclamations (ESTACUP) ---------------- */
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function renderStatusOption(val, current, label) {
  return `<option value="${val}" ${current===val?"selected":""}>${label}</option>`;
}

async function loadReclamations() {
  const box = document.getElementById("reclamationsBox");
  if (!box) return;
  box.innerHTML = "<p>Chargement…</p>";

  const snap = await getDocs(collection(db, "reclamations"));
  if (snap.empty) { box.innerHTML = "<p>Aucune réclamation.</p>"; return; }

  box.innerHTML = "";
  for (const docu of snap.docs) {
    const r = { id: docu.id, ...docu.data() };
    const status = r.status || "pending";
    const note = r.adminNote || "";

    const div = document.createElement("div");
    div.className = "course-box";
    div.innerHTML = `
      <p><strong>${new Date(r.date || Date.now()).toLocaleString()}</strong> — <em>${status}</em></p>
      <p><strong>Course :</strong> ${escapeHtml(r.courseText || "-")}</p>
      <p><strong>Pilote(s) :</strong> ${escapeHtml(r.pilotsText || "-")}</p>
      <p><strong>Moment :</strong> ${escapeHtml(r.momentText || "-")}</p>
      <p>${escapeHtml(r.description || "")}</p>

      <div style="display:grid;grid-template-columns:1fr;gap:8px;margin-top:12px">
        <label>Statut :
          <select class="reclam-status" data-id="${r.id}">
            ${renderStatusOption("pending", status, "En cours")}
            ${renderStatusOption("in_review", status, "À l’étude")}
            ${renderStatusOption("accepted", status, "Acceptée")}
            ${renderStatusOption("rejected", status, "Rejetée")}
          </select>
        </label>
        <label>Note admin :
          <textarea class="reclam-note" data-id="${r.id}" rows="3" placeholder="Ajouter une note (optionnel)">${escapeHtml(note)}</textarea>
        </label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="reclam-save" data-id="${r.id}">💾 Enregistrer</button>
          <button class="reclam-del" data-id="${r.id}">🗑️ Supprimer</button>
        </div>
      </div>
    `;
    box.appendChild(div);
  }

  box.querySelectorAll(".reclam-save").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const statusSel = box.querySelector(`.reclam-status[data-id="${id}"]`);
      const noteTa = box.querySelector(`.reclam-note[data-id="${id}"]`);
      const payload = {
        status: statusSel?.value || "pending",
        adminNote: noteTa?.value || "",
        updatedAt: new Date()
      };
      await updateDoc(doc(db, "reclamations", id), payload);
      alert("Réclamation mise à jour.");
      await loadReclamations();
    });
  });
  box.querySelectorAll(".reclam-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (!confirm("Supprimer cette réclamation ?")) return;
      await deleteDoc(doc(db, "reclamations", id));
      await loadReclamations();
    });
  });
}

/* ---------------- ESTACUP (admin) ---------------- */
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

  // Map user infos (facultatif : pour afficher le nom complet si présent)
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

  // Tri (optionnel) : par numéro de course puis nom
  const byRaceThenName = (a, b) => {
    const na = Number(a.d.raceNumber ?? 9999);
    const nb = Number(b.d.raceNumber ?? 9999);
    if (na !== nb) return na - nb;
    const la = `${a.d.lastName || ""}`.toLowerCase();
    const lb = `${b.d.lastName || ""}`.toLowerCase();
    return la.localeCompare(lb);
  };
  pending.sort(byRaceThenName);
  validated.sort(byRaceThenName);

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

  // Listeners (sur le conteneur parent pour couvrir les deux sections)
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
        liveryColors: null, // par défaut
        updatedAt: new Date()
      };

      // Couleurs si semi-perso
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



/* ---------------- Gestion Pilotes (édition admin) ---------------- */
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
    selectPilot(current); // recharge les valeurs d’origine du pilote
    alert("Formulaire réinitialisé.");
  });

  refresh?.addEventListener("click", fetchPilots);
  search?.addEventListener("input", renderPilotList);

  fetchPilots();
}
