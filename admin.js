// ✅ admin.js — complet
// - "Driver's Room" (vert) dans la barre du haut
// - "Déconnexion" en rouge (fond plein)
// - Création de pilote retirée
// - Onglet "Résultats" affiché par défaut
// - Incidents: liste simple par pilote avec boutons − / +

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

let ranking = [];
let selectedPilots = []; // { uid, name, before, after }
let courseMap = new Map();

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

  ensureDriversRoomButton();     // bouton vert
  ensureRedLogoutButton();       // bouton rouge fond plein
  removePilotCreationSection();  // pas d'ajout de pilote

  setupNavigation();             // "Résultats" par défaut
  loadPilots();
  loadCourses();
  loadIncidentHistory();
  loadEstacupSignups();
});

/* ---------------- Navigation ---------------- */
function setupNavigation() {
  const buttons = document.querySelectorAll(".admin-menu button");
  const sections = document.querySelectorAll(".admin-section");

  function showSection(key) {
    sections.forEach((s) => s.classList.add("hidden"));
    const el = document.getElementById(`section-${key}`);
    if (el) el.classList.remove("hidden");
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

/* ---------------- Boutons barre haute ---------------- */
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
  // Supprime toute ancienne version (ex: bas de page)
  document.querySelectorAll("#logout")?.forEach(el => el.remove());

  const menu = document.querySelector(".admin-menu");
  if (!menu) return;

  const btn = document.createElement("button");
  btn.id = "logout";
  btn.type = "button";
  btn.textContent = "Déconnexion";

  // Rouge fond plein + texte blanc
  btn.style.setProperty("background-color", "#e53935", "important");
  btn.style.setProperty("color", "#ffffff", "important");
  btn.style.setProperty("border-color", "#e53935", "important");

  btn.addEventListener("click", () => {
    signOut(auth).then(() => (window.location.href = "login.html"));
  });

  menu.appendChild(btn);
}

/* ---------------- Retirer la création de pilote ---------------- */
function removePilotCreationSection() {
  const pilotsSection = document.getElementById("section-pilots");
  if (pilotsSection) pilotsSection.remove();
  const pilotsBtn = document.querySelector('.admin-menu button[data-section="pilots"]');
  if (pilotsBtn) pilotsBtn.remove();
  document.getElementById("newPilotForm")?.remove();
}

/* ---------------- Pilotes (lecture / sélection) ---------------- */
async function loadPilots() {
  const pilotList = document.getElementById("pilotList");
  const select = document.getElementById("incidentPilotSelect");
  const snap = await getDocs(collection(db, "users"));

  if (pilotList) pilotList.innerHTML = "";
  if (select) select.innerHTML = "";

  snap.forEach((docu) => {
    const pilot = docu.data();
    if (pilotList) {
      const li = document.createElement("li");
      li.textContent = `${pilot.firstName || ""} ${pilot.lastName || ""}`.trim();
      li.classList.add("clickable");
      li.dataset.uid = docu.id;
      li.addEventListener("click", () => addToRanking(docu.id, pilot));
      pilotList.appendChild(li);
    }
    if (select) {
      const opt = document.createElement("option");
      opt.value = docu.id;
      opt.textContent = `${pilot.firstName || ""} ${pilot.lastName || ""}`.trim();
      select.appendChild(opt);
    }
  });
}

function addToRanking(uid, pilot) {
  if (ranking.find((p) => p.uid === uid)) return;
  ranking.push({ uid, name: `${pilot.firstName || ""} ${pilot.lastName || ""}`.trim() });
  renderRanking();
}

function renderRanking() {
  const ol = document.getElementById("rankingList");
  if (!ol) return;
  ol.innerHTML = "";
  ranking.forEach((p, idx) => {
    const li = document.createElement("li");
    li.textContent = `${idx + 1}. ${p.name}`;
    ol.appendChild(li);
  });
}

/* ---------------- Résultats & ELO ---------------- */
document.getElementById("submitResults")?.addEventListener("click", async () => {
  const raceName = document.getElementById("raceName")?.value.trim();
  const raceDateInput = document.getElementById("raceDate");
  const raceDate = raceDateInput?.valueAsDate || new Date();
  if (!raceName || ranking.length === 0) {
    alert("Nom de course et classement requis.");
    return;
  }

  const raceId = Date.now().toString();

  const allData = {};
  for (const p of ranking) {
    const snap = await getDoc(doc(db, "users", p.uid));
    if (snap.exists()) allData[p.uid] = snap.data();
  }

  const newEloMap = calculateDynamicElo(ranking, allData);

  for (let i = 0; i < ranking.length; i++) {
    const uid = ranking[i].uid;
    const position = i + 1;
    await setDoc(doc(db, "users", uid, "raceHistory", raceId), {
      name: raceName,
      date: raceDate,
      position
    });
    const ref = doc(db, "users", uid);
    const prev = allData[uid] || {};
    await setDoc(ref, { ...prev, eloRating: newEloMap[uid] });
  }

  alert("Résultats enregistrés !");
  ranking = [];
  renderRanking();
  loadCourses();
});

function calculateDynamicElo(rankingArr, allData, K = 32) {
  const result = {};
  for (let i = 0; i < rankingArr.length; i++) {
    const player = rankingArr[i];
    const playerElo = Number(allData[player.uid]?.eloRating ?? 1000);
    let totalChange = 0;
    for (let j = 0; j < rankingArr.length; j++) {
      if (i === j) continue;
      const opponent = rankingArr[j];
      const opponentElo = Number(allData[opponent.uid]?.eloRating ?? 1000);
      const expected = 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
      const actual = i < j ? 1 : 0; // gagne si mieux classé
      totalChange += K * (actual - expected);
    }
    const averageChange = totalChange / (rankingArr.length - 1);
    result[player.uid] = Math.round(playerElo + averageChange);
  }
  return result;
}

/* ---------------- Incidents (UI simple − / +) ---------------- */
document.getElementById("addIncidentPilot")?.addEventListener("click", async () => {
  const select = document.getElementById("incidentPilotSelect");
  const uid = select?.value;
  const name = select?.options[select.selectedIndex]?.textContent || "";
  if (!uid) return;
  if (selectedPilots.find((p) => p.uid === uid)) return;

  const snap = await getDoc(doc(db, "users", uid));
  const data = snap.data() || {};
  selectedPilots.push({ uid, name, before: data.licensePoints ?? 10, after: data.licensePoints ?? 10 });
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
  const raceId = document.getElementById("incidentRaceSelect")?.value;
  if (!description || selectedPilots.length === 0 || !raceId) {
    alert("Veuillez compléter tous les champs.");
    return;
  }

  const admin = auth.currentUser;
  const date = new Date().toISOString();

  // Applique les valeurs "après"
  for (const pilot of selectedPilots) {
    await updateDoc(doc(db, "users", pilot.uid), { licensePoints: pilot.after });
  }

  await addDoc(collection(db, "incidents"), {
    description,
    date,
    course: raceId,
    pilotes: selectedPilots.map((p) => ({ uid: p.uid, before: p.before, after: p.after })),
    adminUid: admin.uid
  });

  alert("Incident enregistré.");
  selectedPilots = [];
  updateIncidentList();
  const desc = document.getElementById("incidentDescription");
  if (desc) desc.value = "";
  loadIncidentHistory();
});

/* ---------------- Courses ---------------- */
async function loadCourses() {
  const usersSnap = await getDocs(collection(db, "users"));
  courseMap.clear();

  for (const user of usersSnap.docs) {
    const userId = user.id;
    const userData = user.data();
    const historySnap = await getDocs(collection(db, "users", userId, "raceHistory"));
    historySnap.forEach((docu) => {
      const d = docu.data();
      if (!courseMap.has(docu.id)) {
        courseMap.set(docu.id, {
          id: docu.id,
          name: d.name,
          date: d.date,
          participants: []
        });
      }
      courseMap.get(docu.id).participants.push({
        name: `${userData.firstName || ""} ${userData.lastName || ""}`.trim(),
        uid: userId,
        position: d.position
      });
    });
  }

  const courseList = document.getElementById("courseList");
  if (courseList) {
    courseList.innerHTML = "";
    courseMap.forEach((course) => {
      const box = document.createElement("div");
      box.className = "course-box";
      const dateTxt = course.date?.seconds
        ? new Date(course.date.seconds * 1000).toLocaleDateString("fr-FR")
        : (course.date || "");
      box.innerHTML = `
        <h4>${dateTxt} - ${course.name || "Course"}</h4>
        <ul>${course.participants.map((p) => `<li>${p.name} — ${p.position}ᵉ</li>`).join("")}</ul>
        <button class="delete-course" data-id="${course.id}">🗑️ Supprimer cette course</button>
      `;
      courseList.appendChild(box);
    });

    document.querySelectorAll(".delete-course").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const courseId = btn.dataset.id;
        if (!confirm("Confirmer la suppression de cette course ?")) return;

        const affectedUids = new Set();
        for (const user of usersSnap.docs) {
          const userId = user.id;
          const ref = doc(db, "users", userId, "raceHistory", courseId);
          const snap = await getDoc(ref);
          if (snap.exists()) {
            await deleteDoc(ref);
            affectedUids.add(userId);
          }
        }
        for (const uid of affectedUids) {
          await recalculateElo(uid);
        }
        loadCourses();
      });
    });
  }

  const select = document.getElementById("incidentRaceSelect");
  if (select) {
    select.innerHTML = "";
    courseMap.forEach((course) => {
      const opt = document.createElement("option");
      const dateTxt = course.date?.seconds
        ? new Date(course.date.seconds * 1000).toLocaleDateString("fr-FR")
        : (course.date || "");
      opt.value = course.id;
      opt.textContent = `${dateTxt} - ${course.name || "Course"}`;
      select.appendChild(opt);
    });
  }
}

