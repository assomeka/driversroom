// dashboard.js — Driver's Room : navigation + Résultats + ESTACUP + Stats + DOB + LicenseClass
// + Sous-menu ESTACUP (Inscription / Engagés / Réclamation) + Questionnaire MEKA

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

/* =========================
   Firebase
========================= */
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

/* =========================
   Utils
========================= */
const $ = (id) => document.getElementById(id);

function toDate(value) {
  if (!value) return null;
  if (value?.seconds && typeof value.seconds === "number") return new Date(value.seconds * 1000);
  if (typeof value?.toDate === "function") { try { return value.toDate(); } catch {} }
  const d = new Date(value);
  return isNaN(d) ? null : d;
}
function formatDateFR(value) {
  const d = toDate(value);
  return d ? d.toLocaleDateString("fr-FR") : "";
}
function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
}
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[c];
  });
}

/* =========================
   Navigation onglets (haut)
========================= */
function setupNavigation(isAdmin = false) {
  const goToAdmin = $("goToAdmin");
  if (isAdmin && goToAdmin) goToAdmin.classList.remove("hidden");
  goToAdmin?.addEventListener("click", () => (window.location.href = "admin.html"));

  const buttons = document.querySelectorAll('.menu button[data-section]');
  const sections = document.querySelectorAll('.section');

  function showSection(key) {
    sections.forEach(s => s.classList.add("hidden"));
    const el = $(`section-${key}`);
    if (el) el.classList.remove("hidden");

    // Rechargements à l’ouverture
    if (key === "results" && currentUid) loadResults(currentUid);
    if (key === "estacup" && lastUserData) {
      setupEstacupSubnav();
      showEstacupSub("inscription"); // défaut
      setupMekaQuestionnaire(lastUserData);
      loadEstacupEngages();
      loadReclamHistory();
    }
  }

  buttons.forEach(btn => btn.addEventListener("click", () => showSection(btn.getAttribute("data-section"))));
  showSection("infos"); // défaut
}

/* =========================
   Sous-menu ESTACUP
========================= */
function setupEstacupSubnav() {
  const subnav = $("estacupSubnav");
  if (!subnav) return;

  const subs = document.querySelectorAll("#estacupSubnav .estc-sub-btn");
  subs.forEach(btn => {
    btn.onclick = () => showEstacupSub(btn.dataset.sub);
  });
}

function showEstacupSub(key) {
  const blocks = {
    inscription: $("estacup-sub-inscription"),
    engages: $("estacup-sub-engages"),
    reclam: $("estacup-sub-reclam")
  };
  Object.values(blocks).forEach(b => b && b.classList.add("hidden"));
  if (blocks[key]) blocks[key].classList.remove("hidden");
}

/* =========================
   État global
========================= */
let currentUid = null;
let lastUserData = null;

/* =========================
   Auth + bootstrap
========================= */
function styleLogoutButton() {
  const btn = $("logout");
  if (!btn) return;
  btn.style.setProperty("background-color", "#e53935", "important");
  btn.style.setProperty("color", "#ffffff", "important");
  btn.style.setProperty("border-color", "#e53935", "important");
}
$("logout")?.addEventListener("click", () => {
  signOut(auth).then(() => (window.location.href = "login.html"));
});
styleLogoutButton();

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "login.html"; return; }

  // Récup profil (fallback authMap -> pilotUid si besoin)
  let userSnap = await getDoc(doc(db, "users", user.uid));
  if (!userSnap.exists()) {
    const map = await getDoc(doc(db, "authMap", user.uid));
    if (map.exists()) userSnap = await getDoc(doc(db, "users", map.data().pilotUid));
  }
  if (!userSnap.exists()) { alert("Profil introuvable."); return; }

  const data = userSnap.data();
  currentUid = userSnap.id;
  lastUserData = data;

  // Header infos
  $("fullName") && ( $("fullName").textContent = `${data.firstName ?? ""} ${data.lastName ?? ""}`.trim() || "—" );
  $("licenseId") && ( $("licenseId").textContent = data.licenceId || data.licenseId || "-" );
  $("eloRating") && ( $("eloRating").textContent = data.eloRating ?? 1000 );
  $("licensePoints") && ( $("licensePoints").textContent = data.licensePoints ?? 10 );

  // ✅ Classe de licence (défaut Rookie)
  if ($("licenseClass")) $("licenseClass").textContent = data.licenseClass || "Rookie";

  // Date de naissance
  const dobValue = firstDefined(data.dob, data.birthDate, data.birthday, data.dateNaissance, data.naissance);
  $("dob") && ( $("dob").textContent = formatDateFR(dobValue) || "Non renseignée" );

  setupNavigation(data.admin === true);

  // Pré-chargements utiles
  await loadResults(currentUid);
  await loadPilotStats(currentUid);
});

/* =========================
   Résultats (historique courses)
========================= */
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
      const dbb = toDate(b.date) ?? new Date(b.date || 0);
      return dbb - da;
    });

    // Nombre de participants par course (pour affichage pos/total)
    const targetIds = new Set(rows.map(r => r.id));
    const countMap = {};
    const usersSnap = await getDocs(collection(db, "users"));
    for (const u of usersSnap.docs) {
      const rhSnap = await getDocs(collection(db, "users", u.id, "raceHistory"));
      rhSnap.forEach(rh => {
        const raceId = rh.id;
        if (targetIds.has(raceId)) countMap[raceId] = (countMap[raceId] || 0) + 1;
      });
    }

    ul.innerHTML = "";
    for (const r of rows) {
      const d = formatDateFR(r.date) || r.date || "";
      const total = countMap[r.id] || 1;
      const pos = (r.position ?? "?");
      const li = document.createElement("li");
      li.textContent = `${d} – ${r.name || "Course"} : ${pos}/${total}`;
      ul.appendChild(li);
    }
  } catch (e) {
    console.error(e);
    ul.innerHTML = `<li>Erreur de chargement des résultats.</li>`;
  }
}

/* =========================
   Stats Pilote
========================= */
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
    const best = positions.length ? Math.min(...positions) : null;
    const wins = positions.filter(p => p === 1).length;
    const top3 = positions.filter(p => p <= 3).length;
    const top5 = positions.filter(p => p <= 5).length;
    const top10 = positions.filter(p => p <= 10).length;
    const avg = positions.length ? (positions.reduce((a,b)=>a+b,0) / positions.length) : null;

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

/* =========================
   ESTACUP — Questionnaire MEKA
========================= */
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

/* =========================
   ESTACUP (formulaire / engagés)
========================= */
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
      <option value="Livrée perso" ${existing?.liveryChoice==="Livrée perso"?"selected":""}>Livrée perso</option>
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

/* =========================
   Réclamations (saisie manuelle dans ESTACUP)
========================= */
$("submitReclam")?.addEventListener("click", async () => {
  const courseText = $("reclamCourse")?.value.trim() || "";
  const pilotsText = $("reclamPilotsText")?.value.trim() || "";
  const momentText = $("reclamMoment")?.value.trim() || "";
  const desc = $("reclamDesc")?.value.trim() || "";

  if (!courseText || !pilotsText || !momentText || !desc) {
    alert("Veuillez renseigner tous les champs (course, pilotes, moment, description).");
    return;
  }

  await addDoc(collection(db, "reclamations"), {
    uid: currentUid,
    courseText,
    pilotsText,
    momentText,
    description: desc,
    date: new Date().toISOString(),
    status: "pending"
  });

  alert("Réclamation envoyée !");
  $("reclamCourse").value = "";
  $("reclamPilotsText").value = "";
  $("reclamMoment").value = "";
  $("reclamDesc").value = "";
  loadReclamHistory();
});

// Historique des réclamations du pilote connecté
async function loadReclamHistory() {
  const box = $("reclamHistory");
  if (!box) return;
  box.innerHTML = "<h4>Vos réclamations :</h4>";

  const snap = await getDocs(collection(db, "reclamations"));
  const mine = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(r => r.uid === currentUid)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (mine.length === 0) {
    box.innerHTML += "<p>Aucune réclamation pour l’instant.</p>";
    return;
  }

  for (const r of mine) {
    const div = document.createElement("div");
    div.className = "incident-entry";
    div.innerHTML = `
      <p><strong>${new Date(r.date).toLocaleString()}</strong> — <em>${escapeHtml(r.status === "pending" ? "En cours" : r.status)}</em></p>
      <p><strong>Course :</strong> ${escapeHtml(r.courseText)}</p>
      <p><strong>Pilote(s) :</strong> ${escapeHtml(r.pilotsText)}</p>
      <p><strong>Moment :</strong> ${escapeHtml(r.momentText)}</p>
      <p>${escapeHtml(r.description)}</p>
    `;
    box.appendChild(div);
  }
}