async function recalculateElo(uid) {
  const ref = collection(db, "users", uid, "raceHistory");
  const snap = await getDocs(ref);
  let elo = 1000;
  const races = [];
  snap.forEach((docu) => races.push(docu.data()));
  races.sort((a, b) => (new Date(a.date) - new Date(b.date)));
  races.forEach((r) => {
    elo += (10 - (Number(r.position) || 10)) * 5;
  });
  const userRef = doc(db, "users", uid);
  const userSnap = await getDoc(userRef);
  if (userSnap.exists()) {
    await setDoc(userRef, { ...userSnap.data(), eloRating: elo });
  }
}

/* ---------------- Historique incidents ---------------- */
async function loadIncidentHistory() {
  const container = document.getElementById("incidentHistory");
  if (!container) return;
  container.innerHTML = "<h4>Historique des incidents :</h4>";
  const snap = await getDocs(collection(db, "incidents"));

  for (const docu of snap.docs) {
    const d = docu.data();

    // Cherche le nom de la course à partir de l'ID
    let courseName = d.course;
    let found = false;
    const usersSnap = await getDocs(collection(db, "users"));
    for (const user of usersSnap.docs) {
      const historySnap = await getDocs(collection(db, "users", user.id, "raceHistory"));
      for (const raceDoc of historySnap.docs) {
        if (raceDoc.id === d.course) {
          courseName = raceDoc.data().name || d.course;
          found = true;
          break;
        }
      }
      if (found) break;
    }

    // Liste des pilotes avec noms
    const pilotListHtml = await Promise.all(
      (d.pilotes || []).map(async (p) => {
        const userSnap = await getDoc(doc(db, "users", p.uid));
        if (userSnap.exists()) {
          const u = userSnap.data();
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
          const current = userSnap.data().licensePoints ?? 10;
          const recalculated = current + (p.before - p.after);
          await updateDoc(userRef, { licensePoints: recalculated });
        }
      }
    }
  }
  await deleteDoc(ref);
  loadIncidentHistory();
};

/* ---------------- Inscriptions ESTACUP ---------------- */
async function loadEstacupSignups() {
  const container = document.getElementById("estacupList");
  if (!container) return;
  container.innerHTML = "<p>Chargement...</p>";

  const snap = await getDocs(collection(db, "estacup_signups"));
  if (snap.empty) {
    container.innerHTML = "<p>Aucune inscription pour l’instant.</p>";
    return;
  }

  container.innerHTML = "";
  snap.forEach((docu) => {
    const d = docu.data();
    const div = document.createElement("div");
    div.className = "course-box";
    div.innerHTML = `
      <div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));align-items:center">
        <input class="edit-first" value="${d.firstName || ""}" placeholder="Prénom" />
        <input class="edit-last"  value="${d.lastName || ""}"  placeholder="Nom" />
        <input class="edit-age"   type="number" value="${d.age || ""}"    placeholder="Âge" />
        <input class="edit-email" value="${d.email || ""}"  placeholder="Email" />
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
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="validate-signup" data-id="${docu.id}" ${d.validated ? "disabled" : ""}>✅ Valider</button>
        <button class="save-signup" data-id="${docu.id}">💾 Enregistrer</button>
        <button class="delete-signup" data-id="${docu.id}">🗑️ Supprimer</button>
      </div>
    `;
    container.appendChild(div);
  });

  // Affichage conditionnel couleurs
  document.querySelectorAll(".edit-livery").forEach((select) => {
    select.addEventListener("change", () => {
      const colors = select.parentElement.querySelector(".colors");
      colors.style.display = select.value === "Livrée semi-perso" ? "block" : "none";
    });
  });

  // Validation
  document.querySelectorAll(".validate-signup").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      await updateDoc(doc(db, "estacup_signups", id), { validated: true });
      alert("Inscription validée !");
      loadEstacupSignups();
    });
  });

  // Sauvegarde
  document.querySelectorAll(".save-signup").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const box = btn.parentElement.parentElement;
      const id = btn.dataset.id;
      const rawNum = box.querySelector(".edit-number")?.value ?? "";
      const parsedNum = rawNum === "" ? null : parseInt(rawNum, 10);

      const data = {
        firstName: box.querySelector(".edit-first").value.trim(),
        lastName: box.querySelector(".edit-last").value.trim(),
        age: parseInt(box.querySelector(".edit-age").value, 10) || null,
        email: box.querySelector(".edit-email").value.trim(),
        teamName: box.querySelector(".edit-team").value.trim() || " ",
        carChoice: box.querySelector(".edit-car").value.trim(),
        liveryChoice: box.querySelector(".edit-livery").value,
        raceNumber: parsedNum
      };
      if (data.liveryChoice === "Livrée semi-perso") {
        data.liveryColors = {
          color1: box.querySelector(".edit-color1").value,
          color2: box.querySelector(".edit-color2").value,
          color3: box.querySelector(".edit-color3").value
        };
      } else {
        data.liveryColors = null;
      }

      if (data.raceNumber !== null && (data.raceNumber < 1 || data.raceNumber > 999)) {
        alert("Le numéro de course doit être entre 1 et 999.");
        return;
      }

      await updateDoc(doc(db, "estacup_signups", id), data);
      alert("Inscription mise à jour.");
      loadEstacupSignups();
    });
  });

  // Suppression
  document.querySelectorAll(".delete-signup").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (confirm("Supprimer cette inscription ?")) {
        await deleteDoc(doc(db, "estacup_signups", id));
        loadEstacupSignups();
      }
    });
  });
}
